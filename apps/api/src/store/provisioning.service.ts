import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DeploymentStatus,
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  LimitsStatus,
  OrderStatus,
  Prisma,
  ProvisioningStepStatus,
  ProvisionAction,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { MailSettingsService } from '../mail/mail-settings.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { DeploymentsService, mapCoolifyStatus } from '../deployments/deployments.service';
import { HttpAvailabilityService } from '../common/http-availability.service';
import { resolveEffectiveLimits } from '../deployments/limits.util';
import { clientAreaUrl } from './web-links';
import {
  PanelKind,
  PanelTarget,
  PanelTransportFactory,
  PanelTransport,
} from '../servers/panel-transport.factory';
import { resolveBuildPackPortContract } from '../servers/runtime-port-contract';
import { isHostingC3Enabled } from '../hosting/c3-flag';
import { isHostingC4Enabled } from '../hosting/c4-flag';
import { C3CapabilityService } from '../hosting/c3-capability.service';
import { C4CapabilityService } from '../hosting/c4-capability.service';
import { C4ProtocolService } from '../hosting/c4-protocol.service';
import { HostingServicesService } from '../hosting/hosting-services.service';
import { ReservationPayload, storeIdempotencyKey } from '../hosting/hosting-fingerprint';
import { isAbsentExternalError } from './order-cancel.service';

/**
 * 17B.4F-C3 — garde d'écriture du parcours C3 : TOUTE écriture métier d'une
 * commande trackéee passe par cette fonction, qui ouvre sa propre transaction,
 * verrouille Order → OrderProvisioningTracking, vérifie le `claimToken` du
 * worker PUIS le lease (deux contrôles SÉPARÉS), exécute l'écriture et commit.
 * Le parcours legacy n'utilise jamais ce type : `directWrite` exécute
 * l'écriture directement sur le client (auto-commit, contrat inchangé).
 */
export type StoreWriteGuard = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;

/**
 * 17B.4F-C4 — contexte de tentatives provider d'une run C3 : identité du
 * worker (`holder` = claimToken) + allocation/portée couvertes par le
 * protocole. Présent UNIQUEMENT sous `HOSTING_C4_ENABLED === 'true'`.
 */
export interface C4RunCtx {
  holder: string;
  allocationId: string;
  orderId: string;
  serviceId: string;
}

/**
 * Refus d'écriture du garde C3 (worker obsolète / lease non renouvelable).
 * ConflictException : HTTP 409 explicite, JAMAIS avalé par le best-effort
 * legacy (seul ce sous-type est re-propagé par `linkClientSubdomainToDeployment`).
 */
export class C3WorkerGuardError extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}

/** Lease du claim C3 — renouvelé à CHAQUE écriture gardée (CAS token+expiré). */
export const C3_LEASE_MS = 5 * 60_000;

/**
 * Résultat d'une tentative d'activation atomique post-preuve (17B.3B).
 * ActivationResult EST LA SOURCE DE VÉRITÉ de l'état post-transaction : chaque
 * champ reflète les états RÉELLEMENT obtenus dans la transaction (jamais des
 * lectures pré-transaction). `orderIsActive`/`deploymentIsActive` portent
 * l'état final ; `orderActivated`/`deploymentActivated` la transition gagnée ;
 * `noop` + `reason` documentent les no-op explicites (interdits, absents,
 * déjà-actifs).
 */
export interface ActivationResult {
  /** État final de l'Order : true si réellement ACTIVE (pré-existant ou gagné ici). */
  orderIsActive: boolean;
  /** État final de la row Deployment : true si réellement ACTIVE. */
  deploymentIsActive: boolean;
  /** true uniquement si la transition Order PROVISIONING→ACTIVE a été GAGNÉE ici. */
  orderActivated: boolean;
  /** true uniquement si la transition Deployment DEPLOYING→ACTIVE a été GAGNÉE ici. */
  deploymentActivated: boolean;
  /** true si AUCUNE écriture ni transition n'a eu lieu (CAS4 déjà-actif, CAS5/6/7). */
  noop: boolean;
  /** Motif d'un no-op explicite (path safe, aucun secret). */
  reason?: string;
}

/**
 * 17B.3C - delai canonique avant la PREMIERE verification asynchrone du futur
 * reconciliateur (17B.4+), mesure depuis l expiration normale du proof-gate
 * synchrone (120 s). Reutilise par la planification initiale et, plus tard,
 * par le worker/backoff. Aucun worker n est cree ni demarre ici.
 */
export const INITIAL_RECONCILE_DELAY_MS = 30_000;

/**
 * Bloc D — provision réel d'une commande store.
 *
 * Déclenché juste après `checkout.service` (même requête) ou via un appel
 * admin « relancer ». Exécute dans l'ordre les ProvisionAction du
 * ProvisionMethod lié au produit (CREATE_APP → CONFIGURE_DNS → GENERATE_SSL
 * → ENABLE_BACKUP), trace chaque étape dans ProvisioningLog, bascule
 * l'Order PAID → PROVISIONING → ACTIVE, et envoie l'email de livraison du
 * sous-domaine gratuit. Le hostname Coolify n'est JAMAIS communiqué au client.
 *
 * Best-effort par étape : un échec met la step en FAILED mais ne coupe pas
 * les suivantes ; le statut final dépend du succès des steps critiques.
 */

