import { Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { HostingServiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { C4ProtocolService } from '../hosting/c4-protocol.service';
import { isHostingC4Enabled } from '../hosting/c4-flag';
import {
  PanelKind,
  PanelTarget,
  PanelTransportFactory,
} from '../servers/panel-transport.factory';

/**
 * Q5 (GO item 5) — CAS des HostingService DANS LA TRANSACTION du caller :
 * les services hébergement basculent avec l'abonnement qu'ils portent (jamais
 * ceux d'un autre abonnement du même client). Probe schéma préalable : base
 * pré-C1 sans table `HostingService` → skip silencieux (compat), jamais
 * d'erreur. Utilisé par la suspension automatique (RenewalService) ET par les
 * transitions admin (SubscriptionsService) pour que statut abonnement et statut
 * service ne divergent JAMAIS.
 *
 * Q12-P3 — résolution abonnement → service « réelle » : `subscriptionId` POSÉ
 * à la création C3 (checkout) MAIS nullable sur les lignes legacy (créées avant
 * le lien) — on match donc `subscriptionId = X` OU `orderId ∈ (ordres de
 * l'abonnement)`. Un service n'appartient qu'à SON abonnement (orderId est
 * unique 1:1, renouvellements/upgrade de la MÊME chaîne) : aucun service d'un
 * autre abonnement n'est touché.
 */
export async function applyHostingStatusInTx(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  from: HostingServiceStatus,
  to: HostingServiceStatus,
  orderIds: Array<string | null> = [],
): Promise<number> {
  const tables = await tx.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'HostingService'
    ) AS "exists"`;
  if (!tables[0]?.exists) return 0;
  const ownOrders = [...new Set(orderIds.filter((v): v is string => !!v))];
  const cas = await tx.hostingService.updateMany({
    where: {
      status: from,
      OR: [{ subscriptionId }, ...(ownOrders.length > 0 ? [{ orderId: { in: ownOrders } }] : [])],
    },
    data: { status: to },
  });
  return cas.count;
}

/**
 * Q5 (GO item 5 + GO commercial « suspension ») — effets provider de la
 * suspension ET de la réactivation d'une souscription.
 *
 * Contrats GO :
 *  - **Arrêt RÉVERSIBLE** des applications concernées via le protocole de
 *    transport existant (`PanelTransport.stopApplication`) — **aucune
 *    suppression de ressources ni de données** (jamais `deleteApplication`) ;
 *  - **Réactivation contrôlée** = relance (`startApplication`), sans double
 *    facturation (aucune écriture de facture ici) ;
 *  - **Résolution réelle (Q12-P3)** : abonnement → service via
 *    `subscriptionId`/`orderId` réels (lignes legacy sans lien comprises) ;
 *    service → apps via les **allocations persistantes** (modèle C2, `Deployment
 *    .hostingServiceId` NULL) en plus des liens directs — jamais « le dernier
 *    abonnement actif » du compte ;
 *  - **Respect du protocole C4 (Q12-P3)** : chaque dispatch est une tentative
 *    durable `CONFIGURE` sous ON (avec allocation de l'app : au plus un
 *    dispatch créatif ouvert par app — arrêt/reprise concurrents sur provider
 *    lent → second refusé explicitement) ; `beginDispatch` refuse si un arrêt
 *    est opposable (scopes ORDER/SERVICE/ALLOCATION/**DEPLOYMENT**) ou un
 *    créateur non résolu ; la consignation `settle` trace l'issue —
 *    **timeout/échec réseau = outcome `UNKNOWN`** (ambiguïté durable) ;
 *    **succès provider non consigné = JAMAIS `done`** (tentative laissée
 *    DISPATCHED) ; **sous OFF : AUCUN repli direct** pour les opérations
 *    couvertes (blocage `protocole_off` comptabilisé + audité, zéro appel
 *    réseau, aucune table C4 lue ni écrite) — le direct legacy est réservé aux
 *    opérations HORS protocole (jamais celles-ci) ;
 *  - **Barrières de décision (Q12-P3)** : la décision la PLUS RÉCENTE gagne —
 *    l'état de l'abonnement est revérifié LIVE avant toute préparation (aucune
 *    action préparée/émise après une suspension/réactivation concurrente,
 *    blocage `decision_perimee`) ; un passage ON→OFF pendant la préparation ne
 *    contourne rien (tentative consignée `REFUSED`, zéro appel suivant) ; une
 *    réponse reçue après un passage OFF reste consignée (`settle`
 *    inconditionnel) sans aucun appel suivant ;
 *  - **Capacité provider manquante** (panneau non Coolify, jeton illisible…) →
 *    blocage EXPLICITE comptabilisé (`blocked`) + audit, jamais de faux succès ;
 *  - **Échecs visibles et récupérables** : chaque échec/blocage est audité
 *    (`suspension.app_*`), le recompte est renvoyé à l'appelant (admin), et une
 *    nouvelle action rejoue l'effet — sauf sous C4 où une tentative encore
 *    ouverte/`UNKNOWN` bloque le re-dispatch (incertitude conservée, résolution
 *    par le support) ;
 *  - Jamais d'appel réseau dans la transaction métier (post-commit uniquement).
 */

export interface SuspensionEffectsSummary {
  /** Applications concernées (avec cible provider connue). */
  apps: number;
  /** Arrêts/relances réellement confirmés par le panneau. */
  done: number;
  /** Bloqués explicitement (capacité absente, arrêt/C4 opposable, sans cible). */
  blocked: number;
  /** Échecs visibles (réseau/HTTP) — récupérables par une nouvelle action. */
  failed: number;
  /** Classification de l'effet infra : protocole actif au DÉMARRAGE du passage. */
  mode: 'c4' | 'off';
}

function emptySummary(mode: 'c4' | 'off'): SuspensionEffectsSummary {
  return { apps: 0, done: 0, blocked: 0, failed: 0, mode };
}

type Op = 'stop' | 'start';

@Injectable()
export class SuspensionEffectsService {
  private readonly log = new Logger(SuspensionEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly c4: C4ProtocolService,
  ) {}

  /** Arrêt réversible des apps de la souscription (après CAS de suspension). */
  suspendApps(params: {
    subscriptionId: string;
    holder: string;
    orderId?: string | null;
  }): Promise<SuspensionEffectsSummary> {
    return this.run('stop', params);
  }

  /** Relance des apps de la souscription (après CAS de réactivation). */
  resumeApps(params: {
    subscriptionId: string;
    holder: string;
    orderId?: string | null;
  }): Promise<SuspensionEffectsSummary> {
    return this.run('start', params);
  }

  // ──────────────────────────── moteur ──────────────────────────────────────

  /**
   * Q12-P3 — résolution « réelle » :
   *  - abonnement → service : `subscriptionId` (posé à la création C3) OU
   *    `orderId` des ordres de l'abonnement (lignes legacy sans lien) ;
   *  - service → apps : allocations persistantes `HostingServiceAllocation`
   *    (modèle C2 : `Deployment.hostingServiceId` reste NULL « transition »),
   *    puis les liens directs (`hostingServiceId` / `orderId`) en complément.
   *    Aucun réseau dans le scan — seuls les déploiements à `coolifyUuid`
   *    non null rattachés au SEUL abonnement demandé sont considérés.
   */
  private async run(
    op: Op,
    params: { subscriptionId: string; holder: string; orderId?: string | null },
  ): Promise<SuspensionEffectsSummary> {
    const mode: 'c4' | 'off' = isHostingC4Enabled() ? 'c4' : 'off';
    const sub = await this.prisma.subscription.findUnique({
      where: { id: params.subscriptionId },
      select: { orderId: true },
    });
    const subOrderIds = [
      ...new Set(
        [sub?.orderId ?? null, params.orderId ?? null].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    const services = await this.prisma.hostingService.findMany({
      where: {
        OR: [
          { subscriptionId: params.subscriptionId },
          ...(subOrderIds.length > 0 ? [{ orderId: { in: subOrderIds } }] : []),
        ],
      },
      select: { id: true, orderId: true },
    });
    if (services.length === 0) return emptySummary(mode);
    const serviceIds = services.map((s) => s.id);
    const orderIds = [
      ...new Set(
        [...services.map((s) => s.orderId), ...subOrderIds].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    const allocations = await this.prisma.hostingServiceAllocation.findMany({
      where: { hostingServiceId: { in: serviceIds }, deploymentId: { not: null } },
      select: { deploymentId: true },
    });
    const allocatedDepIds = [
      ...new Set(
        allocations.map((a) => a.deploymentId).filter((v): v is string => !!v),
      ),
    ];
    const deps = await this.prisma.deployment.findMany({
      where: {
        coolifyUuid: { not: null },
        OR: [
          ...(allocatedDepIds.length > 0 ? [{ id: { in: allocatedDepIds } }] : []),
          { hostingServiceId: { in: serviceIds } },
          ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ],
      },
      select: {
        id: true,
        orderId: true,
        coolifyUuid: true,
        server: true,
        hostingServiceId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const summary: SuspensionEffectsSummary = {
      apps: deps.length,
      done: 0,
      blocked: 0,
      failed: 0,
      mode,
    };
    for (const dep of deps) {
      const outcome = await this.dispatchOne(op, {
        deploymentId: dep.id,
        orderId: dep.orderId ?? params.orderId ?? subOrderIds[0] ?? null,
        uuid: dep.coolifyUuid!,
        server: dep.server,
        holder: params.holder,
        subscriptionId: params.subscriptionId,
        hostingServiceId: dep.hostingServiceId,
      });
      if (outcome === 'done') summary.done += 1;
      else if (outcome === 'blocked') summary.blocked += 1;
      else summary.failed += 1;
    }
    if (deps.length > 0) {
      await this.bestEffortAudit({
        action: op === 'stop' ? 'suspension.apps_stopped' : 'suspension.apps_started',
        resourceType: 'subscription',
        resourceId: params.subscriptionId,
        details: { ...summary, holder: params.holder, c4: isHostingC4Enabled() },
      });
    }
    return summary;
  }

  private async dispatchOne(
    op: Op,
    p: {
      deploymentId: string;
      orderId: string | null;
      uuid: string;
      server: {
        panelProvider: string | null;
        apiBaseUrl: string | null;
        apiTokenEnc: string | null;
        strictTls: boolean;
      } | null;
      holder: string;
      subscriptionId: string;
      hostingServiceId: string | null;
    },
  ): Promise<'done' | 'blocked' | 'failed'> {
    // ── Décision la PLUS RÉCENTE gagne (Q12-P3) : revérification LIVE ──────
    // Une suspension/réactivation concurrente committée pendant la boucle
    // rend l'effet périmé : aucune préparation, aucun appel, blocage visible.
    // LECTURE D'ENTRÉE = chemin rapide seulement : entre elle et l'enregistre-
    // ment de la tentative, des await (résolution allocation, file C4…) lais-
    // saient une fenêtre — l'AUTORITÉ est le garde `freshnessGuard` EXÉCUTÉ
    // SOUS VERROU dans la transaction de la tentative (GO fenêtres R2).
    const fresh = await this.prisma.subscription.findUnique({
      where: { id: p.subscriptionId },
      select: { status: true },
    });
    const expected = op === 'stop' ? 'SUSPENDED' : 'ACTIVE';
    if (fresh?.status !== expected) {
      return this.recordBlock(
        op,
        p,
        'decision_perimee',
        `Abonnement ${fresh?.status ?? 'introuvable'} (décision plus récente) ≠ ${expected} : aucun appel émis.`,
      );
    }

    // ── Cible provider : capacité préalable, sinon blocage explicite ────────
    if (!p.server || !p.server.apiBaseUrl || !p.server.apiTokenEnc) {
      return this.recordBlock(op, p, 'sans_cible', 'Serveur panneau non configuré pour cette application.');
    }
    let target: PanelTarget;
    try {
      target = {
        provider: (p.server.panelProvider ?? 'COOLIFY') as PanelKind,
        baseUrl: p.server.apiBaseUrl,
        token: this.crypto.decrypt(p.server.apiTokenEnc),
        user: null,
        strictTls: p.server.strictTls,
      };
    } catch {
      return this.recordBlock(op, p, 'jeton_indefin', 'Jeton API panneau indéchiffrable (ENCRYPTION_KEY ?).');
    }

    // ── OFF : AUCUN repli direct (opération couverte par le protocole) ──────
    // Q12-P3 : le contrat historique « appel direct sous OFF » est aboli pour
    // stop/start de suspension : zéro appel réseau, zéro table C4, blocage
    // `protocole_off` comptabilisé + audité (le direct reste réservé aux
    // opérations HORS protocole).
    if (!isHostingC4Enabled()) {
      return this.recordBlock(
        op,
        p,
        'protocole_off',
        'Protocole C4 désactivé : appel provider non émis (aucun repli direct).',
      );
    }

    // ── C4 : tentative durable AVANT le dispatch ────────────────────────────
    // Q12-P3 : la tentative porte l'allocation de l'app (modèle C2) — la garde
    // « au plus une tentative de création ouverte par allocation » serialize
    // alors un arrêt et une reprise CONCURRENTS sur un provider lent (le
    // second dispatch est refusé explicitement, jamais de course provider).
    // Le scope SERVICE porteur est ajouté aux scopes opposables : un arrêt sur
    // le service (au-delà du scope DEPLOYMENT) refuse le dispatch.
    let attemptId: string | null = null;
    try {
      const allocation = await this.prisma.hostingServiceAllocation.findFirst({
        where: { deploymentId: p.deploymentId },
        select: { id: true, hostingServiceId: true },
      });
      const ticket = await this.c4.beginDispatchStandalone({
        nature: 'CONFIGURE',
        scope: { type: 'DEPLOYMENT', id: p.deploymentId },
        allocationId: allocation?.id ?? null,
        holder: p.holder,
        orderId: p.orderId,
        serviceId: allocation?.hostingServiceId ?? p.hostingServiceId,
        targetIntent: { type: 'application', op, uuid: p.uuid },
        // GO fenêtres R2 : la décision est revérifiée SOUS VERROU `FOR
        // UPDATE` DANS la transaction qui enregistre la tentative — bloquée
        // avant cette enregistrement, une décision périmée (réactivation
        // concurrente committée entre la lecture d'entrée et la tentative)
        // est refusée ici, jamais convertie en appel. La sérialisation est
        // commune avec les transitions de l'abonnement (même verrou de
        // ligne) ; les opérations DÉJÀ EN VOL (tentative durable) continuent
        // et se consignent, celles non encore autorisées n'entrent jamais.
        freshnessGuard: { subscriptionId: p.subscriptionId, expected },
      });
      attemptId = ticket.attemptId;
    } catch (err) {
      // Refus C4 (arrêt opposable, tentative déjà ouverte, créateur non
      // résolu…) → blocage explicite de CET action, les autres corrections
      // continuent. Décision périmée détectée sous verrou dans la tx de
      // tentative → même raison `decision_perimee` que la lecture d'entrée.
      const msg = err instanceof Error ? err.message : String(err);
      const conflict = err instanceof ConflictException;
      if (conflict) {
        const stale = msg.startsWith('decision_perimee');
        return this.recordBlock(op, p, stale ? 'decision_perimee' : 'c4_refuse', msg);
      }
      // Erreur inattendue (schéma, DB) : pas de faux succès, échec visible.
      return this.recordFail(op, p, msg, 'failed');
    }

    // ── ON→OFF pendant la préparation : AUCUN contournement ────────────────
    // La tentative émise sous ON est consignée `REFUSED` (terminale sûre) et
    // l'appel réseau n'a JAMAIS lieu — aucun dispatch direct de repli.
    if (!isHostingC4Enabled()) {
      if (attemptId) {
        await this.c4
          .settleStandalone({ attemptId, holder: p.holder, outcome: 'REFUSED' })
          .catch((e) =>
            this.log.warn(`settle REFUSED ${op} dep=${p.deploymentId} failed: ${String(e)}`),
          );
      }
      return this.recordBlock(
        op,
        p,
        'protocole_off',
        'Protocole C4 désactivé pendant la préparation : tentative consignée REFUSED, aucun appel émis.',
      );
    }

    // ── Dispatch transport (post-commit, jamais dans la TX métier) ──────────
    // Une réponse reçue APRÈS un passage OFF reste consignée ci-dessous
    // (consignation limitée) ; le PROCHAIN dispatch est alors bloqué par la
    // garde `protocole_off` ci-dessus — aucun appel suivant.

    // ── Dispatch transport (post-commit, jamais dans la TX métier) ──────────
    try {
      const transport = this.panelFactory.create();
      if (op === 'stop') await transport.stopApplication(target, p.uuid);
      else await transport.startApplication(target, p.uuid);
      if (attemptId) {
        try {
          await this.c4.settleStandalone({ attemptId, holder: p.holder, outcome: 'SUCCESS' });
        } catch (e) {
          // Succès provider NON consigné (TX de settle annulée) : la tentative
          // reste DISPATCHED (incertitude conservée par contrat C4) et JAMAIS
          // ce succès n'est requalifié `done` — échec visible + audité.
          this.log.warn(`settle SUCCESS ${op} dep=${p.deploymentId} failed: ${String(e)}`);
          return this.recordFail(
            op,
            p,
            'Succès provider non consigné (consignation en échec) — tentative laissée ouverte.',
            'failed',
          );
        }
      }
      return 'done';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Capacité provider manquante (ex. panneau non Coolify) → PERMANENT :
      // bloqué explicitement, jamais présenté comme réussi.
      const capability =
        /non disponible pour ce fournisseur|Coolify uniquement/i.test(msg) ||
        /indéchiffrable|ENCRYPTION_KEY/i.test(msg);
      if (attemptId) {
        // Q12-P3 : timeout/échec réseau = RÉSULTAT AMBIGU (pas de preuve
        // d'échec définitif) → outcome `UNKNOWN` durable (modèle C4 des
        // dispatchs deployments/provisioning) ; capacité absente = échec
        // connu → `PERMANENT_FAILURE`. Si la settle échoue elle-même, la
        // tentative reste DISPATCHED (incertitude toujours conservée).
        await this.c4
          .settleStandalone({
            attemptId,
            holder: p.holder,
            outcome: capability ? 'PERMANENT_FAILURE' : 'UNKNOWN',
          })
          .catch((e) =>
            this.log.warn(`settle ${op} dep=${p.deploymentId} failed: ${String(e)}`),
          );
      }
      if (capability) return this.recordBlock(op, p, 'capacite_absente', msg);
      return this.recordFail(op, p, msg, 'failed');
    }
  }

  // ──────────────────────────── journalisation ─────────────────────────────

  private async recordBlock(
    op: Op,
    p: { deploymentId: string; holder: string },
    reason: string,
    detail: string,
  ): Promise<'blocked'> {
    await this.bestEffortAudit({
      action: op === 'stop' ? 'suspension.app_stop_blocked' : 'suspension.app_start_blocked',
      resourceType: 'deployment',
      resourceId: p.deploymentId,
      details: { reason, detail, holder: p.holder },
    });
    return 'blocked';
  }

  private async recordFail(
    op: Op,
    p: { deploymentId: string; holder: string },
    detail: string,
    kind: 'failed',
  ): Promise<typeof kind> {
    await this.bestEffortAudit({
      action: op === 'stop' ? 'suspension.app_stop_failed' : 'suspension.app_start_failed',
      resourceType: 'deployment',
      resourceId: p.deploymentId,
      details: { detail, holder: p.holder, kind },
    });
    return kind;
  }

  /** Audit best-effort : un échec de journalisation n'annule jamais l'effet. */
  private async bestEffortAudit(entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    details: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.audit.record(entry);
    } catch (e) {
      this.log.warn(`audit ${entry.action} failed: ${String(e)}`);
    }
  }
}
