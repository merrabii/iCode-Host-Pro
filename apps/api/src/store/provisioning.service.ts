import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DeploymentStatus,
  LimitsStatus,
  OrderStatus,
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
  ) {}

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

  private async openStep(orderId: string, step: string): Promise<string> {
    const row = await this.prisma.provisioningLog.create({
      data: { orderId, step, status: ProvisioningStepStatus.RUNNING },
    });
    return row.id;
  }

  private async closeStep(id: string, status: ProvisioningStepStatus, message: string | null): Promise<void> {
    await this.prisma.provisioningLog.update({ where: { id }, data: { status, message } });
  }

  private async setOrderStatus(orderId: string, status: OrderStatus, note: string): Promise<void> {
    await this.prisma.order.update({ where: { id: orderId }, data: { status } });
    await this.prisma.orderStatusHistory.create({ data: { orderId, status, note } });
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
      outcome = await this.prisma.$transaction(async (tx) => {
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
      });
    } catch (e) {
      this.log.warn(`activateOrderAfterProof order=${orderId} rollback: ${String(e)}`);
      throw e;
    }

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
  }): Promise<{ appUuid?: string; message?: string }> {
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
      | { id: string; coolifyUuid: string | null; detail: string | null; status: string }
      | null = null;
    if (ctx.appUuid) {
      row = await this.prisma.deployment.findFirst({
        where: { coolifyUuid: ctx.appUuid },
        select: { id: true, coolifyUuid: true, detail: true, status: true },
      });
    }
    if (!row && ctx.order?.id) {
      row = await this.prisma.deployment.findFirst({
        where: { orderId: ctx.order.id },
        select: { id: true, coolifyUuid: true, detail: true, status: true },
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
      const created = await transport.createGitApp(target, {
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
      appUuid = created.uuid;
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
    if (row && userId) {
      await this.prisma.deployment.update({
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
          ...(ctx.fqdn ? { fqdn: ctx.fqdn } : {}),
        },
      });
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
      const effStore = resolveEffectiveLimits(
        fullOrder?.product.pack as { ramMb: number; cpuCores: number; storageLimit: number | null } | null | undefined,
        mod,
      );
      const createdRow = await this.prisma.deployment.create({
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
      });
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
  }): Promise<{ fqdn?: string; message?: string }> {
    if (ctx.fqdn) return { fqdn: ctx.fqdn, message: `Sous-domaine déjà alloué : https://${ctx.fqdn}` };
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
    await this.prisma.order.update({
      where: { id: ctx.order.id },
      data: { effectiveDomainId: root.id },
    });

    // Récupération d'une allocation partielle antérieure (crash entre DNS et persist) :
    // si un enregistrement SOUS CETTE RACINE porte déjà le sous-domaine demandé, on le
    // réutilise (jamais de 2ᵉ record, jamais d'autre racine). Store: pas de Deployment
    // row — ClientSubdomain sans deploymentId.
    let alloc: { subdomain: string; fqdn: string };
    if (fullOrder?.requestedSubdomain) {
      const fqdn = `${fullOrder.requestedSubdomain.trim().toLowerCase()}.${root.name}`;
      const existing = await this.prisma.clientSubdomain.findFirst({ where: { fqdn } });
      if (existing) {
        alloc = { subdomain: existing.subdomain, fqdn: existing.fqdn };
      } else {
        // `requested` déjà certifié disponible au checkout → allocation effective.
        alloc = await this.cloudflare.allocateClientSubdomain({
          root,
          seed,
          fallbackHost,
          requested: fullOrder.requestedSubdomain,
        });
      }
    } else {
      alloc = await this.cloudflare.allocateClientSubdomain({ root, seed, fallbackHost });
    }

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
    await this.prisma.order.update({
      where: { id: ctx.order.id },
      data: { domainType: 'FREE_SUBDOMAIN', domainValue: alloc.fqdn, domainStatus: 'READY' },
    });
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