@Injectable()
export class ProvisioningService {
  private readonly log = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly mail: MailSettingsService,
    private readonly cloudflare: CloudflareService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly deployments: DeploymentsService,
    private readonly httpAvailability: HttpAvailabilityService,
    private readonly hosting: HostingServicesService,
    private readonly c3: C3CapabilityService,
    private readonly c4: C4ProtocolService,
    private readonly c4c: C4CapabilityService,
  ) {}

  /** Écriture directe legacy (auto-commit) — le contrat historique inchangé. */
  private readonly directWrite: StoreWriteGuard = (fn) =>
    fn(this.prisma as unknown as Prisma.TransactionClient);

  /**
   * Provisionne une commande payée. Idempotent : si l'Order est déjà
   * PROVISIONING/ACTIVE, on renvoie l'état sans refaire le travail
   * (sauf `force=true` côté admin).
   */
  async provisionOrder(orderId: string, opts?: { force?: boolean }): Promise<{
    orderId: string;
    status: string;
    fqdn: string | null;
    steps: { step: string; status: string; message: string | null }[];
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        product: {
          include: {
            provisionModule: true,
            pack: { include: { deploymentModule: { include: { server: true } } } },
          },
        },
        customer: true,
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');

    // 17B.4E-D-B1 — un Order CANCELLED/REFUNDED n'est JAMAIS re-provisionné,
    // même en force (sinon un cancel partiel serait réversible par un retry).
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
      throw new ConflictException(
        `Commande ${order.status} — provisioning impossible (utiliser cancel-provisioning pour le nettoyage).`,
      );
    }

    // ── 17B.4F-C3 — routage C3 (AVANT l'idempotent-return et avant force) ────
    if (!isHostingC3Enabled()) {
      // OFF : le tracking est résolu par sonde LIVE de la table dédiée (jamais
      // depuis un cache négatif). Une commande C3 ne bascule JAMAIS en legacy
      // quand la garde est OFF : refus explicite, aucun appel provider.
      const tracked = await this.c3.resolveTracking(orderId);
      if (tracked) {
        throw new ConflictException(
          'Commande du parcours C3 — provisioning suspendu tant que C3 est désactivé (aucun repli legacy).',
        );
      }
      // Pas de table / pas de ligne → parcours legacy historique inchangé.
    } else {
      // ON : capability C1+C3 vérifiée LIVE avant toute écriture métier.
      // Indisponible (migration non appliquée) → 503 fail-closed.
      if (!(await this.c3.operational())) {
        throw new ServiceUnavailableException(
          'Provisioning C3 activé mais schéma indisponible (migration C1/C3 requise).',
        );
      }
      // 17B.4F-C4 : sous garde C4, prérequis des 5 tables + contraintes
      // vérifiés LIVE avant toute mutation (no-op sous OFF).
      await this.c4c.assertOperational();
      const tracked = await this.c3.resolveTracking(orderId);
      if (tracked) {
        return this.provisionC3(order, tracked as { intent: unknown }, opts);
      }
      // Absence de tracking = ancien achat (ou produit sans pack) → legacy
      // sécurisé (capability prouvée), comportement historique inchangé.
    }

    if (
      !opts?.force &&
      (order.status === OrderStatus.PROVISIONING || order.status === OrderStatus.ACTIVE)
    ) {
      const logs = await this.prisma.provisioningLog.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      return {
        orderId,
        status: order.status,
        fqdn: order.domainValue ?? null,
        steps: logs.map((l) => ({ step: l.step, status: l.status, message: l.message })),
      };
    }

    const method = order.product.provisionModule;
    const actions: ProvisionAction[] = (method?.actions as ProvisionAction[]) ?? [];

    // Aucune méthode configurée → rien à provisionner : on passe ACTIVE direct.
    if (!method || actions.length === 0) {
      await this.setOrderStatus(orderId, OrderStatus.ACTIVE, 'Aucune action de provisioning configurée.');
      return { orderId, status: OrderStatus.ACTIVE, fqdn: order.domainValue ?? null, steps: [] };
    }

    await this.setOrderStatus(orderId, OrderStatus.PROVISIONING, `Provisioning lancé (${method.name}).`);

    let fqdn: string | null = order.domainValue ?? null;
    let appUuid: string | null = null;

    for (const action of actions) {
      const stepName = this.stepName(action);
      const logId = await this.openStep(orderId, stepName);
      try {
        const out = await this.runAction(action, {
          order,
          method,
          fqdn,
          appUuid,
        });
        if (out.fqdn) fqdn = out.fqdn;
        if (out.appUuid) appUuid = out.appUuid;
        await this.closeStep(logId, ProvisioningStepStatus.SUCCESS, out.message ?? null);
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: orderId,
          details: { step: stepName, status: 'SUCCESS', fqdn, message: out.message ?? undefined },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`provision ${stepName} order=${orderId}: ${msg}`);
        await this.closeStep(logId, ProvisioningStepStatus.FAILED, msg);
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: orderId,
          details: { step: stepName, status: 'FAILED', message: msg },
        });
        // Les steps non critiques n'interrompent pas la suite ; on continue.
        // Si CREATE_APP échoue, les steps suivants resteront FAILED/SKIPPED
        // mais l'Order passera quand même en ACTIVE si un fqdn existe déjà
        // (ex. DNS déjà alloué), sinon on laisse PROVISIONING pour retry admin.
      }
    }

    // Persiste le fqdn livré sur l'Order (jamais le hostname Coolify).
    if (fqdn && fqdn !== order.domainValue) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { domainType: 'FREE_SUBDOMAIN', domainValue: fqdn, domainStatus: 'READY' },
      });
    }

    // Règle PRODUCTION (2026-09-15) — « ne jamais confirmer tant que ce n'est pas réellement OK ».
    // Le statut ACTIVE (et l'email de livraison « en ligne ») ne peut être accordé que sur
    // PREUVE réelle : une app Coolify créée pour CETTE commande (coolifyUuid) ET un build
    // Coolify ACTIVE/servi (ou un HTTP 2xx/3xx sur le sous-domaine).
    const logs = await this.prisma.provisioningLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    const createAppLog = logs.find((l) => l.step === 'create_app');
    const createFailed = createAppLog?.status === ProvisioningStepStatus.FAILED;
    const hasCreateAction = actions.includes(ProvisionAction.CREATE_APP);
    // L'app a été réellement créée si actionCreateApp a retourné un appUuid (l'uuid
    // Coolify est threadé sur l'ensemble des steps). Robustesse : pas de re-query.
    const appCreated = !!appUuid;

    // 1) Produit censé créer une app mais AUCUNE app créée (create_app FAILED ou ignoré) →
    //    JAMAIS ACTIVE. L'Order reste PROVISIONING pour relance admin. Aucun email.
    //    (Avant : `hasFailedCreateApp && !fqdn ? PROVISIONING : ACTIVE` faisait passer ACTIVE
    //    dès qu'un fqdn DNS existait même si la création d'app avait échoué — le « faux
    //    succès » qui confirmait une commande sans app ni build.)
    if (hasCreateAction && !appCreated) {
      const reason = createFailed
        ? 'La création de l’application a échoué — relance requise.'
        : 'Aucune application créée (prérequis serveur/repo manquants ?) — relance requise.';
      await this.setOrderStatus(orderId, OrderStatus.PROVISIONING, reason);
      await this.audit.record({
        action: 'provision.app_not_created',
        resourceType: 'order',
        resourceId: orderId,
        details: { fqdn, ok: false, reason },
      });
      return this.finalResult(orderId, OrderStatus.PROVISIONING, fqdn);
    }

    // 2) App créée → on vérifie la mise en ligne RÉELLE avant de confirmer/emmailler.
    if (hasCreateAction && appCreated) {
      const serverId = (order.product.pack?.deploymentModule?.server as { id?: string } | null | undefined)?.id ?? null;
      const ready = await this.awaitAppReady({ coolifyUuid: appUuid!, serverId }, fqdn);
      if (ready) {
        // 17B.3B — activation ATOMIQUE Order + Deployment (+ OrderStatusHistory)
        // via la couture publique idempotente, puis email de livraison APRÈS
        // commit, uniquement si l'Order vient réellement d'être activé. L'état
        // final rapporté est dérivé UNIQUEMENT d'ActivationResult (source de
        // vérité post-transaction) : ACTIVE ssi l'Order est réellement ACTIVE.
        const act = await this.activateOrderAfterProof(orderId);
        const outcome = act.orderIsActive ? OrderStatus.ACTIVE : OrderStatus.PROVISIONING;
        return this.finalResult(orderId, outcome, fqdn);
      }
      // Build encore en cours (légitime, plusieurs minutes) : PROVISIONING, SANS email
      // « en ligne ». Le dashboard client re-sonde et reflète le vrai état (DEPLOYING).
      // Une relance admin (endpoint provision, idempotent) finalise à la mise en ligne.
      await this.setOrderStatus(
        orderId,
        OrderStatus.PROVISIONING,
        'Build en cours — confirmation différée jusqu’à la mise en ligne effective.',
      );
      // 17B.3C - planification PERSISTEE initiale de la reconciliation (idempotente,
      // atomique en base) : premiere echeance posee sur le Deployment DEPLOYING de
      // la commande, sans worker ni increment de compteur. Une echeance deja
      // presente n est jamais ecrasee ni repoussee (condition reconcileNextAt=null).
      await this.scheduleInitialReconcile(orderId);
      return this.finalResult(orderId, OrderStatus.PROVISIONING, fqdn);
    }

    // 3) Produit SANS CREATE_APP (ex. DNS/SSL seuls) : comportement historique, mais
    //    jamais ACTIVE si une step critique a échoué et qu'aucun fqdn n'est livré.
    const hasFailedCritical = logs.some((l) => l.status === ProvisioningStepStatus.FAILED);
    const simpleNext = hasFailedCritical && !fqdn ? OrderStatus.PROVISIONING : OrderStatus.ACTIVE;
    await this.setOrderStatus(
      orderId,
      simpleNext,
      simpleNext === OrderStatus.ACTIVE ? 'Provisioning terminé.' : 'Provisioning partiel — relance requise.',
    );
    if (fqdn && simpleNext === OrderStatus.ACTIVE) {
      await this.deliverEmail(order.customerEmail, order.customerName, fqdn, orderId);
    }
    return this.finalResult(orderId, simpleNext, fqdn);
  }

  // ── 17B.4F-C3 — orchestration du provisioning des commandes trackéees ─────

  /**
   * Garde d'écriture C3 : ouvre SA transaction, verrouille Order →
   * OrderProvisioningTracking (ordre global), vérifie l'IDENTITÉ du worker
   * (`claimToken`) puis, SÉPARÉMENT, le lease (expiration → renouvellement
   * CAS `token + expiré` ; `count ≠ 1` → refus). Une écriture n'est jamais
   * exécutée si l'un des deux contrôles échoue ; l'expiration seule n'autorise
   * JAMAIS une autre ressource à écrire (aucun takeover après intention).
   */
  private c3Guard(orderId: string, token: string): StoreWriteGuard {
    return async <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
      return this.prisma.$transaction(async (tx) => {
        const orders = await tx.$queryRaw<Array<{ id: string; status: OrderStatus }>>`
          SELECT "id", "status" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        if (!orders[0]) {
          throw new C3WorkerGuardError('Commande introuvable (worker obsolète).');
        }
        // 17B.4F-C4 — garde anti-résurrection : sous garde, un Order terminal
        // (CANCELLED/REFUNDED) ne reçoit AUCUNE écriture métier du worker
        // (après l'arrêt, seule la consignation des tentatives — hors garde —
        // reste autorisée).
        if (
          orders[0].status === OrderStatus.CANCELLED ||
          orders[0].status === OrderStatus.REFUNDED
        ) {
          throw new C3WorkerGuardError('Commande annulée — écriture worker refusée.');
        }
        const trs = await tx.$queryRaw<Array<{ claimToken: string | null; leaseUntil: Date | null }>>`
          SELECT "claimToken", "leaseUntil" FROM "OrderProvisioningTracking"
          WHERE "orderId" = ${orderId} FOR UPDATE`;
        const tracking = trs[0];
        // Contrôle 1 — IDENTITÉ (token du claim) : tout autre worker est refusé.
        if (!tracking || tracking.claimToken !== token) {
          throw new C3WorkerGuardError('Worker obsolète — écriture refusée.');
        }
        // Contrôle 2 — LEASE (séparé) : expiré → renouvellement CAS ; un refus
        // ici n'est jamais contourné (pas de « juste cette écriture »).
        if (tracking.leaseUntil && tracking.leaseUntil.getTime() <= Date.now()) {
          const renewed = await tx.orderProvisioningTracking.updateMany({
            where: { orderId, claimToken: token, leaseUntil: { lte: new Date() } },
            data: { leaseUntil: new Date(Date.now() + C3_LEASE_MS) },
          });
          if (renewed.count !== 1) {
            throw new C3WorkerGuardError('Lease non renouvelable — worker obsolète.');
          }
        }
        return fn(tx);
      });
    };
  }

  /**
   * B0 du parcours C3 — validations LOCALES (aucun réseau) exigées AVANT
   * l'intention provider. `null` = conforme ; sinon motif d'abandon
   * (compensation pré-provider, Order reste PAID, aucun appel provider).
   */
  private c3B0Failure(order: {
    product: {
      provisionModule: { actions: unknown } | null;
      moduleParams?: unknown;
      pack?: { deploymentModule?: { server?: { panelProvider?: string; apiBaseUrl?: string | null; apiTokenEnc?: string | null } | null } | null } | null;
    };
  }): string | null {
    const method = order.product.provisionModule;
    const actions = (method?.actions as ProvisionAction[] | null | undefined) ?? [];
    if (!method || actions.length === 0) {
      return 'Aucune action de provisioning configurée.';
    }
    if (!actions.includes(ProvisionAction.CREATE_APP)) {
      return 'Produit sans CREATE_APP — non provisionnable en C3.';
    }
    const params = (order.product.moduleParams ?? {}) as Record<string, unknown>;
    if (typeof params.repoUrl !== 'string' || !params.repoUrl.trim()) {
      return 'Produit sans repoUrl — création Coolify impossible.';
    }
    const server = order.product.pack?.deploymentModule?.server;
    if (!server || server.panelProvider !== 'COOLIFY' || !server.apiBaseUrl || !server.apiTokenEnc) {
      return 'Aucun serveur Coolify configuré pour ce produit.';
    }
    return null;
  }

  /**
   * 17B.4F-C3 — provisioning d'une commande trackéee (`OrderProvisioningTracking`).
   *
   * TX-A (locale, ZÉRO réseau) : ① verrou Order → ② verrou Tracking → ③
   * relecture autoritaire (allocation `store:v1:<orderId>`, Deployment) → ④a
   * décisions sur états existants AVANT toute écriture de token (terminal /
   * bound / uncertain / releasing / busy / noop → restitués en lecture seule
   * ou 409, JAMAIS de takeover) → ④b/⑤ claim (token+lease) → ⑥ réservation
   * → ⑦ B0 (échec ⇒ libération + annotation + commit, Order reste PAID) →
   * ⑧ Order→PROVISIONING → ⑨ intention DERNIÈRE → COMMIT.
   * Puis : TX-C (row Deployment, statut PENDING, avant le 1ᵉʳ appel provider),
   * boucle d'actions (chaque écriture sous garde token/lease ; un échec STOPPE
   * la suite — aucun appel provider après un résultat incertain), TX-E
   * `markBound`, preuve (lecture seule), TX-B activation (token + CAS sur le
   * MÊME tx). `force` n'accélère rien : l'état décide, jamais le takeover.
   */
  private async provisionC3(
    order: {
      id: string;
      status: OrderStatus;
      domainValue: string | null;
      customerEmail: string;
      customerName: string;
      productId: string;
      product: {
        name: string;
        moduleParams?: unknown;
        provisionModule: { name: string; actions: unknown } | null;
        pack?: {
          id?: string;
          ramMb?: number;
          cpuCores?: number;
          storageLimit?: number | null;
          deploymentModule?: {
            id?: string;
            kind?: string;
            overrideRamMb: number | null;
            overrideCpuCores: number | null;
            overrideStorageLimit: number | null;
            server?: {
              id?: string;
              panelProvider?: string;
              apiBaseUrl?: string | null;
              apiTokenEnc?: string | null;
            } | null;
          } | null;
        } | null;
      };
      customer: { userId: string | null } | null;
    },
    tracked: { intent: unknown },
    _opts?: { force?: boolean },
  ): Promise<{
    orderId: string;
    status: string;
    fqdn: string | null;
    steps: { step: string; status: string; message: string | null }[];
  }> {
    // Service hébergement né au checkout (invariant C3) — lu avant la TX-A
    // (échec = état incohérent, aucun appel provider).
    const service = await this.prisma.hostingService.findUnique({
      where: { orderId: order.id },
    });
    if (!service) {
      throw new ConflictException(
        'Service hébergement absent pour cette commande C3 (état incohérent) — support requis.',
      );
    }

    const claim = await this.prisma.$transaction(async (tx) => {
      // ① verrou de LIGNE Order (ordre global : Order → Tracking →
      //    HostingService → HostingServiceAllocation → Deployment).
      const orders = await tx.$queryRaw<
        Array<{ id: string; status: OrderStatus; domainValue: string | null }>
      >`
        SELECT "id", "status", "domainValue" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      if (!orders[0]) throw new NotFoundException('Commande introuvable.');
      const liveStatus = orders[0].status;
      const liveFqdn = orders[0].domainValue;
      if (liveStatus === OrderStatus.CANCELLED || liveStatus === OrderStatus.REFUNDED) {
        throw new ConflictException(
          `Commande ${liveStatus} — provisioning impossible (utiliser cancel-provisioning pour le nettoyage).`,
        );
      }

      // ② verrou de LIGNE Tracking — fail-closed : table/ligne disparue sous
      //    ON = aucune écriture, aucun repli.
      const trs = await tx.$queryRaw<
        Array<{ intent: unknown; claimToken: string | null; leaseUntil: Date | null }>
      >`
        SELECT "intent", "claimToken", "leaseUntil" FROM "OrderProvisioningTracking"
        WHERE "orderId" = ${order.id} FOR UPDATE`;
      const tracking = trs[0];
      if (!tracking) {
        throw new ServiceUnavailableException(
          'Tracking C3 absent sous garde ON — provisioning refusé (fail-closed).',
        );
      }

      // ③ relecture autoritaire sous verrou : allocation + Deployment.
      const key = storeIdempotencyKey(order.id);
      const alloc = await tx.hostingServiceAllocation.findUnique({
        where: { idempotencyKey: key },
      });

      // ④a décisions sur états existants — AVANT toute écriture de token/lease.
      if (alloc) {
        if (alloc.status === HostingServiceAllocationStatus.RELEASED) {
          // Terminal (ex. compensation B0 committée) : état réel, 0 appel, 0 écriture.
          return { kind: 'terminal' as const, status: liveStatus, fqdn: liveFqdn };
        }
        if (alloc.providerIntentAt) {
          if (alloc.status === HostingServiceAllocationStatus.BOUND && alloc.deploymentId) {
            // Fenêtre « bind committé + activation échouée » : ÉTAT RÉEL en lecture
            // seule (jamais ACTIVE forcé, 0 appel provider, 0 écriture) — la
            // finalisation appartient au support/C4 (T-fen.1).
            return { kind: 'bound' as const, status: liveStatus, fqdn: liveFqdn };
          }
          // Intention engagée sans résultat connu : AUCUN takeover, jamais.
          return { kind: 'uncertain' as const };
        }
        if (alloc.status === HostingServiceAllocationStatus.RELEASING) {
          return { kind: 'releasing' as const };
        }
        // RESERVED/BOUND sans intention : reprise UNIQUEMENT si lease libre
        // (reprise pré-intention — le seul cas où le token peut changer).
      } else if (liveStatus === OrderStatus.ACTIVE) {
        // Commande C3 ACTIVE sans allocation : état réel, 0 appel, 0 écriture.
        return { kind: 'noop' as const, status: liveStatus, fqdn: liveFqdn };
      }

      // Lease encore valide → worker en cours : jamais de double claim,
      // jamais de takeover (même avant intention, même lease expirée plus bas
      // seule la reprise pré-intention est permise).
      if (tracking.claimToken && tracking.leaseUntil && tracking.leaseUntil.getTime() > Date.now()) {
        return { kind: 'busy' as const };
      }

      // ④b claim (frais ou reprise pré-intention à lease expiré) → ⑤ token/lease.
      const token = randomUUID();
      await tx.orderProvisioningTracking.update({
        where: { orderId: order.id },
        data: { claimToken: token, leaseUntil: new Date(Date.now() + C3_LEASE_MS) },
      });

      // ⑥ réservation C1 (création SEULE — une allocation existante est classée ④a).
      let allocationId: string;
      if (alloc) {
        allocationId = alloc.id;
      } else {
        const reserved = await this.hosting.reserveForOrderInTx(tx, {
          orderId: order.id,
          hostingServiceId: service.id,
          actorUserId: service.userId,
          payload: tracking.intent as unknown as ReservationPayload,
        });
        allocationId = reserved.allocation.id;
      }

      // ⑦ B0 — échec ⇒ libération pré-provider + annotation + COMMIT
      //    (Order reste PAID ; aucune intention n'a été posée).
      const b0Failure = this.c3B0Failure(order);
      if (b0Failure) {
        await this.hosting.releasePreProviderInTx(tx, {
          allocationId,
          actorUserId: service.userId,
        });
        await tx.orderProvisioningTracking.update({
          where: { orderId: order.id },
          data: { claimToken: null, leaseUntil: null },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            status: liveStatus,
            note: `Provisioning C3 abandonné (B0) : ${b0Failure}`,
          },
        });
        return { kind: 'b0' as const, reason: b0Failure, status: liveStatus, fqdn: liveFqdn };
      }

      // ⑧ Order → PROVISIONING (la commande payée entre dans le parcours).
      if (liveStatus !== OrderStatus.PROVISIONING && liveStatus !== OrderStatus.ACTIVE) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.PROVISIONING },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            status: OrderStatus.PROVISIONING,
            note: `Provisioning C3 lancé (${order.product.provisionModule?.name ?? 'module'}).`,
          },
        });
      }

      // ⑨ intention provider — DERNIÈRE étape avant commit (aucune écriture
      //    réseau n'a eu lieu ; échec ⇒ rollback COMplet, retry possible).
      const intentRes = await this.hosting.markIntentInTx(tx, {
        allocationId,
        actorUserId: service.userId,
      });
      if (!intentRes.applied) {
        throw new ConflictException(
          `Intention provider non applicable (${intentRes.reason}) : réservation conservée, aucune reprise automatique.`,
        );
      }
      return { kind: 'claimed' as const, token, allocationId };
    });

    // ── Décisions non-gagnées : lecture seule ou refus explicite (0 provider) ─
    if (claim.kind !== 'claimed') {
      switch (claim.kind) {
        case 'uncertain':
          throw new ConflictException(
            'Intention provider déjà engagée — aucune reprise automatique (support requis).',
          );
        case 'releasing':
          throw new ConflictException(
            'Libération en cours sur cette commande — reprise refusée (support requis).',
          );
        case 'busy':
          throw new ConflictException('Provisioning C3 déjà en cours sur cette commande.');
        case 'terminal':
        case 'bound':
        case 'noop':
        case 'b0':
          // État réel restitué en LECTURE SEULE : 0 appel provider, 0 écriture.
          return this.finalResult(order.id, claim.status, claim.fqdn);
        default:
          throw new ConflictException('État de provisioning C3 non reconnu — support requis.');
      }
    }

    const guard = this.c3Guard(order.id, claim.token);

    // ── 17B.4F-C4 : contexte de tentatives + scopes d'arrêt de la run ──────
    const c4Enabled = isHostingC4Enabled();
    const c4Run: C4RunCtx | undefined = c4Enabled
      ? {
          holder: claim.token,
          allocationId: claim.allocationId,
          orderId: order.id,
          serviceId: service.id,
        }
      : undefined;
    const c4StopScopes = c4Enabled
      ? C4ProtocolService.scopesFor({ order: order.id, service: service.id, allocation: claim.allocationId })
      : [];

    // ── TX-C : row Deployment créée AVANT le 1ᵉʳ appel provider (statut
    //    PENDING, miroir du parcours C2) ; `actionCreateApp` la retrouve et y
    //    pose l'uuid + DEPLOYING après succès provider.
    await guard(async (tx) => {
      const existing = await tx.deployment.findUnique({
        where: { orderId: order.id },
        select: { id: true },
      });
      if (existing) return;
      const userId = order.customer?.userId ?? null;
      const server = order.product.pack?.deploymentModule?.server ?? null;
      if (!userId || !server?.id) return; // B0 a déjà validé (défense)
      const params = (order.product.moduleParams ?? {}) as Record<string, unknown>;
      const repoUrl = typeof params.repoUrl === 'string' ? params.repoUrl : null;
      if (!repoUrl) return; // B0 a déjà validé (défense)
      const branch =
        typeof params.branch === 'string' && params.branch.trim() ? String(params.branch).trim() : 'main';
      const buildPack = typeof params.buildPack === 'string' ? String(params.buildPack) : 'nixpacks';
      const publishDirectory =
        typeof params.publishDirectory === 'string' && params.publishDirectory.trim()
          ? String(params.publishDirectory).trim()
          : null;
      const appName =
        typeof params.appName === 'string' && params.appName.trim()
          ? String(params.appName).trim()
          : order.product.name;
      const mod = order.product.pack?.deploymentModule ?? null;
      const effStore = resolveEffectiveLimits(
        order.product.pack as
          | { ramMb: number; cpuCores: number; storageLimit: number | null; id?: string }
          | null
          | undefined,
        mod,
      );
      await tx.deployment.create({
        data: {
          userId,
          serverId: server.id,
          repoFullName: this.deriveRepoFullName(repoUrl) ?? appName,
          repoUrl,
          buildPack,
          appName,
          branch,
          publishDirectory,
          status: DeploymentStatus.PENDING,
          orderId: order.id,
          moduleId: (mod as { id?: string } | null)?.id ?? null,
          packId: (order.product.pack as { id?: string } | null)?.id ?? null,
          // Limites tracées, statut non tenté : `actionCreateApp` le passe à
          // APPLIED sur son update (après `applyAppLimits` réussi) quand il est null.
          limitsRamMb: effStore?.ramMb ?? null,
          limitsCpu: effStore?.cpuCores ?? null,
        },
      });
    });

    // ── Boucle d'actions : chaque ÉCRITURE passe par la garde (token/lease) ;
    //    un échec STOPPE la suite (aucun appel provider après un échec/incertitude).
    const method = order.product.provisionModule;
    if (!method) {
      // Inatteignable sous C3 (B0 exige une méthode + CREATE_APP avant claim).
      throw new ConflictException('Méthode de provisioning absente — support requis.');
    }
    const actions: ProvisionAction[] = (method.actions as ProvisionAction[] | null | undefined) ?? [];
    let fqdn: string | null = order.domainValue ?? null;
    let appUuid: string | null = null;
    let stepFailed = false;
    let c4Stopped = false;

    for (const action of actions) {
      const stepName = this.stepName(action);
      const logId = await this.openStep(order.id, stepName, guard);
      try {
        const out = await this.runAction(action, { order, method, fqdn, appUuid, guard, c4: c4Run });
        if (out.fqdn) fqdn = out.fqdn;
        if (out.appUuid) appUuid = out.appUuid;
        // 17B.4F-C4 — après un ARRÊT, consignation seule : aucune écriture
        // métier supplémentaire (la clôture d'étape est best-effort bookkeeping).
        c4Stopped = c4Enabled && (await this.c4.hasStop(c4StopScopes));
        if (c4Stopped) {
          try {
            await this.closeStep(logId, ProvisioningStepStatus.SUCCESS, out.message ?? null, guard);
          } catch {
            // commande déjà CANCELLED : la garde refuse — état laissé tel quel.
          }
          break;
        }
        await this.closeStep(logId, ProvisioningStepStatus.SUCCESS, out.message ?? null, guard);
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: order.id,
          details: { step: stepName, status: 'SUCCESS', fqdn, message: out.message ?? undefined },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`provision(C3) ${stepName} order=${order.id}: ${msg}`);
        c4Stopped = c4Enabled && (await this.c4.hasStop(c4StopScopes));
        try {
          await this.closeStep(logId, ProvisioningStepStatus.FAILED, msg, guard);
        } catch (e2) {
          if (!(e2 instanceof C3WorkerGuardError)) throw e2;
          c4Stopped = true;
        }
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: order.id,
          details: { step: stepName, status: 'FAILED', message: msg },
        });
        stepFailed = true;
        break;
      }
    }

    // 17B.4F-C4 — barrière post-boucle : un arrêt arrivé pendant la dernière
    // action gèle TOUTE écriture métier ultérieure (aucune transition, aucun
    // bind, aucune activation — seule la consignation a eu lieu dans l'action).
    if (!c4Stopped && c4Enabled) {
      c4Stopped = await this.c4.hasStop(c4StopScopes);
    }
    if (c4Stopped) {
      const fresh = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true, domainValue: true },
      });
      return this.finalResult(order.id, fresh?.status ?? order.status, fresh?.domainValue ?? fqdn);
    }

    // Persiste le fqdn livré sur l'Order (garde token/lease, jamais le hostname Coolify).
    if (fqdn && fqdn !== order.domainValue) {
      await guard((tx) =>
        tx.order.update({
          where: { id: order.id },
          data: { domainType: 'FREE_SUBDOMAIN', domainValue: fqdn, domainStatus: 'READY' },
        }),
      );
    }

    // ── TX-E : liaison allocation → déploiement sous garde (preuve locale =
    //    uuid Coolify persisté ; idempotent sur CETTE row, ownership croisé).
    if (appUuid) {
      await guard(async (tx) => {
        const dep = await tx.deployment.findUnique({
          where: { orderId: order.id },
          select: { id: true, coolifyUuid: true },
        });
        if (!dep?.coolifyUuid) return;
        await this.hosting.markBoundInTx(tx, {
          allocationId: claim.allocationId,
          actorUserId: service.userId,
          deploymentId: dep.id,
          proof: { providerProven: true },
        });
      });
    }

    const logs = await this.prisma.provisioningLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    const hasCreateAction = actions.includes(ProvisionAction.CREATE_APP);

    // Échec d'étape : Order reste PROVISIONING, AUCUNE reprise automatique.
    if (stepFailed) {
      const reason = 'Étape de provisioning échouée — aucune reprise automatique (support requis).';
      await this.setOrderStatus(order.id, OrderStatus.PROVISIONING, reason, guard);
      await this.audit.record({
        action: 'provision.app_not_created',
        resourceType: 'order',
        resourceId: order.id,
        details: { fqdn, ok: false, reason },
      });
      return this.finalResult(order.id, OrderStatus.PROVISIONING, fqdn);
    }

    // Même garde que le legacy : sans app créée, JAMAIS ACTIVE.
    if (hasCreateAction && !appUuid) {
      const reason = 'Aucune application créée — relance requise (support).';
      await this.setOrderStatus(order.id, OrderStatus.PROVISIONING, reason, guard);
      await this.audit.record({
        action: 'provision.app_not_created',
        resourceType: 'order',
        resourceId: order.id,
        details: { fqdn, ok: false, reason },
      });
      return this.finalResult(order.id, OrderStatus.PROVISIONING, fqdn);
    }

    if (hasCreateAction && appUuid) {
      // Preuve de mise en ligne (poll + HTTP : LECTURES seule, hors transaction).
      const serverId =
        (order.product.pack?.deploymentModule?.server as { id?: string } | null | undefined)?.id ??
        null;
      const ready = await this.awaitAppReady({ coolifyUuid: appUuid, serverId }, fqdn);
      if (ready) {
        // TX-B : activation DANS la transaction qui vient de vérifier le token
        // (garde token/lease + CAS Order/Deployment sur le MÊME tx). Le verrou
        // HostingService est pris AVANT les CAS Order/Deployment (ordre global
        // Order → Tracking → HostingService → Allocation → Deployment) ; le
        // service ne passe à ACTIVE qu'une fois les preuves FINALES obtenues
        // (Order + Deployment actifs) — jamais sur échec ni succès partiel,
        // jamais sur service annulé/hors parcours.
        const act = await guard(async (tx) => {
          const svcRows = await tx.$queryRaw<Array<{ id: string; status: HostingServiceStatus }>>`
            SELECT "id", "status" FROM "HostingService" WHERE "orderId" = ${order.id} FOR UPDATE`;
          const outcome = await this.activateOrderInTx(tx, order.id);
          const svc = svcRows[0];
          if (
            svc &&
            svc.status === HostingServiceStatus.PROVISIONING &&
            outcome.orderIsActive &&
            outcome.deploymentIsActive
          ) {
            const flip = await tx.hostingService.updateMany({
              where: { id: svc.id, status: HostingServiceStatus.PROVISIONING },
              data: { status: HostingServiceStatus.ACTIVE },
            });
            if (flip.count !== 1) {
              throw new Error(`activateOrderAfterProof lost race hostingService=${svc.id}`);
            }
          }
          return outcome;
        });
        const outcome = await this.postActivationEffects(order.id, act);
        const status = outcome.orderIsActive ? OrderStatus.ACTIVE : OrderStatus.PROVISIONING;
        return this.finalResult(order.id, status, fqdn);
      }
      await this.setOrderStatus(
        order.id,
        OrderStatus.PROVISIONING,
        'Build en cours — confirmation différée jusqu’à la mise en ligne effective.',
        guard,
      );
      await this.scheduleInitialReconcile(order.id, new Date(), guard);
      return this.finalResult(order.id, OrderStatus.PROVISIONING, fqdn);
    }

    // Défense (B0 impose CREATE_APP sous C3) — parité legacy.
    const hasFailedCritical = logs.some((l) => l.status === ProvisioningStepStatus.FAILED);
    const simpleNext =
      hasFailedCritical && !fqdn ? OrderStatus.PROVISIONING : OrderStatus.ACTIVE;
    await this.setOrderStatus(
      order.id,
      simpleNext,
      simpleNext === OrderStatus.ACTIVE ? 'Provisioning terminé.' : 'Provisioning partiel — relance requise.',
      guard,
    );
    if (fqdn && simpleNext === OrderStatus.ACTIVE) {
      await this.deliverEmail(order.customerEmail, order.customerName, fqdn, order.id);
    }
    return this.finalResult(order.id, simpleNext, fqdn);
  }

  /** Recharge les provisioning logs et renvoie le résultat final d'une run. */
  private async finalResult(
    orderId: string,
    status: OrderStatus,
    fqdn: string | null,
  ): Promise<{ orderId: string; status: string; fqdn: string | null; steps: { step: string; status: string; message: string | null }[] }> {
    const finalLogs = await this.prisma.provisioningLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      orderId,
      status,
      fqdn,
      steps: finalLogs.map((l) => ({ step: l.step, status: l.status, message: l.message })),
    };
  }

  /**
   * 17B.4E-D-B1 (fix H + D3/C1) — lie le ClientSubdomain de CETTE commande à son
   * Deployment. Jamais de `updateMany` par fqdn seul :
   *  • cible = row retournée par l'allocation (id exact) ou trouvée par fqdn
   *    unique, puis `update` par `id` uniquement ;
   *  • ownership : fqdn = Order.domainValue (si figé) + domainId ∈ {effective,
   *    requested, knownDomainId} + owner (Customer.userId ↔ Deployment.userId
   *    si les deux existent) ; CS déjà lié à un autre deployment → no-op ;
   *  • sans preuve de domaine/owner → no-op (log statique).
   * Best-effort : un échec ne casse jamais le provisioning (log statique D5).
   */
  private async linkClientSubdomainToDeployment(
    orderId: string,
    fqdn: string | null,
    knownDeploymentId?: string | null,
    knownDomainId?: string | null,
    knownCsId?: string | null,
    guard?: StoreWriteGuard,
  ): Promise<void> {
    try {
      if (!fqdn && !knownCsId) return;
      let deploymentId = knownDeploymentId ?? null;
      let deploymentUserId: string | null = null;
      if (!deploymentId && orderId) {
        const dep = await this.prisma.deployment.findUnique({
          where: { orderId },
          select: { id: true, userId: true },
        });
        deploymentId = dep?.id ?? null;
        deploymentUserId = dep?.userId ?? null;
      } else if (deploymentId) {
        const dep = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { id: true, userId: true },
        });
        deploymentUserId = dep?.userId ?? null;
      }
      if (!deploymentId) return;

      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          domainValue: true,
          effectiveDomainId: true,
          requestedDomainId: true,
          customer: { select: { userId: true } },
        },
      });
      if (!order) return;
      if (fqdn) {
        // fqdn déjà persisté sur l'Order doit correspondre ; si pas encore figé
        // (fenêtre CONFIGURE_DNS avant l'update domainValue), exiger knownDomainId.
        if (order.domainValue && order.domainValue !== fqdn) return;
        if (!order.domainValue && !knownDomainId) return;
      }

      // Owner : si Customer.userId et Deployment.userId existent, ils doivent concorder.
      const orderOwner = order.customer?.userId ?? null;
      if (orderOwner && deploymentUserId && orderOwner !== deploymentUserId) return;

      let cs: { id: string; domainId: string; deploymentId: string | null } | null;
      if (knownCsId) {
        cs = await this.prisma.clientSubdomain.findUnique({
          where: { id: knownCsId },
          select: { id: true, domainId: true, deploymentId: true },
        });
        if (cs && fqdn) {
          const full = await this.prisma.clientSubdomain.findUnique({
            where: { id: cs.id },
            select: { id: true, fqdn: true, domainId: true, deploymentId: true },
          });
          if (full && full.fqdn !== fqdn) return;
          cs = full
            ? { id: full.id, domainId: full.domainId, deploymentId: full.deploymentId }
            : null;
        }
      } else if (fqdn) {
        cs = await this.prisma.clientSubdomain.findFirst({
          where: { fqdn },
          select: { id: true, domainId: true, deploymentId: true },
        });
      } else {
        return;
      }
      if (!cs) return;
      if (cs.deploymentId === deploymentId) return;
      if (cs.deploymentId !== null) return;

      const domainIds = [
        knownDomainId,
        order.effectiveDomainId,
        order.requestedDomainId,
      ].filter((x): x is string => !!x);
      if (domainIds.length === 0) return;
      if (!domainIds.includes(cs.domainId)) return;

      await (guard ?? this.directWrite)((tx) =>
        tx.clientSubdomain.update({
          where: { id: cs.id },
          data: { deploymentId },
        }),
      );
    } catch (e) {
      // 17B.4F-C3 : le refus du garde token/lease n'est JAMAIS avalé par le
      // best-effort (le worker obsolète doit s'arrêter — le prochain openStep
      // gardé lèverait de toute façon, sans appel provider supplémentaire).
      if (e instanceof C3WorkerGuardError) throw e;
      // Best-effort : message STATIQUE — jamais String(e)/message/name (D5).
      this.log.warn('provision: liaison ClientSubdomain impossible');
    }
  }

  /** Email de livraison doté de la gestion d'échec commune (best-effort, audité). */
  private async deliverEmail(to: string, name: string, fqdn: string, orderId: string): Promise<void> {
    try {
      await this.sendDeliveryEmail(to, name, fqdn, orderId);
    } catch (e) {
      this.log.warn(`delivery email order=${orderId} failed: ${String(e)}`);
      // Audit best-effort : un échec d'audit ne doit jamais rejeter l'activation.
      try {
        await this.audit.record({
          action: 'provision.delivery_email',
          resourceType: 'order',
          resourceId: orderId,
          details: { ok: false, error: String(e) },
        });
      } catch (ae) {
        this.log.warn(`post-commit audit delivery_email order=${orderId} failed: ${String(ae)}`);
      }
    }
  }

  /**
   * PREUVE de mise en ligne avant confirmation : poll borné du statut Coolify de l'app
   * (jusqu'à ~2 min) + raid HTTP 2xx/3xx sur le sous-domaine (best-effort). Renvoie true
   * dès que l'app est servie (status ACTIVE OU HTTP OK). Renvoie false si échec ferme ou
   * timeout → l'Order reste PROVISIONING (jamais de faux ACTIVE).
   */
  private async awaitAppReady(
    dep: { coolifyUuid: string | null; serverId: string | null },
    fqdn: string | null,
  ): Promise<boolean> {
    if (!dep.coolifyUuid) return false;
    let server: { panelProvider?: string; apiBaseUrl?: string | null; apiTokenEnc?: string | null } | null = null;
    if (dep.serverId) {
      try {
        server = (await this.prisma.server.findUnique({ where: { id: dep.serverId } })) ?? null;
      } catch {
        server = null; // prisma.server indisponible → repli HTTP only
      }
    }
    const deadline = Date.now() + 120_000;
    // Aucun canal de preuve (ni statut Coolify ni HTTP) → pas ready, sans attendre.
    if (!server && !fqdn) return false;
    while (Date.now() < deadline) {
      // Preuve 1 : statut build Coolify.
      if (server && server.panelProvider === 'COOLIFY' && server.apiBaseUrl && server.apiTokenEnc) {
        try {
          const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
          const res = await this.panelFactory.create().deploymentStatus(target, dep.coolifyUuid);
          const mapped = mapCoolifyStatus(res.rawStatus);
          if (mapped === DeploymentStatus.ACTIVE) return true;
          if (mapped === DeploymentStatus.FAILED) return false; // échec ferme → relance admin
        } catch {
          // Coolify injoignable → on tente la preuve HTTP avant de relancer.
        }
      }
      // Preuve 2 : le sous-domaine répond (best-effort, service HTTP partagé 17B.3A).
      if (fqdn && (await this.httpAvailability.isServed(fqdn))) return true;
      await this.sleep(5000);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private stepName(a: ProvisionAction): string {
    switch (a) {
      case ProvisionAction.CREATE_APP:
        return 'create_app';
      case ProvisionAction.CONFIGURE_DNS:
        return 'configure_dns';
      case ProvisionAction.GENERATE_SSL:
        return 'generate_ssl';
      case ProvisionAction.ENABLE_BACKUP:
        return 'enable_backup';
      default:
        return String(a).toLowerCase();
    }
  }

  private async openStep(orderId: string, step: string, guard?: StoreWriteGuard): Promise<string> {
    const write = guard ?? this.directWrite;
    const row = await write((tx) =>
      tx.provisioningLog.create({
        data: { orderId, step, status: ProvisioningStepStatus.RUNNING },
      }),
    );
    return row.id;
  }

  private async closeStep(
    id: string,
    status: ProvisioningStepStatus,
    message: string | null,
    guard?: StoreWriteGuard,
  ): Promise<void> {
    const write = guard ?? this.directWrite;
    await write((tx) => tx.provisioningLog.update({ where: { id }, data: { status, message } }));
  }

  private async setOrderStatus(
    orderId: string,
    status: OrderStatus,
    note: string,
    guard?: StoreWriteGuard,
  ): Promise<void> {
    const write = guard ?? this.directWrite;
    // TX-A C3 : écrit DANS la transaction du claim (Order verrouillé) — hors
    // TX-A : legacy auto-commit inchangé.
    await write(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status } });
      await tx.orderStatusHistory.create({ data: { orderId, status, note } });
    });
  }

  /**
   * 17B.3B — couture publique d'activation ATOMIQUE post-preuve de mise en
   * ligne, réutilisée par le proof-gate (provisionOrder) et, plus tard, par le
   * réconciliateur (17B.4+). Dans UNE transaction interactive :
   *   • Order PROVISIONING→ACTIVE et Deployment DEPLOYING→ACTIVE, UNIQUEMENT
   *     les transitions nécessaires (lectures faites DANS la transaction) ;
   *     une transition nécessaire qui rend count≠1 (course perdue face à un
   *     concurrent) déclenche une erreur interne contrôlée → rollback complet ;
   *   • OrderStatusHistory ACTIVE créée UNIQUEMENT si l'Order vient d'être
   *     réellement activé dans cette transaction (jamais de doublon).
   * Gardes (no-op explicites, AUCUNE écriture) : Order absent (`order_absent`) ;
   * Order ≠ PROVISIONING/ACTIVE (`order_status_*`) ; Deployment ABSENT
   * (`deployment_missing` — l'Order n'est JAMAIS activé seul) ; Deployment
   * FAILED/PENDING (`deployment_status_*`, jamais FAILED→ACTIVE) ; Order ET
   * Deployment déjà ACTIVE (`already_active`, no-op idempotent).
   * Après commit : audit `provision.deployment_active` et email de livraison
   * BEST-EFFORT (catch + Logger.warn sans donnée sensible), un échec audit ou
   * email ne rejette JAMAIS la couture et ne fausse jamais le résultat — le
   * retour reflète les états RÉELLEMENT obtenus dans la base validée.
   */
  async activateOrderAfterProof(orderId: string): Promise<ActivationResult> {
    let outcome: ActivationResult;
    try {
      outcome = await this.prisma.$transaction((tx) => this.activateOrderInTx(tx, orderId));
    } catch (e) {
      this.log.warn(`activateOrderAfterProof order=${orderId} rollback: ${String(e)}`);
      throw e;
    }
    return this.postActivationEffects(orderId, outcome);
  }

  /**
   * Corps ATOMIQUE d'activation (17B.3B) exécuté dans le `tx` FOURNI — sans
   * `$transaction` imbriquée. Réutilisé par `activateOrderAfterProof`
   * (transaction dédiée, comportement inchangé) et par le parcours C3 (TX-B :
   * activation DANS la transaction qui vient de vérifier le `claimToken` du
   * worker, garde token + CAS sur le MÊME tx).
   */
  private async activateOrderInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<ActivationResult> {
    const ord = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!ord) {
      return { orderIsActive: false, deploymentIsActive: false, orderActivated: false, deploymentActivated: false, noop: true, reason: 'order_absent' };
    }
    if (ord.status !== OrderStatus.PROVISIONING && ord.status !== OrderStatus.ACTIVE) {
      return { orderIsActive: false, deploymentIsActive: false, orderActivated: false, deploymentActivated: false, noop: true, reason: `order_status_${ord.status}` };
    }
    const dep = await tx.deployment.findFirst({ where: { orderId }, select: { status: true } });
    if (!dep) {
      return { orderIsActive: false, deploymentIsActive: false, orderActivated: false, deploymentActivated: false, noop: true, reason: 'deployment_missing' };
    }
    if (dep.status !== DeploymentStatus.DEPLOYING && dep.status !== DeploymentStatus.ACTIVE) {
      return { orderIsActive: false, deploymentIsActive: false, orderActivated: false, deploymentActivated: false, noop: true, reason: `deployment_status_${dep.status}` };
    }

    const orderUpdateNeeded = ord.status === OrderStatus.PROVISIONING;
    const deploymentUpdateNeeded = dep.status === DeploymentStatus.DEPLOYING;
    if (!orderUpdateNeeded && !deploymentUpdateNeeded) {
      return { orderIsActive: true, deploymentIsActive: true, orderActivated: false, deploymentActivated: false, noop: true, reason: 'already_active' };
    }

    const orderRes = orderUpdateNeeded
      ? await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PROVISIONING },
          data: { status: OrderStatus.ACTIVE },
        })
      : { count: 0 as const };
    if (orderUpdateNeeded && orderRes.count !== 1) {
      throw new Error(`activateOrderAfterProof lost race order=${orderId}`);
    }
    const depRes = deploymentUpdateNeeded
      ? await tx.deployment.updateMany({
          where: { orderId, status: DeploymentStatus.DEPLOYING },
          data: { status: DeploymentStatus.ACTIVE },
        })
      : { count: 0 as const };
    if (deploymentUpdateNeeded && depRes.count !== 1) {
      throw new Error(`activateOrderAfterProof lost race deployment=${orderId}`);
    }

    const orderActivated = orderUpdateNeeded && orderRes.count === 1;
    const deploymentActivated = deploymentUpdateNeeded && depRes.count === 1;
    if (orderActivated) {
      await tx.orderStatusHistory.create({
        data: { orderId, status: OrderStatus.ACTIVE, note: 'Application en ligne — mise en place confirmée.' },
      });
    }
    return {
      orderIsActive: orderActivated || !orderUpdateNeeded,
      deploymentIsActive: deploymentActivated || !deploymentUpdateNeeded,
      orderActivated,
      deploymentActivated,
      noop: false,
    };
  }

  /**
   * Effets APRÈS commit de l'activation (audit + email de livraison
   * best-effort) : partagés par `activateOrderAfterProof` et la TX-B C3.
   * Un échec audit/email ne rejette JAMAIS la couture ni le résultat.
   */
  private async postActivationEffects(orderId: string, outcome: ActivationResult): Promise<ActivationResult> {
    if (!outcome.noop) {
      if (outcome.deploymentActivated) {
        try {
          await this.audit.record({
            action: 'provision.deployment_active',
            resourceType: 'deployment',
            resourceId: orderId,
            details: { orderId, ok: true, reconciled: 1, from: DeploymentStatus.DEPLOYING, to: DeploymentStatus.ACTIVE },
          });
        } catch (e) {
          this.log.warn(`post-commit audit deployment_active order=${orderId} failed: ${String(e)}`);
        }
      }
      if (outcome.orderActivated) {
        try {
          // Relecture APRÈS commit : les données de l'email viennent de l'Order —
          // Order.domainValue est le fqdn store réel, jamais un champ Order.fqdn.
          const fresh = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { customerEmail: true, customerName: true, domainValue: true },
          });
          if (fresh?.domainValue) {
            await this.deliverEmail(fresh.customerEmail, fresh.customerName, fresh.domainValue, orderId);
          }
        } catch (e) {
          this.log.warn(`post-commit delivery email order=${orderId} failed: ${String(e)}`);
        }
      }
    }
    return outcome;
  }

  /**
   * 17B.4F-C4 — finalisation ADMIN bornée d'une commande C3 (T-fen).
   *
   * Contrat consolidé (règle GO 1) :
   *  - Seul canal READY = preuve POSITIVE identity-bound
   *    `deploymentStatus(uuid)` sur le provider/serveur EXACTS de la cible →
   *    `mapCoolifyStatus == ACTIVE`. `ABSENT`/`FAILED`/`PRESENT non ACTIVE`/
   *    `UNAVAILABLE` (même si le FQDN répond) ⇒ refus, AUCUN ACTIVE ; le
   *    HTTP du FQDN est EXCLU d'ici. Lectures réseau HORS transaction.
   *  - TX finale (verrous `Order → Tracking → HostingService → Allocation →
   *    Deployment`) : revérifie cible exacte (uuid), états, absence d'arrêt et
   *    d'essais ouverts, fraîcheur de la preuve PENDANT la transaction, puis
   *    CAS `activateOrderInTx` + flip service (COMPTANT, jamais confiance à la
   *    lecture pré-TX). Course avec une annulation ⇒ refus (aucune écriture).
   *  - Rejeu après succès = retour de l'état existant après cohérence locale,
   *    SANS nouvel audit de transition ni transport.
   *  - `HOSTING_C4_ENABLED` strictement requis ; sous ON, prérequis C4 vérifiés
   *    LIVE avant toute mutation (503 si schéma absent).
   */
  async finalizeProvisioning(
    orderId: string,
    reason: string,
    actor: { sub: string; email: string },
  ): Promise<{
    orderId: string;
    status: string;
    replay: boolean;
    proof: { observedAt: string; providerStatus: string | null } | null;
  }> {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 8) {
      throw new ConflictException('Le motif de finalisation doit faire au moins 8 caractères.');
    }
    if (!isHostingC4Enabled()) {
      throw new ConflictException('Finalisation C4 indisponible (protocole désactivé).');
    }
    await this.c4c.assertOperational();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, domainValue: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');

    // Commande C3 uniquement : sans tracking, la finalisation C4 n'a pas de
    // périmètre (ancien achat → chemin historique).
    const tracked = await this.c3.resolveTracking(orderId);
    if (!tracked) {
      throw new ConflictException('Finalisation C4 réservée aux commandes du parcours C3.');
    }

    // ── Rejeu idempotent : commande déjà ACTIVE ⇒ cohérence locale UNIQUEMENT
    //    (0 transport, 0 audit de transition, 0 écriture).
    if (order.status === OrderStatus.ACTIVE) {
      const dep = await this.prisma.deployment.findUnique({ where: { orderId } });
      const proof = await this.prisma.c4ReadinessProof.findUnique({ where: { orderId } });
      const coherent =
        dep?.status === DeploymentStatus.ACTIVE &&
        !!dep.coolifyUuid &&
        (await this.prisma.hostingServiceAllocation.count({
          where: { deploymentId: dep.id, status: HostingServiceAllocationStatus.BOUND },
        })) === 1;
      if (!coherent) {
        throw new ConflictException('Commande ACTIVE mais état local incohérent — support requis.');
      }
      return {
        orderId,
        status: OrderStatus.ACTIVE,
        replay: true,
        proof: proof
          ? { observedAt: proof.observedAt.toISOString(), providerStatus: proof.providerStatus }
          : null,
      };
    }
    if (order.status !== OrderStatus.PROVISIONING) {
      throw new ConflictException(
        `Finalisation impossible depuis le statut ${order.status} (PROVISIONING uniquement).`,
      );
    }

    // ── Cible exacte : Deployment de CETTE commande + uuid + serveur ────────
    const dep = await this.prisma.deployment.findUnique({
      where: { orderId },
      include: { server: true },
    });
    if (!dep) {
      throw new ConflictException('Aucun déploiement pour cette commande — finalisation impossible.');
    }
    if (!dep.coolifyUuid) {
      throw new ConflictException('Aucun identifiant provider pour cette commande — support requis.');
    }
    if (dep.status === DeploymentStatus.FAILED || dep.status === DeploymentStatus.PENDING) {
      throw new ConflictException(
        `Déploiement ${dep.status} — finalisation impossible sans build en cours.`,
      );
    }
    if (dep.status !== DeploymentStatus.DEPLOYING && dep.status !== DeploymentStatus.ACTIVE) {
      throw new ConflictException(`Déploiement ${dep.status} — finalisation refusée.`);
    }
    const server = dep.server;
    if (
      !server ||
      server.panelProvider !== 'COOLIFY' ||
      !server.apiBaseUrl ||
      !server.apiTokenEnc
    ) {
      throw new ConflictException('Serveur provider indisponible — finalisation refusée.');
    }

    const allocation = await this.prisma.hostingServiceAllocation.findFirst({
      where: { deploymentId: dep.id },
      select: { id: true, status: true, hostingServiceId: true },
    });
    if (!allocation || allocation.status !== HostingServiceAllocationStatus.BOUND) {
      throw new ConflictException(
        'Allocation non liée (BOUND) à ce déploiement — finalisation refusée.',
      );
    }

    // ── LECTURE réseau HORS transaction : preuve identity-bound ─────────────
    let providerStatus: string;
    try {
      const res = await this.panelFactory
        .create()
        .deploymentStatus(
          this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]),
          dep.coolifyUuid,
        );
      providerStatus = res.rawStatus;
    } catch (e) {
      // ABSENT (404) comme erreur réseau générique ⇒ refus ; AUCUN repli HTTP.
      throw new ConflictException(
        isAbsentExternalError(e)
          ? 'Application absente chez le provider — finalisation refusée.'
          : 'Provider injoignable — finalisation refusée (unavailable).',
      );
    }
    const mapped = mapCoolifyStatus(providerStatus);
    if (mapped === DeploymentStatus.FAILED) {
      throw new ConflictException('Build en échec chez le provider — finalisation refusée.');
    }
    if (mapped !== DeploymentStatus.ACTIVE) {
      throw new ConflictException(
        `Application non prête chez le provider (${providerStatus}) — finalisation refusée.`,
      );
    }

    // ── TX finale : verrous ordonnés + revérifications + CAS ────────────────
    const outcome = await this.prisma.$transaction(async (tx) => {
      const orders = await tx.$queryRaw<
        Array<{ id: string; status: OrderStatus }>
      >`SELECT "id", "status" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      if (!orders[0]) throw new NotFoundException('Commande introuvable.');
      if (orders[0].status === OrderStatus.CANCELLED || orders[0].status === OrderStatus.REFUNDED) {
        throw new ConflictException('Course perdue avec une annulation — finalisation refusée.');
      }
      if (orders[0].status !== OrderStatus.PROVISIONING) {
        throw new ConflictException(
          `Statut concurrent ${orders[0].status} — finalisation refusée.`,
        );
      }
      const trs = await tx.$queryRaw<Array<{ orderId: string }>>`
        SELECT "orderId" FROM "OrderProvisioningTracking" WHERE "orderId" = ${orderId} FOR UPDATE`;
      if (!trs[0]) {
        throw new ConflictException('Tracking C3 absent — finalisation refusée.');
      }
      const svcs = await tx.$queryRaw<Array<{ id: string; status: HostingServiceStatus }>>`
        SELECT "id", "status" FROM "HostingService" WHERE "orderId" = ${orderId} FOR UPDATE`;
      const svc = svcs[0];
      if (!svc) throw new ConflictException('Service hébergement absent — support requis.');
      const allocs = await tx.$queryRaw<
        Array<{ id: string; status: string; deploymentId: string | null; providerIntentAt: Date | null }>
      >`
        SELECT "id", "status", "deploymentId", "providerIntentAt"
        FROM "HostingServiceAllocation" WHERE "id" = ${allocation.id} FOR UPDATE`;
      const alloc = allocs[0];
      if (!alloc || alloc.status !== 'BOUND' || alloc.deploymentId !== dep.id) {
        throw new ConflictException('Allocation détachée entre-temps — finalisation refusée.');
      }
      const deps = await tx.$queryRaw<
        Array<{ id: string; status: string; coolifyUuid: string | null }>
      >`
        SELECT "id", "status", "coolifyUuid" FROM "Deployment" WHERE "id" = ${dep.id} FOR UPDATE`;
      const depLock = deps[0];
      if (
        !depLock ||
        depLock.status !== 'DEPLOYING' ||
        depLock.coolifyUuid !== dep.coolifyUuid
      ) {
        throw new ConflictException('Déploiement modifié entre-temps — finalisation refusée.');
      }
      if (!dep.coolifyUuid) {
        // Pas d'identité provider ⇒ pas de preuve identity-bound possible.
        throw new ConflictException('Identifiant provider absent — finalisation refusée.');
      }
      // Arrêt / tentative ouverte : aucun ACTIVE.
      const stopScopes = C4ProtocolService.scopesFor({
        order: orderId,
        service: svc.id,
        allocation: alloc.id,
        deployment: dep.id,
      });
      if (await this.c4.hasStopInTx(tx, stopScopes)) {
        throw new ConflictException('Arrêt demandé — finalisation refusée.');
      }
      if ((await this.c4.unresolvedCreativeInTx(tx, alloc.id)) > 0) {
        throw new ConflictException('Tentative provider non résolue — finalisation refusée.');
      }
      // Preuve durable identity-bound (fraîcheur = observée pour CETTE cible).
      await tx.c4ReadinessProof.upsert({
        where: { orderId },
        create: {
          orderId,
          deploymentId: dep.id,
          coolifyUuid: dep.coolifyUuid,
          serverId: server.id,
          providerStatus,
          evidence: {
            channel: 'deploymentStatus',
            identityBound: true,
            mapped,
            observedAt: new Date().toISOString(),
          },
        },
        update: {
          deploymentId: dep.id,
          coolifyUuid: dep.coolifyUuid,
          serverId: server.id,
          providerStatus,
          observedAt: new Date(),
          evidence: {
            channel: 'deploymentStatus',
            identityBound: true,
            mapped,
            observedAt: new Date().toISOString(),
          },
        },
      });
      // CAS d'activation + flip service (comptants, dans la MÊME tx).
      const act = await this.activateOrderInTx(tx, orderId);
      if (!act.orderIsActive || !act.deploymentIsActive) {
        throw new ConflictException(
          `Activation impossible (${act.reason ?? 'cas'}) — finalisation refusée.`,
        );
      }
      if (
        svc.status === HostingServiceStatus.PROVISIONING &&
        act.orderActivated &&
        act.deploymentActivated
      ) {
        const flip = await tx.hostingService.updateMany({
          where: { id: svc.id, status: HostingServiceStatus.PROVISIONING },
          data: { status: HostingServiceStatus.ACTIVE },
        });
        if (flip.count !== 1) {
          throw new ConflictException('Service modifié entre-temps — finalisation refusée.');
        }
      }
      return act;
    });

    await this.postActivationEffects(orderId, outcome);
    try {
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'provision.finalize.c4',
        resourceType: 'order',
        resourceId: orderId,
        details: { reason: trimmed, providerStatus, activated: !outcome.noop },
      });
    } catch (e) {
      this.log.warn(`finalize audit order=${orderId} failed: ${String(e)}`);
    }

    const proof = await this.prisma.c4ReadinessProof.findUnique({ where: { orderId } });
    return {
      orderId,
      status: outcome.orderIsActive ? OrderStatus.ACTIVE : OrderStatus.PROVISIONING,
      replay: false,
      proof: proof
        ? { observedAt: proof.observedAt.toISOString(), providerStatus: proof.providerStatus }
        : null,
    };
  }

  /**
   * 17B.3C - planifie la PREMIERE reconciliation persistee d'un deploiement reste
   * DEPLOYING apres l expiration normale du proof-gate. Idempotente et atomique :
   * updateMany ne touche QUE le Deployment de la commande encore DEPLOYING ET
   * sans echeance deja posee (reconcileNextAt = null). Garanties :
   *   - l echeance est calculee UNE seule fois (now + INITIAL_RECONCILE_DELAY_MS) ;
   *   - une echeance deja presente n est NI ecrasee NI repoussee (condition base) ;
   *   - reconcileAttempts / reconcileTerminalFailures restent inchangees et
   *     reconcileLastCheckedAt reste vide (aucune tentative n a eu lieu) ;
   *   - Deployment ACTIVE/FAILED/PENDING/absent => count 0, aucun effet.
   * Aucun worker n est cree ni demarre (17B.4+). now est injectable pour des
   * tests deterministes (horloge controlee, sans fake timers).
   */
  private async scheduleInitialReconcile(
    orderId: string,
    now: Date = new Date(),
    guard?: StoreWriteGuard,
  ): Promise<{ count: number }> {
    const nextAt = new Date(now.getTime() + INITIAL_RECONCILE_DELAY_MS);
    const write = guard ?? this.directWrite;
    return write((tx) =>
      tx.deployment.updateMany({
        where: { orderId, status: DeploymentStatus.DEPLOYING, reconcileNextAt: null },
        data: { reconcileNextAt: nextAt },
      }),
    );
  }

  /**
   * Limites CPU/RAM d'un pack au format Coolify (`limits_cpus`/`limits_memory`).
   * Renvoie null si aucun plafond à appliquer (pack inactif ou sans valeur).
   * Partagé entre la création d'app et `syncAppLimits` (Bloc 2/3).
   */
  private buildLimits(pack: { ramMb?: number; cpuCores?: number; status?: string } | null | undefined): { cpus?: string; memory?: string } | null {
    if (!pack || pack.status !== 'ACTIVE') return null;
    const limits: { cpus?: string; memory?: string } = {};
    if (pack.cpuCores && pack.cpuCores > 0) {
      const n = Math.round(pack.cpuCores * 100) / 100;
      limits.cpus = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }
    if (pack.ramMb && pack.ramMb > 0) {
      limits.memory = pack.ramMb < 1024 ? `${Math.round(pack.ramMb)}m` : `${Math.round((pack.ramMb / 1024) * 100) / 100}g`;
    }
    return limits.cpus || limits.memory ? limits : null;
  }

  /**
   * Bloc 2 — Ré-applique les limites RAM/CPU du pack courant aux apps DÉJÀ
   * déployées de l'abonné (upgrade sans perte de données). Ne redéploie RIEN :
   * resize best-effort, par app, des Deployment non-FAILED pourvus d'un
   * `coolifyUuid` et d'un serveur Coolify. Chaque échec est tracé en audit mais
   * n'interrompt pas les autres. Déclenché après une commande d'upgrade, exposé
   * en action admin « Ré-synchroniser les ressources », et réutilisé par le
   * Bloc 3.
   */
  async syncAppLimits(subscriptionId: string): Promise<{
    subscriptionId: string;
    checked: number;
    applied: number;
    failed: number;
  }> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        product: { include: { pack: { include: { deploymentModule: { include: { server: true } } } } } },
      },
    });
    if (!sub) throw new NotFoundException('Abonnement introuvable.');

    const pack = sub.product.pack;
    const server = pack?.deploymentModule?.server ?? null;
    const limits = this.buildLimits(pack);
    if (
      !server ||
      server.panelProvider !== 'COOLIFY' ||
      !server.apiBaseUrl ||
      !server.apiTokenEnc ||
      !limits
    ) {
      return { subscriptionId, checked: 0, applied: 0, failed: 0 };
    }

    const apps = await this.prisma.deployment.findMany({
      where: {
        userId: sub.userId,
        status: { not: DeploymentStatus.FAILED },
        coolifyUuid: { not: null },
      },
    });

    const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
    const transport = this.panelFactory.create();

    let applied = 0;
    let failed = 0;
    for (const app of apps) {
      if (!app.coolifyUuid) continue;
      try {
        await transport.applyAppLimits(target, app.coolifyUuid, limits);
        applied += 1;
        await this.audit.record({
          action: 'subscription.sync_app_limits',
          resourceType: 'deployment',
          resourceId: app.id,
          details: { subscriptionId, limits, ok: true },
        });
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`syncAppLimits subscription=${subscriptionId} app=${app.coolifyUuid}: ${msg}`);
        await this.audit.record({
          action: 'subscription.sync_app_limits',
          resourceType: 'deployment',
          resourceId: app.id,
          details: { subscriptionId, limits, ok: false, error: msg },
        });
      }
    }
    return { subscriptionId, checked: apps.length, applied, failed };
  }

  private buildTarget(server: NonNullable<NonNullable<Awaited<ReturnType<ProvisioningService['resolveServer']>>>>): PanelTarget {
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc!);
    } catch {
      throw new Error('Impossible de déchiffrer le jeton API Coolify (ENCRYPTION_KEY ?).');
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl!,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }

  private async resolveServer(order: {
    product: { pack?: { deploymentModule?: { server?: unknown } | null } | null };
  }): Promise<{ id: string; panelProvider: string; apiBaseUrl: string | null; apiTokenEnc: string | null; strictTls: boolean; hostname: string; coolifyProjectUuid: string | null; coolifyServerUuid: string | null } | null> {
    const s = order.product.pack?.deploymentModule?.server as
      | { id: string; panelProvider: string; apiBaseUrl: string | null; apiTokenEnc: string | null; strictTls: boolean; hostname: string; coolifyProjectUuid: string | null; coolifyServerUuid: string | null }
      | null
      | undefined;
    if (!s) return null;
    return s;
  }

  /**
   * AUTO-DÉTECTION du serveur Coolify cible (demande utilisateur : « si le champ
   * Serveur Coolify cible (uuid) est vide → utiliser le uuid détecté »). Quand
   * `server.coolifyServerUuid` est vide, on interroge `GET /servers` et on
   * choisit celui qui correspond au `hostname`/`ip` du serveur saisi, sinon le
   * premier. Best-effort : tout échec renvoie undefined → le transport se replie
   * sur le défaut, on ne bloque JAMAIS le déploiement pour une détection.
   */
  private async resolveCoolifyServerUuid(
    server: NonNullable<NonNullable<Awaited<ReturnType<ProvisioningService['resolveServer']>>>>,
    transport: PanelTransport,
  ): Promise<string | undefined> {
    if (server.coolifyServerUuid) return server.coolifyServerUuid;
    try {
      const target = this.buildTarget(server);
      const servers = await transport.listServers(target);
      if (servers.length === 0) return undefined;
      const byHost = servers.find((s) => s.ip && server.hostname && s.ip.includes(server.hostname));
      // Pas de correspondance hôte → premier serveur (détection déterministe).
      return byHost?.uuid ?? servers[0]?.uuid;
    } catch {
      return undefined;
    }
  }

  private async runAction(
    action: ProvisionAction,
    ctx: {
      order: {
        id: string;
        customerEmail: string;
        customerName: string;
        productId: string;
        product: { name: string; moduleParams?: unknown; pack?: unknown };
        customer?: { userId?: string | null } | null;
      };
      method: { name: string };
      fqdn: string | null;
      appUuid: string | null;
      /** 17B.4F-C3 : garde token/lease des écritures C3 (absente = legacy direct). */
      guard?: StoreWriteGuard;
      /** 17B.4F-C4 : contexte de tentatives provider (absente = C4 OFF). */
      c4?: C4RunCtx;
    },
  ): Promise<{ fqdn?: string; appUuid?: string; message?: string }> {
    switch (action) {
      case ProvisionAction.CREATE_APP:
        return this.actionCreateApp(ctx);
      case ProvisionAction.CONFIGURE_DNS:
        return this.actionConfigureDns(ctx);
      case ProvisionAction.GENERATE_SSL:
        return { message: 'SSL géré par Cloudflare (proxied).' };
      case ProvisionAction.ENABLE_BACKUP:
        return { message: 'Sauvegarde non configurée (best-effort).' };
      default:
        return { message: `Action inconnue : ${String(action)}` };
    }
  }

  private async actionCreateApp(ctx: {
    order: {
      id: string;
      product: { name: string; moduleParams?: unknown; pack?: unknown };
      customer?: { userId?: string | null } | null;
    };
    fqdn: string | null;
    appUuid: string | null;
    guard?: StoreWriteGuard;
    c4?: C4RunCtx;
  }): Promise<{ appUuid?: string; message?: string }> {
    const write = ctx.guard ?? this.directWrite;
    // On tente de créer l'app Coolify si le module a un serveur configuré.
    // moduleParams peut porter repoUrl/branch/buildPack/appName (produit GitHub).
    const fullOrder = await this.prisma.order.findUnique({
      where: { id: ctx.order.id },
      include: { product: { include: { pack: { include: { deploymentModule: { include: { server: true } } } } } } },
    });
    if (!fullOrder) return { message: 'Commande introuvable — app non créée.' };
    const server = fullOrder?.product.pack?.deploymentModule?.server ?? null;
    if (!server || server.panelProvider !== 'COOLIFY' || !server.apiBaseUrl || !server.apiTokenEnc) {
      return { message: 'Aucun serveur Coolify configuré pour ce produit — app non créée (DNS seul).' };
    }
    const params = (fullOrder?.product.moduleParams ?? {}) as Record<string, unknown>;
    const repoUrl = typeof params.repoUrl === 'string' ? params.repoUrl : null;
    // Sans repoUrl, on ne peut pas créer d'app Coolify — on considère le produit
    // comme « sans app » (ex. pack WordPress géré déjà provisionné ailleurs).
    if (!repoUrl) {
      return { message: 'Produit sans repoUrl — création Coolify ignorée.' };
    }
    const branch = typeof params.branch === 'string' && params.branch.trim() ? String(params.branch).trim() : 'main';
    const buildPack = typeof params.buildPack === 'string' ? String(params.buildPack) : 'nixpacks';
    // Publie un SPA buildé en statique (Vite → dist). Sans ces deux champs,
    // nixpacks lancerait un serveur node (le dump a `express`) au lieu de servir
    // la sortie de build → un sous-domaine qui répond 200 mais à vide.
    const publishDirectory =
      typeof params.publishDirectory === 'string' && String(params.publishDirectory).trim()
        ? String(params.publishDirectory).trim()
        : undefined;
    const isStatic = typeof params.isStatic === 'boolean' ? params.isStatic : undefined;
    // Backend servé (Node/autre runtime) vs SPA statique : un SPA (isStatic OU
    // publishDirectory de build) est servi en statique — on NE lui applique PAS
    // la logique de port runtime Node (STATIC reste STATIC). Un produit sans
    // isStatic ni publishDirectory est un serveur d'applications → port réconcilié.
    const isServerRuntime = !(isStatic === true || String(publishDirectory ?? '').trim().length > 0);
    const appName = typeof params.appName === 'string' && String(params.appName).trim()
      ? String(params.appName).trim()
      : fullOrder?.product.name ?? 'app';
    const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
    const transport = this.panelFactory.create();
    const mod = fullOrder?.product.pack?.deploymentModule ?? null;
    const userId = ctx.order.customer?.userId ?? null;
    // Choix du projet Coolify selon le type de module (A/B) :
    //  • SHARED_PROJECT (A) → projet partagé configuré sur le module ;
    //  • PER_CLIENT_PROJECT (B) → projet Coolify DÉDIÉ du client, créé à la
    //    première commande (`getOrCreateClientProject`) — même logique que le
    //    widget « Créer un nouveau projet » (deployments.service) ;
    //  • aucun module → comportement historique : projet du serveur.
    // On capture aussi `clientProjectId` pour traçabilité sur la row Deployment.
    let projectUuid: string | undefined;
    let clientProjectId: string | null = null;
    if (mod && mod.kind === 'SHARED_PROJECT' && mod.sharedProjectUuid) {
      projectUuid = mod.sharedProjectUuid;
    } else if (mod && mod.kind === 'PER_CLIENT_PROJECT' && userId) {
      const cp = await this.deployments.getOrCreateClientProject(userId, server, mod);
      projectUuid = cp.projectUuid;
      clientProjectId = cp.id;
    } else {
      projectUuid = server.coolifyProjectUuid ?? undefined;
    }
    const repoFullName = this.deriveRepoFullName(repoUrl);

    // Phase 16 (Décision C) — l'app du store devient une row **Deployment** liée
    // au user (via order.customer.userId), visible + supprimable dans « Mes
    // applications », comptée par le quota du pack. Fix critique prod (2026-09-14) :
    // la row est liée à SA commande (`orderId` @unique), PAS réutilisée par
    // `{ userId, repoFullName }`. Réutiliser par repo effondrait plusieurs commandes
    // du même produit en UNE row et ÉCRASAIT l'app précédente (coolifyUuid/fqdn)
    // → la commande précédente disparaissait de l'espace client, sous-domaine perdu.
    // Désormais : une commande = une app = une row ; retry/relance idempotent par
    // `orderId` (et par `coolifyUuid` pour une relance au sein de la MÊME exécution).
    let row:
      | {
          id: string;
          coolifyUuid: string | null;
          detail: string | null;
          status: string;
          limitsStatus: string | null;
        }
      | null = null;
    if (ctx.appUuid) {
      row = await this.prisma.deployment.findFirst({
        where: { coolifyUuid: ctx.appUuid },
        select: { id: true, coolifyUuid: true, detail: true, status: true, limitsStatus: true },
      });
    }
    if (!row && ctx.order?.id) {
      row = await this.prisma.deployment.findFirst({
        where: { orderId: ctx.order.id },
        select: { id: true, coolifyUuid: true, detail: true, status: true, limitsStatus: true },
      });
    }

    // Ré-utilisation idempotente (fix 2026-09-15) : si une app Coolify existe déjà
    // pour CETTE commande (row.coolifyUuid), on la RE-déploie au lieu d'en créer une
    // nouvelle. Sans ça, chaque relance admin (`force`) créait une app orpheline
    // supplémentaire sur le même sous-domaine (conflit traefik + apps fantômes).
    const existingUuid = row?.coolifyUuid ?? null;
    let appUuid: string;
    if (existingUuid) {
      appUuid = existingUuid;
      this.log.log(`provision order=${ctx.order.id}: réutilisation de l'app existante ${appUuid}`);
    } else {
      // ── 17B.4F-C4 : tentative CREATE durable émise DANS la garde (même TX
      //    que la 1ʳᵉ tentative), commitée AVANT le réseau : takeover du
      //    périmètre + arrêt + créateur non résolu sont opposables au dispatch.
      let attempt: { attemptId: string; targetIntentHash: string | null } | null = null;
      if (ctx.c4 && ctx.guard) {
        attempt = await ctx.guard((tx) =>
          this.c4.beginDispatch(tx, {
            nature: 'CREATE',
            scope: { type: 'ORDER', id: ctx.order.id },
            allocationId: ctx.c4!.allocationId,
            orderId: ctx.order.id,
            holder: ctx.c4!.holder,
            targetIntent: {
              type: 'application',
              serverId: server.id,
              appName,
              repoUrl,
              branch,
              buildPack,
              projectUuid: projectUuid ?? null,
            },
          }),
        );
      }
      let created: { uuid: string };
      try {
        created = await transport.createGitApp(target, {
          repoUrl,
          branch,
          serviceName: appName,
          buildPack,
          appName,
          projectUuid,
          serverUuid: await this.resolveCoolifyServerUuid(server, transport),
          publishDirectory,
          isStatic,
        });
      } catch (err) {
        if (attempt && ctx.c4) {
          // Timeout/5xx ambigu ⇒ UNKNOWN (« non sûr », jamais SETTLED) — le
          // créateur reste non résolu : aucune reprise de création, aucun
          // nettoyage automatique sur cette allocation.
          // TX dédiée (jamais `ctx.guard`) : la consignation doitaboutir même
          // si l'Order est passée CANCELLED entre-temps (« aucun perdu d'un
          // UUID reçu après bascule » — une annulation n'efface jamais une
          // consignation déjà reçue).
          try {
            await this.c4.settleStandalone({
              attemptId: attempt.attemptId,
              holder: ctx.c4.holder,
              outcome: 'UNKNOWN',
              targetIntentHash: attempt.targetIntentHash,
            });
          } catch {
            // Persistance impossible ⇒ incertitude conservée (l'attempt reste
            // ouvert/UNSETTLED) : aucun identifiant prétendu enregistré.
          }
        }
        throw err;
      }
      appUuid = created.uuid;
      if (attempt && ctx.c4) {
        const attemptId = attempt.attemptId;
        const holder = ctx.c4.holder;
        const hash = attempt.targetIntentHash;
        const orderId = ctx.order.id;
        const uuid = appUuid;
        // Consignation + persistance ATOMIQUE de l'identifiant retourné (même
        // tx que la vérification d'identité) — si la persistance échoue, le
        // rollback conserve l'incertitude (aucun identifiant prétendu enregistré).
        // TX dédiée hors garde Order (voir ci-dessus) : la consignation de
        // l'UUID retourné est une VÉRITÉ qui survit à l'annulation.
        await this.c4.settleStandalone({
          attemptId,
          holder,
          outcome: 'SUCCESS',
          targetIntentHash: hash,
          returnedIdentifiers: { uuid },
          persist: async (ptx) => {
            await ptx.deployment.updateMany({
              where: { orderId },
              data: { coolifyUuid: uuid },
            });
          },
        });
      }
    }

    // ── 17B.4F-C4 — barrière post-appel : un ARRÊT survenu pendant la création
    //    (ou présent avant la réutilisation) n'autorise QUE la consignation
    //    déjà effectuée : aucune opération réseau supplémentaire, aucun flip de
    //    statut (les limites/domaines/déploiement sont gelés).
    if (ctx.c4 && ctx.guard) {
      const stopped = await this.c4.hasStop(
        C4ProtocolService.scopesFor({
          order: ctx.order.id,
          service: ctx.c4.serviceId,
          allocation: ctx.c4.allocationId,
        }),
      );
      if (stopped) {
        return {
          appUuid,
          message: 'Consignation tardive (arrêt demandé) — aucune opération supplémentaire.',
        };
      }
    }
    // Sécurité serveur partagé (Bloc 3) — l'application des limites du pack est
    // OBLIGATOIRE : jamais une app sans plafond sur un box partagé. Si le pack
    // porte des limites et qu'on ne peut pas les appliquer, on échoue la step
    // create_app (l'order passe FAILED) plutôt que de laisser l'app sans cap.
    const limits = this.buildLimits(
      fullOrder?.product.pack as { ramMb?: number; cpuCores?: number; status?: string } | null,
    );
    if (limits) {
      try {
        await transport.applyAppLimits(target, appUuid, limits);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`Limites pack non appliquées sur serveur partagé — app NON créée (${m}).`);
      }
    }
    // Si le sous-domaine a déjà été alloué (ordre CONFIGURE_DNS avant CREATE_APP),
    // on le pose sur l'app AVANT le déploiement pour que le premier build porte
    // la bonne étiquette traefik (déterminant : c'est ce qui fait que le
    // sous-domaine est réellement servi publiquement — vérifié live 4.1.2).
    if (ctx.fqdn) {
      try {
        await transport.setAppDomain(target, appUuid, ctx.fqdn);
      } catch {
        // best-effort — le domaine sera posable en retry
      }
    }
    // Réconciliation du port (fix GAP PORT, 2026-09-15, Approche B + contrat
    // build-pack) : pour un backend Servé (non statique), on résout le port
    // EFFECTIVEMENT exposé/routé par le provider et on rend le runtime cohérent
    // AVANT le déploiement. Source de vérité : ① `resolveExposedPort()` (provider)
    // → ② contrat build-pack/runtime si le provider ne le révèle pas (cas réel
    // Coolify 4.1.2 : `ports_exposes` = null) → ③ aucun : diagnostic, AUCUN port
    // injecté, et le proof-gate garde l'ordre non-ACTIVE (jamais de faux port, jamais
    // de faux ACTIVE). Générique : la valeur ne dépend JAMAIS du dépôt/slug/framework.
    if (isServerRuntime) {
      const resolved = await this.resolveBackendExposedPort(transport, target, appUuid, buildPack);
      if (resolved.port !== null) {
        try {
          await transport.applyNodePort(target, appUuid, resolved.port);
          this.log.log(
            `provision order=${ctx.order.id}: port backend résolu=${resolved.port} (source=${resolved.source})`,
          );
          await this.audit.record({
            action: 'provision.node_port',
            resourceType: 'order',
            resourceId: ctx.order.id,
            details: { ok: true, port: resolved.port, source: resolved.source },
          });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          this.log.warn(`provision order=${ctx.order.id}: port runtime non appliqué (${m})`);
          await this.audit.record({
            action: 'provision.node_port',
            resourceType: 'order',
            resourceId: ctx.order.id,
            details: { ok: false, error: m, port: resolved.port },
          });
          // On ne bloque pas : le proof-gate (awaitAppReady) gardera l'ordre
          // non-ACTIVE si le runtime ne sert pas réellement.
        }
      } else {
        // Aucune source fiable (provider null + aucun contrat build-pack) :
        // on n'injecte PAS de port fantaisiste. Diagnostic explicite. Le proof-gate
        // garde l'order PROVISIONING (jamais ACTIVE sans preuve de service réel).
        const msg =
          'Aucun port exposé fiable pour ce backend (provider null, aucun contrat build-pack/runtime). PROVISIONING, jamais ACTIVE.';
        this.log.warn(`provision order=${ctx.order.id}: ${msg}`);
        await this.audit.record({
          action: 'provision.node_port',
          resourceType: 'order',
          resourceId: ctx.order.id,
          details: { ok: false, error: msg, source: 'none' },
        });
      }
    }
    await transport.deployApp(target, appUuid);

    // Row Deployment : création (nouvelle app) ou mise à jour du déploiement.
    const deployDetail = ctx.fqdn ? `App : https://${ctx.fqdn}` : 'Déploiement déclenché sur Coolify.';
    // Limites effectives (overrides module prioritaires) — partagées entre la
    // création et la mise à jour (row C3 créée en TX-C AVANT appel provider :
    // ses limites sont tracées mais `limitsStatus` reste null jusqu'ici).
    const effStore = resolveEffectiveLimits(
      fullOrder?.product.pack as { ramMb: number; cpuCores: number; storageLimit: number | null } | null | undefined,
      mod,
    );
    if (row && userId) {
      await write((tx) =>
        tx.deployment.update({
          where: { id: row.id },
          data: {
            status: DeploymentStatus.DEPLOYING,
            detail: deployDetail,
            coolifyUuid: appUuid,
            orderId: ctx.order?.id ?? null,
            // Rafraîchit la traçabilité du projet/module (une row réutilisée par
            // idempotence pouvait conserver l'ancien projet — ex. projet serveur).
            coolifyProjectUuid: projectUuid ?? null,
            clientProjectId,
            moduleId: mod?.id ?? null,
            packId: fullOrder?.product.pack?.id ?? null,
            // Row C3 (TX-C, limites non tentées) : `applyAppLimits` vient de
            // réussir (échec = throw) → APPLIED. Row legacy déjà renseignée :
            // aucun changement (conditions strictes, contrat 17 inchangé).
            ...(row.limitsStatus === null && effStore
              ? { limitsStatus: LimitsStatus.APPLIED }
              : {}),
            ...(ctx.fqdn ? { fqdn: ctx.fqdn } : {}),
          },
        }),
      );
      // 17B.4E-D-B1 (fix H) — re-lie le ClientSubdomain si la row venait d'être
      // créée/renouvelée (retry idempotent).
      await this.linkClientSubdomainToDeployment(ctx.order.id, ctx.fqdn, row.id, undefined, undefined, ctx.guard);
      await this.audit.record({
        actorId: userId,
        actorEmail: fullOrder.customerEmail,
        action: 'deploy.redeploy.store',
        resourceType: 'deployment',
        resourceId: row.id,
        details: { orderId: ctx.order.id, coolifyUuid: appUuid, fqdn: ctx.fqdn ?? undefined, source: 'store' },
      });
    } else if (userId) {
      // Phase 17 (3c/3d) — cohérence quota/tracking per-pack : on trace le pack et les
      // limites effectives (overrides module) sur l'app store aussi. Ici l'échec
      // d'application des limites est FATAL (policy serveur partagé) : si on arrive à
      // la création, les limites ont été appliquées → APPLIED (ou null si pas de pack).
      const createdRow = await write((tx) =>
        tx.deployment.create({
          data: {
            userId,
            serverId: server.id,
            repoFullName: repoFullName ?? appName,
            repoUrl,
            buildPack,
            appName,
            branch,
            coolifyUuid: appUuid,
            orderId: ctx.order?.id ?? null,
            status: DeploymentStatus.DEPLOYING,
            detail: deployDetail,
            publishDirectory,
            coolifyProjectUuid: projectUuid ?? null,
            clientProjectId,
            moduleId: mod?.id ?? null,
            packId: fullOrder?.product.pack?.id ?? null,
            limitsStatus: effStore ? LimitsStatus.APPLIED : null,
            limitsRamMb: effStore?.ramMb ?? null,
            limitsCpu: effStore?.cpuCores ?? null,
            ...(ctx.fqdn ? { fqdn: ctx.fqdn } : {}),
          },
        }),
      );
      // 17B.4E-D-B1 (fix H) — lie le ClientSubdomain à la row DÈS sa création
      // (quel que soit l'ordre CREATE_APP / CONFIGURE_DNS).
      await this.linkClientSubdomainToDeployment(ctx.order.id, ctx.fqdn, createdRow.id, undefined, undefined, ctx.guard);
      await this.audit.record({
        actorId: userId,
        actorEmail: fullOrder.customerEmail,
        action: 'deploy.create.store',
        resourceType: 'deployment',
        resourceId: createdRow.id,
        details: { orderId: ctx.order.id, repoFullName, buildPack, appName, fqdn: ctx.fqdn ?? undefined, source: 'store' },
      });
    }
    return {
      appUuid: appUuid,
      message: userId
        ? existingUuid
          ? `App réutilisée et redéployée — « Mes applications » (${appUuid}).`
          : `App créée et ajoutée à « Mes applications » (${appUuid}).`
        : `App Coolify ${existingUuid ? 'réutilisée' : 'créée'} (${appUuid}) — non liée à un compte client.`,
    };
  }

  /** « owner/repo » depuis une URL git (git@, https, .git, slash final). */
  private deriveRepoFullName(url: string): string | null {
    const cleaned = url
      .replace(/^git@[^:]+:/, '')
      .replace(/^https?:\/\//, '')
      .replace(/^ssh:\/\//, '')
      .replace(/\.git(\/|$)/, '')
      .replace(/\/+$/, '');
    const parts = cleaned.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  /**
   * Résout le port EFFECTIVEMENT exposé/routé pour un backend servé, avec sa
   * source de vérité. Ordonnancement (Approche B + contrat build-pack, validé) :
   *   1. `resolveExposedPort()` du provider/transport — la responsabilité de
   *      connaître sa propre config reste au provider (Coolify 4.1.2 renvoie
   *      souvent `null`, l'image n'ayant pas encore été analysée) ;
   *   2. contrat build-pack/runtime explicite (`resolveBuildPackPortContract`) si
   *      le provider ne révèle rien — connaissance du runtime, jamais du dépôt ;
   *   3. aucun ⇒ `{ port: null, source: 'none' }` → le moteur N'INJECTE AUCUN port
   *      fantaisiste et laisse le proof-gate garder l'ordre non-ACTIVE.
   * Le résultat est déterministe et indépendant du repository/framework.
   */
  private async resolveBackendExposedPort(
    transport: PanelTransport,
    target: PanelTarget,
    appUuid: string,
    buildPack: string,
  ): Promise<{ port: number | null; source: 'provider' | 'buildpack' | 'none' }> {
    let providerPort: number | null = null;
    try {
      providerPort = await transport.resolveExposedPort(target, appUuid);
    } catch {
      providerPort = null;
    }
    if (providerPort !== null) return { port: providerPort, source: 'provider' };
    const contract = resolveBuildPackPortContract(buildPack);
    if (contract?.defaultExposedPort != null) {
      return { port: contract.defaultExposedPort, source: 'buildpack' };
    }
    return { port: null, source: 'none' };
  }

  private async actionConfigureDns(ctx: {
    order: { id: string; customerName: string };
    fqdn: string | null;
    appUuid: string | null;
    guard?: StoreWriteGuard;
    c4?: C4RunCtx;
  }): Promise<{ fqdn?: string; message?: string }> {
    const write = ctx.guard ?? this.directWrite;
    if (ctx.fqdn) return { fqdn: ctx.fqdn, message: `Sous-domaine déjà alloué : https://${ctx.fqdn}` };

    // ── 17B.4F-C4 : émission/consignation de la tentative CONFIGURE (DNS) ───
    const c4Emit = async (
      intent: Record<string, unknown>,
    ): Promise<{ attemptId: string; targetIntentHash: string | null } | null> => {
      if (!ctx.c4 || !ctx.guard) return null;
      return ctx.guard((tx) =>
        this.c4.beginDispatch(tx, {
          nature: 'CONFIGURE',
          scope: { type: 'ORDER', id: ctx.order.id },
          allocationId: ctx.c4!.allocationId,
          orderId: ctx.order.id,
          holder: ctx.c4!.holder,
          targetIntent: { type: 'dns', ...intent },
        }),
      );
    };
    const c4Settle = async (
      ticket: { attemptId: string; targetIntentHash: string | null } | null,
      outcome: 'SUCCESS' | 'UNKNOWN',
      identifiers: Record<string, unknown>,
    ): Promise<void> => {
      if (!ticket || !ctx.c4) return;
      // TX dédiée hors garde Order : la consignation (vérité reçue du réseau,
      // fqdn/uuid) survit à une annulation survenue pendant l'appel.
      await this.c4.settleStandalone({
        attemptId: ticket.attemptId,
        holder: ctx.c4.holder,
        outcome,
        targetIntentHash: ticket.targetIntentHash,
        returnedIdentifiers: identifiers,
      });
    };
    const allocWithC4 = async (
      intent: Record<string, unknown>,
      fn: () => Promise<{ subdomain: string; fqdn: string }>,
    ): Promise<{ subdomain: string; fqdn: string }> => {
      const ticket = await c4Emit(intent);
      let result: { subdomain: string; fqdn: string };
      try {
        result = await fn();
      } catch (err) {
        await c4Settle(ticket, 'UNKNOWN', {});
        throw err;
      }
      await c4Settle(ticket, 'SUCCESS', { fqdn: result.fqdn });
      return result;
    };

    const fullOrder = await this.prisma.order.findUnique({
      where: { id: ctx.order.id },
      include: {
        product: {
          include: {
            freeSubdomainRule: true,
            pack: { include: { deploymentModule: { include: { server: true } } } },
          },
        },
      },
    });
    const server = fullOrder?.product.pack?.deploymentModule?.server ?? null;
    // Phase 4 — résolution DÉTERMINISTE de la racine effective : effectiveDomainId
    // (déjà FIGÉE, gagne à tout retry #8) → requestedDomainId (choix client #5/#7/#13)
    // → défaut (1 éligible ; >1 ambiguïté ; 0 erreur #10). AUCUN fallback arbitraire.
    const { root } = await this.cloudflare.resolveEffectiveRoot({
      allowedDomainIds: fullOrder?.product.freeSubdomainRule?.allowedDomainIds ?? null,
      requestedDomainId: fullOrder?.requestedDomainId ?? null,
      effectiveDomainId: fullOrder?.effectiveDomainId ?? null,
      hasDeliveredFqdn: !!fullOrder?.domainValue && fullOrder.domainStatus === 'READY',
    });
    const fallbackHost = (server as { hostname?: string } | null)?.hostname ?? root.cnameTarget ?? 'localhost';
    const seed = ctx.order.customerName || fullOrder?.product.name || 'app';

    // GEL de la racine AVANT toute allocation DNS (#8/#16) — la « fenêtre de panne »
    // (racine résolue → DNS créé → crash avant persistence) ne peut plus JAMAIS faire
    // re-sélectionner une autre racine au retry : effectiveDomainId est figé d'abord.
    await write((tx) =>
      tx.order.update({
        where: { id: ctx.order.id },
        data: { effectiveDomainId: root.id },
      }),
    );

    // Récupération d'une allocation partielle antérieure (crash entre DNS et persist) :
    // si un enregistrement SOUS CETTE RACINE porte déjà le sous-domaine demandé, on le
    // réutilise (jamais de 2ᵉ record, jamais d'autre racine). 17B.4E-D-B1 (fix H) :
    // le ClientSubdomain est lié à la row Deployment DÈS qu'elle existe — l'ordre
    // CREATE_APP / CONFIGURE_DNS n'a plus d'importance.
    const existingDeployment = ctx.order.id
      ? await this.prisma.deployment.findUnique({
          where: { orderId: ctx.order.id },
          select: { id: true },
        })
      : null;
    let alloc: { subdomain: string; fqdn: string };
    if (fullOrder?.requestedSubdomain) {
      const fqdn = `${fullOrder.requestedSubdomain.trim().toLowerCase()}.${root.name}`;
      const existing = await this.prisma.clientSubdomain.findFirst({ where: { fqdn } });
      if (existing) {
        alloc = { subdomain: existing.subdomain, fqdn: existing.fqdn };
        // D3/C1 : ownership stricte — même row, update par id, domaine = racine figée.
        if (
          existingDeployment &&
          !existing.deploymentId &&
          existing.domainId === root.id
        ) {
          await this.linkClientSubdomainToDeployment(
            ctx.order.id,
            existing.fqdn,
            existingDeployment.id,
            root.id,
            existing.id,
            ctx.guard,
          );
        }
      } else {
        // `requested` déjà certifié disponible au checkout → allocation effective.
        alloc = await allocWithC4(
          { rootId: root.id, requested: fullOrder.requestedSubdomain, fallbackHost, seed },
          () =>
            this.cloudflare.allocateClientSubdomain({
              root,
              seed,
              fallbackHost,
              requested: fullOrder.requestedSubdomain ?? undefined,
              ...(existingDeployment ? { deploymentId: existingDeployment.id } : {}),
            }),
        );
      }
    } else {
      alloc = await allocWithC4(
        { rootId: root.id, fallbackHost, seed },
        () =>
          this.cloudflare.allocateClientSubdomain({
            root,
            seed,
            fallbackHost,
            ...(existingDeployment ? { deploymentId: existingDeployment.id } : {}),
          }),
      );
    }
    // Si la row n'existait pas au moment de l'alloc (CREATE_APP après DNS),
    // on la lie dès maintenant (D3 : ownership via racine figée root.id).
    await this.linkClientSubdomainToDeployment(
      ctx.order.id,
      alloc.fqdn,
      existingDeployment?.id ?? null,
      root.id,
      undefined,
      ctx.guard,
    );

    // Si l'app a déjà été créée, on pose le domaine dessus puis on redéploie
    // (best-effort) pour que le conteneur redémarre avec traefik relié au
    // sous-domaine client — sans ça, l'app n'est pas servie publiquement.
    if (ctx.appUuid && server && (server as { apiBaseUrl?: string | null }).apiBaseUrl) {
      try {
        const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
        const transport = this.panelFactory.create();
        await transport.setAppDomain(target, ctx.appUuid, alloc.fqdn);
        await transport.deployApp(target, ctx.appUuid);
      } catch {
        // best-effort — reposable en retry
      }
    }
    // On persiste via domainValue (Order), pas via Deployment. DNS et Coolify utilisent
    // la MÊME racine/FQDN (#16 : la racine effective a été figée et réutilisée partout).
    await write((tx) =>
      tx.order.update({
        where: { id: ctx.order.id },
        data: { domainType: 'FREE_SUBDOMAIN', domainValue: alloc.fqdn, domainStatus: 'READY' },
      }),
    );
    return { fqdn: alloc.fqdn, message: `Sous-domaine alloué : https://${alloc.fqdn}` };
  }

  private async sendDeliveryEmail(
    to: string,
    name: string,
    fqdn: string,
    orderId: string,
  ): Promise<void> {
    await this.mail.sendPlain({
      to,
      subject: 'Votre application est en ligne — Code Diali',
      text: [
        `Bonjour ${name},`,
        '',
        'Votre application est prête et en ligne 🎉.',
        '',
        `Accédez-y à l’adresse : https://${fqdn}`,
        '',
        'Vous pouvez aussi la retrouver, ainsi que votre abonnement et vos',
        `factures, dans votre espace client : ${clientAreaUrl()}`,
        '',
        `Commande : ${orderId}`,
        '',
        'Si vous avez la moindre question, répondez simplement à cet email.',
        '',
        'L’équipe Code Diali',
      ].join('\n'),
    });
    await this.audit.record({
      action: 'provision.delivery_email',
      resourceType: 'order',
      resourceId: orderId,
      details: { ok: true, fqdn },
    });
  }
}
