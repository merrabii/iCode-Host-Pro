import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceStatus, OrderStatus, Prisma, SubscriptionStatus, HostingServiceAllocationStatus, HostingServiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { PanelKind, PanelTarget, PanelTransportFactory } from '../servers/panel-transport.factory';
import { isHostingC4Enabled } from '../hosting/c4-flag';
import { C4CapabilityService } from '../hosting/c4-capability.service';
import { C4ProtocolService, C4Scope } from '../hosting/c4-protocol.service';
import {
  C4AppOutcome,
  C4DnsOutcome,
  C4ReleaseService,
  C4ReleaseResult,
} from '../hosting/c4-release.service';

/** Résultat d'une opération externe (provider ou DNS) sur cancel/terminate. */
export type ExternalCleanup = 'deleted' | 'absent' | 'skipped' | 'failed' | 'unknown';

/** Résultat d'une row locale après confirmation externe. */
export type LocalCleanup = 'deleted' | 'kept' | 'absent';

/** Appartenance du ClientSubdomain à CETTE commande (D3 + ownership complet). */
export type CsOwnership =
  | 'exact'
  | 'legacy_proven'
  | 'ambiguous'
  | 'foreign'
  | 'absent';

export interface CancelProvisioningResult {
  orderId: string;
  orderStatus: OrderStatus;
  alreadyCancelled: boolean;
  provider: ExternalCleanup;
  dns: ExternalCleanup;
  deployment: LocalCleanup;
  clientSubdomain: LocalCleanup;
  /** Lecture seule B1 — jamais d'écriture Invoice (politique comptable). */
  invoice: string;
  subscription: 'cancelled' | 'already_cancelled' | 'absent';
  partial: boolean;
  /** 17B.4F-C4 (sous ON uniquement) : état du service + libérations d'allocations. */
  c4?: C4CancelC4;
}

/** Synthèse C4 d'un cancel/terminate (additive, absente sous OFF). */
export interface C4CancelC4 {
  serviceStatus: string | null;
  releases: Array<{
    allocationId: string;
    status: C4ReleaseResult['status'];
    blockedReason?: string;
  }>;
}

/**
 * 17B.4E-E2-B — résultat stable de la terminaison d'un service actif.
 * `project` est TOUJOURS `retained` (pas de suppression de projet en E2-B ;
 * GC / projet par service = 17B.4F).
 */
export interface TerminateActiveServiceResult {
  orderId: string;
  orderStatus: OrderStatus;
  alreadyTerminated: boolean;
  provider: ExternalCleanup;
  dns: ExternalCleanup;
  deployment: LocalCleanup;
  clientSubdomain: LocalCleanup;
  /** Lecture seule — PAID reste PAID, aucun remboursement automatique. */
  invoice: string;
  subscription: 'cancelled' | 'already_cancelled' | 'absent';
  project: 'retained';
  partial: boolean;
  /** 17B.4F-C4 (sous ON uniquement) : état du service + libérations d'allocations. */
  c4?: C4CancelC4;
}

interface CancelActor {
  sub: string;
  email: string;
}

interface OrderGateRow {
  id: string;
  status: OrderStatus;
  domainValue: string | null;
  effectiveDomainId: string | null;
  requestedDomainId: string | null;
  /** Owner Order → Customer → User (nullable en schéma). */
  customerUserId: string | null;
}

interface ResolvedCs {
  cs: {
    id: string;
    fqdn: string;
    domainId: string;
    recordId: string | null;
    deploymentId: string | null;
  } | null;
  ownership: CsOwnership;
}

/** Issue partagée des phases provider/DNS/local/Subscription/Invoice. */
interface CleanupOutcome {
  provider: ExternalCleanup;
  dns: ExternalCleanup;
  deploymentLocal: LocalCleanup;
  csLocal: LocalCleanup;
  subscription: 'cancelled' | 'already_cancelled' | 'absent';
  invoiceLabel: string;
  ownership: CsOwnership;
  partial: boolean;
  /** 17B.4F-C4 : un recordId existait-il au moment du run (DNS créé) ? */
  dnsHadRecord: boolean;
  /** 17B.4F-C4 : identifiants connus AVANT nettoyage (preuve par ressource). */
  appIdentifier: string | null;
  dnsIdentifier: string | null;
}

/**
 * Heuristique provider/DNS-agnostique : « ressource déjà absente ».
 * Aucun vocabulaire Coolify/Cloudflare métier — uniquement des patterns
 * d'erreur génériques (HTTP 404, not found, introuvable…).
 * Classification uniquement : le message n'est JAMAIS transmis au Logger (D5).
 */
export function isAbsentExternalError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /\b404\b/i.test(msg) ||
    /not found/i.test(msg) ||
    /does not exist/i.test(msg) ||
    /introuvable/i.test(msg) ||
    /n'existe pas/i.test(msg) ||
    /record does not exist/i.test(msg)
  );
}

/**
 * 17B.4E-D-B1 — annulation générique d'un provisioning Store incomplet.
 *
 * Contrat (addendum B0 + corrections D1–D5) :
 *   • gate : Order PROVISIONING (cancel) ou CANCELLED (rejeu idempotent) ; sinon 409 ;
 *   • D1 : CAS + OrderStatusHistory + reconcileNextAt=null dans UNE transaction ;
 *   • D2 : CS sans domainId/recordId → dns=unknown, row conservée, partial=true ;
 *   • D3 : appartenance CS par deploymentId exact, puis fallback legacy prouvé
 *     (fqdn + domainId + owner Customer.userId ↔ Deployment.userId) ; sans
 *     preuve d'ownership → ambiguous/foreign, row conservée ;
 *   • C2 : Deployment sans resourceId opaque → provider=unknown, row conservée ;
 *   • D5 : Logger.warn/error strictement statiques (jamais String(e)/message/name) ;
 *   • Invoice JAMAIS modifiée ; Subscription par orderId exact ;
 *   • provider via PanelTransport (resourceId opaque) ;
 *   • row locale supprimée SEULEMENT si externe confirmé ET appartenance prouvée.
 *
 * 17B.4E-E2-B — `terminateActiveService` partage le MÊME moteur de cleanup
 * (`performCleanup`) sans changer le contrat de `cancel-provisioning`.
 * Aucun ID de candidat 17B.4E dans ce code.
 */
@Injectable()
export class OrderCancelService {
  private readonly log = new Logger(OrderCancelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly cloudflare: CloudflareService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly c4: C4ProtocolService,
    private readonly c4c: C4CapabilityService,
    private readonly c4r: C4ReleaseService,
  ) {}

  async cancelProvisioning(
    orderId: string,
    reason: string,
    actor: CancelActor,
  ): Promise<CancelProvisioningResult> {
    const trimmed = this.assertReason(reason);

    // 17B.4F-C4 : prérequis LIVE sous ON (503 avant toute mutation) + garde
    // relue à l'appel (OFF = contrat historique strictement inchangé).
    await this.c4c.assertOperational();
    const c4Enabled = isHostingC4Enabled();

    // ── Phase 0 : lecture gate (aucune mutation) ──
    const order = await this.loadOrderGate(orderId);
    if (order.status !== OrderStatus.PROVISIONING && order.status !== OrderStatus.CANCELLED) {
      throw new ConflictException(
        `Annulation du provisioning impossible depuis le statut ${order.status} (PROVISIONING ou CANCELLED uniquement).`,
      );
    }
    const orderGate: OrderGateRow = { ...order };

    let alreadyCancelled = false;

    // ── Phase 1 (D1) : CAS + history + reconcileNextAt dans UNE transaction ──
    if (order.status === OrderStatus.PROVISIONING) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const won = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PROVISIONING },
          data: { status: OrderStatus.CANCELLED },
        });
        if (won.count === 1) {
          // 17B.4F-C4 : arrêt (scopes Order/Service/Allocation/Deployment) +
          // service → CANCELLATION_PENDING sous verrous, DANS LA MÊME tx que
          // le CAS, AVANT le moindre dispatch de nettoyage.
          if (c4Enabled) await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              status: OrderStatus.CANCELLED,
              note: trimmed,
              actorId: actor.sub,
              actorEmail: actor.email,
            },
          });
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
          return { kind: 'cancelled' as const };
        }
        // CAS perdu : relecture DANS la transaction.
        const re = await this.readGateInTx(tx, orderId);
        if (re.status === OrderStatus.CANCELLED) {
          // Rejeu idempotent : neutralise aussi l'éligibilité runner + arrêts.
          if (c4Enabled) await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
          return { kind: 'replay' as const, order: re };
        }
        // Activation (ou autre transition) gagnée → 409, zéro écriture de cleanup.
        throw new ConflictException(
          `Course perdue face à une transition concurrente (statut actuel ${re.status}).`,
        );
      });
      if (outcome.kind === 'cancelled') {
        orderGate.status = OrderStatus.CANCELLED;
      } else {
        alreadyCancelled = true;
        Object.assign(orderGate, outcome.order);
      }
    } else {
      // Déjà CANCELLED au gate : neutralisation idempotente avant rejeu cleanup.
      alreadyCancelled = true;
      if (c4Enabled) {
        await this.prisma.$transaction(async (tx) => {
          await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
        });
      } else {
        await this.prisma.deployment.updateMany({
          where: { orderId },
          data: { reconcileNextAt: null },
        });
      }
    }

    const cleanup = await this.performCleanup(orderGate, actor, 'cancel');

    // ── 17B.4F-C4 : libérations d'allocations sous preuves suffisantes + ────
    //    terminal CANCELLED du service (seul si TOUTES les allocations sont
    //    RELEASED et le nettoyage concluant) ; sinon CANCELLATION_PENDING.
    let c4Summary: C4CancelC4 | undefined;
    if (c4Enabled) {
      c4Summary = await this.c4AttemptReleases(orderId, actor, cleanup);
      if (c4Summary.releases.some((r) => r.status === 'blocked')) cleanup.partial = true;
    }

    // ── Phase 6 : audit (détails métier contrôlés — pas d'exception brute) ──
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'order.cancel_provisioning',
      resourceType: 'order',
      resourceId: orderId,
        details: {
          reason: trimmed,
          orderJustCancelled: !alreadyCancelled,
          alreadyCancelled,
          provider: cleanup.provider,
          dns: cleanup.dns,
          deployment: cleanup.deploymentLocal,
          clientSubdomain: cleanup.csLocal,
          csOwnership: cleanup.ownership,
          invoice: cleanup.invoiceLabel,
          invoicePolicy: 'no_auto_change_b1',
          subscription: cleanup.subscription,
          partial: cleanup.partial,
          ...(c4Summary ? { c4: c4Summary } : {}),
        } as unknown as Prisma.InputJsonValue,
    });

    return {
      orderId,
      orderStatus: OrderStatus.CANCELLED,
      alreadyCancelled,
      provider: cleanup.provider,
      dns: cleanup.dns,
      deployment: cleanup.deploymentLocal,
      clientSubdomain: cleanup.csLocal,
      invoice: cleanup.invoiceLabel,
      subscription: cleanup.subscription,
      partial: cleanup.partial,
      ...(c4Summary ? { c4: c4Summary } : {}),
    };
  }

  /**
   * 17B.4E-E2-B — terminaison idempotente d'un service DÉJÀ ACTIVÉ.
   *
   * Séparation métier (figée) :
   *   • PROVISIONING → `cancel-provisioning` (409 ici + indication) ;
   *   • ACTIVE → première terminaison (CAS ACTIVE→CANCELLED) ;
   *   • CANCELLED → rejeu idempotent (`alreadyTerminated=true`) ;
   *   • SUSPENDED/PENDING/PAID/REFUNDED/autres → 409
   *     (audit : `Order.SUSPENDED` n'est JAMAIS écrit en production — la
   *     suspension réelle est `SubscriptionStatus.SUSPENDED`).
   *
   * Politique post-terminaison :
   *   • Order → CANCELLED + UNE seule OrderStatusHistory ;
   *   • `Deployment.reconcileNextAt=null` dans la MÊME tx que le CAS
   *     (neutralise toute activation/réconciliation tardive) ;
   *   • Subscription par `orderId` exact → CANCELLED ;
   *   • Invoice lecture seule (PAID reste PAID, aucun remboursement) ;
   *   • Deployment supprimé SEULEMENT si provider deleted/absent confirmé ;
   *   • DNS supprimé SEULEMENT si ownership prouvé + deleted/absent confirmé ;
   *   • ClientSubdomain supprimé SEULEMENT si DNS confirmé ET ownership prouvé ;
   *   • ClientProject + projet Coolify TOUJOURS conservés (`project=retained`)
   *     — projet partagé client/serveur, GC = 17B.4F.
   *
   * Idempotence rejeu : pas de 2e transition ni 2e history ; rejoue UNIQUEMENT
   * les restes externes/locaux conservés ; `alreadyTerminated=true`.
   */
  async terminateActiveService(
    orderId: string,
    reason: string,
    actor: CancelActor,
  ): Promise<TerminateActiveServiceResult> {
    const trimmed = this.assertReason(reason);

    // 17B.4F-C4 : prérequis LIVE sous ON (503 avant toute mutation) + garde
    // relue à l'appel (OFF = contrat historique strictement inchangé).
    await this.c4c.assertOperational();
    const c4Enabled = isHostingC4Enabled();

    // ── Phase 0 : gate (lecture seule) ──
    const order = await this.loadOrderGate(orderId);
    if (order.status === OrderStatus.PROVISIONING) {
      throw new ConflictException(
        'Terminaison impossible sur un Order PROVISIONING — utilisez cancel-provisioning.',
      );
    }
    if (order.status !== OrderStatus.ACTIVE && order.status !== OrderStatus.CANCELLED) {
      throw new ConflictException(
        `Terminaison impossible depuis le statut ${order.status} (ACTIVE ou CANCELLED uniquement).`,
      );
    }
    const orderGate: OrderGateRow = { ...order };

    let alreadyTerminated = false;

    // ── Phase 1 : CAS ACTIVE→CANCELLED + history + reconcileNextAt (UNE tx) ──
    if (order.status === OrderStatus.ACTIVE) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const won = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.ACTIVE },
          data: { status: OrderStatus.CANCELLED },
        });
        if (won.count === 1) {
          // 17B.4F-C4 : arrêt + service → CANCELLATION_PENDING sous verrous,
          // DANS LA MÊME tx que le CAS, AVANT le moindre dispatch de nettoyage.
          if (c4Enabled) await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              status: OrderStatus.CANCELLED,
              note: trimmed,
              actorId: actor.sub,
              actorEmail: actor.email,
            },
          });
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
          return { kind: 'terminated' as const };
        }
        // CAS perdu : relecture DANS la transaction.
        const re = await this.readGateInTx(tx, orderId);
        if (re.status === OrderStatus.CANCELLED) {
          // Concurrent terminate a gagné → rejeu idempotent, zéro 2e history.
          if (c4Enabled) await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
          return { kind: 'replay' as const, order: re };
        }
        // Autre transition concurrente → 409, zéro écriture de cleanup.
        throw new ConflictException(
          `Course perdue face à une transition concurrente (statut actuel ${re.status}).`,
        );
      });
      if (outcome.kind === 'terminated') {
        orderGate.status = OrderStatus.CANCELLED;
      } else {
        alreadyTerminated = true;
        Object.assign(orderGate, outcome.order);
      }
    } else {
      // Déjà CANCELLED au gate : rejeu idempotent.
      alreadyTerminated = true;
      if (c4Enabled) {
        await this.prisma.$transaction(async (tx) => {
          await this.c4MarkStops(tx, orderId, trimmed, actor.sub);
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
        });
      } else {
        await this.prisma.deployment.updateMany({
          where: { orderId },
          data: { reconcileNextAt: null },
        });
      }
    }

    const cleanup = await this.performCleanup(orderGate, actor, 'terminate');

    // ── 17B.4F-C4 : libérations sous preuves + terminal CANCELLED du service ─
    let c4Summary: C4CancelC4 | undefined;
    if (c4Enabled) {
      c4Summary = await this.c4AttemptReleases(orderId, actor, cleanup);
      if (c4Summary.releases.some((r) => r.status === 'blocked')) cleanup.partial = true;
    }

    // ── Audit append-only (un par appel — ADR-019) ──
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'order.terminate_active_service',
      resourceType: 'order',
      resourceId: orderId,
        details: {
          reason: trimmed,
          orderJustTerminated: !alreadyTerminated,
          alreadyTerminated,
          provider: cleanup.provider,
          dns: cleanup.dns,
          deployment: cleanup.deploymentLocal,
          clientSubdomain: cleanup.csLocal,
          csOwnership: cleanup.ownership,
          invoice: cleanup.invoiceLabel,
          invoicePolicy: 'no_auto_refund_e2b',
          subscription: cleanup.subscription,
          project: 'retained',
          partial: cleanup.partial,
          ...(c4Summary ? { c4: c4Summary } : {}),
        } as unknown as Prisma.InputJsonValue,
    });

    return {
      orderId,
      orderStatus: OrderStatus.CANCELLED,
      alreadyTerminated,
      provider: cleanup.provider,
      dns: cleanup.dns,
      deployment: cleanup.deploymentLocal,
      clientSubdomain: cleanup.csLocal,
      invoice: cleanup.invoiceLabel,
      subscription: cleanup.subscription,
      project: 'retained',
      partial: cleanup.partial,
      ...(c4Summary ? { c4: c4Summary } : {}),
    };
  }

  // ─────────────────────────── moteur partagé (B1 + E2-B) ───────────────────

  private assertReason(reason: string): string {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 8) {
      throw new ConflictException('Le motif d’annulation doit faire au moins 8 caractères.');
    }
    return trimmed;
  }

  private async loadOrderGate(orderId: string): Promise<OrderGateRow> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        domainValue: true,
        effectiveDomainId: true,
        requestedDomainId: true,
        customer: { select: { userId: true } },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    return this.toGateRow(order);
  }

  private toGateRow(order: {
    id: string;
    status: OrderStatus;
    domainValue: string | null;
    effectiveDomainId: string | null;
    requestedDomainId: string | null;
    customer?: { userId: string | null } | null;
  }): OrderGateRow {
    return {
      id: order.id,
      status: order.status,
      domainValue: order.domainValue,
      effectiveDomainId: order.effectiveDomainId,
      requestedDomainId: order.requestedDomainId,
      customerUserId: order.customer?.userId ?? null,
    };
  }

  private async readGateInTx(
    tx: {
      order: {
        findUnique: (args: {
          where: { id: string };
          select: {
            id: true;
            status: true;
            domainValue: true;
            effectiveDomainId: true;
            requestedDomainId: true;
            customer: { select: { userId: true } };
          };
        }) => Promise<{
          id: string;
          status: OrderStatus;
          domainValue: string | null;
          effectiveDomainId: string | null;
          requestedDomainId: string | null;
          customer: { userId: string | null } | null;
        } | null>;
      };
    },
    orderId: string,
  ): Promise<OrderGateRow> {
    const re = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        domainValue: true,
        effectiveDomainId: true,
        requestedDomainId: true,
        customer: { select: { userId: true } },
      },
    });
    if (!re) throw new NotFoundException('Commande introuvable.');
    return this.toGateRow(re);
  }

  /**
   * Phases 2–5 partagées (provider, DNS, rows locales, Subscription, Invoice)
   * entre cancel-provisioning (B1) et terminate (E2-B).
   * `logPrefix` est un littéral ferme ('cancel' | 'terminate') — D5 : les
   * Logger.warn restent strictement statiques.
   */
  private async performCleanup(
    orderGate: OrderGateRow,
    actor: CancelActor,
    logPrefix: 'cancel' | 'terminate',
  ): Promise<CleanupOutcome> {
    const orderId = orderGate.id;

    // ── Phase 2 : rows pour cleanup externe ──
    const deployment = await this.prisma.deployment.findUnique({
      where: { orderId },
      include: { server: true },
    });
    const resolved = await this.resolveClientSubdomain(orderGate, deployment);

    // ── 17B.4F-C4 : allocation liée (portée des tentatives DELETE) + ────────
    //    identifiants connus AVANT nettoyage (preuves par ressource).
    const c4Enabled = isHostingC4Enabled();
    const allocation = c4Enabled && deployment
      ? await this.prisma.hostingServiceAllocation.findFirst({
          where: { deploymentId: deployment.id },
          select: { id: true },
        })
      : null;
    const appIdentifier = deployment?.coolifyUuid ?? null;
    const dnsHadRecord = !!resolved.cs?.recordId;
    const dnsIdentifier = resolved.cs?.fqdn ?? null;

    // ── Phase 3 : externe provider (PanelTransport, resourceId opaque) ──
    let provider: ExternalCleanup = 'skipped';
    let providerConfirmed = true;
    if (!deployment) {
      provider = 'absent';
      providerConfirmed = true;
    } else if (deployment.coolifyUuid) {
      const server = deployment.server;
      const canCall =
        server &&
        server.apiBaseUrl &&
        server.apiTokenEnc &&
        server.panelProvider &&
        server.panelProvider.length > 0;
      if (canCall) {
        if (c4Enabled) {
          // Tentative DELETE durable + consignation (identité : actor.sub) ;
          // refus de dispatch (arrêt déjà couvert, créateur non résolu) ⇒
          // AUCUN appel réseau, issue « unknown », ressource conservée.
          const target = this.buildTarget(server!);
          const uuid = deployment.coolifyUuid;
          const issue = await this.c4TrackedDelete(
            {
              nature: 'DELETE',
              scope: { type: 'DEPLOYMENT', id: deployment.id },
              allocationId: allocation?.id ?? null,
              orderId,
              holder: actor.sub,
              targetIntent: { type: 'application', serverId: server!.id, uuid },
            },
            () => this.panelFactory.create().deleteApplication(target, uuid),
          );
          provider = issue;
          providerConfirmed = issue === 'deleted' || issue === 'absent';
          if (!providerConfirmed && issue === 'failed') {
            this.log.warn(`${logPrefix}: suppression provider échouée — ressource conservée`);
          }
          if (issue === 'unknown') {
            this.log.warn(`${logPrefix}: delete provider non résolu — ressource conservée`);
          }
        } else {
          try {
            const target = this.buildTarget(server!);
            await this.panelFactory.create().deleteApplication(target, deployment.coolifyUuid);
            provider = 'deleted';
            providerConfirmed = true;
          } catch (e) {
            if (isAbsentExternalError(e)) {
              provider = 'absent';
              providerConfirmed = true;
            } else {
              provider = 'failed';
              providerConfirmed = false;
              this.log.warn(`${logPrefix}: suppression provider échouée — ressource conservée`);
            }
          }
        }
      } else {
        provider = 'failed';
        providerConfirmed = false;
      }
    } else {
      provider = 'unknown';
      providerConfirmed = false;
      this.log.warn(`${logPrefix}: ressource provider non identifiable — déploiement conservé`);
    }

    // ── Phase 4 : externe DNS (D2 + D3) ──
    let dns: ExternalCleanup = 'skipped';
    let dnsConfirmed = true;
    if (resolved.ownership === 'absent' || !resolved.cs) {
      dns = 'skipped';
      dnsConfirmed = true;
    } else if (resolved.ownership === 'ambiguous' || resolved.ownership === 'foreign') {
      dns = 'unknown';
      dnsConfirmed = false;
    } else if (resolved.cs.domainId && resolved.cs.recordId) {
      if (c4Enabled) {
        const target = {
          domainId: resolved.cs.domainId,
          recordId: resolved.cs.recordId,
          fqdn: resolved.cs.fqdn,
        };
        const issue = await this.c4TrackedDelete(
          {
            nature: 'DELETE',
            scope: { type: 'ORDER', id: orderId },
            allocationId: allocation?.id ?? null,
            orderId,
            holder: actor.sub,
            targetIntent: { type: 'dns', ...target },
          },
          () => this.cloudflare.deleteDnsRecord(target.domainId, target.recordId, actor),
        );
        dns = issue;
        dnsConfirmed = issue === 'deleted' || issue === 'absent';
        if (issue === 'failed') {
          this.log.warn(`${logPrefix}: suppression DNS échouée — enregistrement conservé`);
        }
      } else {
        try {
          await this.cloudflare.deleteDnsRecord(resolved.cs.domainId, resolved.cs.recordId, actor);
          dns = 'deleted';
          dnsConfirmed = true;
        } catch (e) {
          if (isAbsentExternalError(e)) {
            dns = 'absent';
            dnsConfirmed = true;
          } else {
            dns = 'failed';
            dnsConfirmed = false;
            this.log.warn(`${logPrefix}: suppression DNS échouée — enregistrement conservé`);
          }
        }
      }
    } else {
      dns = 'unknown';
      dnsConfirmed = false;
    }

    // ── Phase 5 : rows locales conditionnelles + Subscription (lien exact) ──
    let deploymentLocal: LocalCleanup = 'absent';
    let csLocal: LocalCleanup = 'absent';
    let subscription: CleanupOutcome['subscription'] = 'absent';
    let invoiceLabel = 'absent';
    const ownership = resolved.ownership;

    await this.prisma.$transaction(async (tx) => {
      // ClientSubdomain — seulement si DNS confirmé ET appartenance prouvée.
      if (resolved.cs) {
        const ownershipProven = ownership === 'exact' || ownership === 'legacy_proven';
        if (dnsConfirmed && ownershipProven) {
          await tx.clientSubdomain.delete({ where: { id: resolved.cs.id } }).catch(() => undefined);
          const still = await tx.clientSubdomain.findUnique({ where: { id: resolved.cs.id } });
          csLocal = still ? 'kept' : 'deleted';
        } else {
          csLocal = 'kept';
        }
      } else {
        csLocal = 'absent';
      }

      // Deployment — seulement si provider confirmé.
      if (deployment) {
        if (providerConfirmed) {
          await tx.deployment.delete({ where: { id: deployment.id } }).catch(() => undefined);
          const still = await tx.deployment.findUnique({ where: { id: deployment.id } });
          deploymentLocal = still ? 'kept' : 'deleted';
        } else {
          deploymentLocal = 'kept';
        }
      } else {
        deploymentLocal = 'absent';
      }

      // Subscription — lien exact order.id (jamais de comparaison de dates).
      // ACTIVE/SUSPENDED/PENDING → CANCELLED ; CANCELLED → already_cancelled.
      const sub = await tx.subscription.findUnique({ where: { orderId } });
      if (sub && sub.orderId === orderGate.id) {
        if (sub.status === SubscriptionStatus.CANCELLED) {
          subscription = 'already_cancelled';
        } else {
          await tx.subscription.update({
            where: { id: sub.id },
            data: { status: SubscriptionStatus.CANCELLED },
          });
          subscription = 'cancelled';
        }
      } else {
        subscription = 'absent';
      }

      // Invoice — STRICTEMENT lecture seule (jamais d'écriture).
      const inv = await tx.invoice.findUnique({ where: { orderId } });
      if (!inv) {
        invoiceLabel = 'absent';
      } else if (inv.status === InvoiceStatus.PAID) {
        invoiceLabel = 'left_paid';
      } else if (inv.status === InvoiceStatus.UNPAID) {
        invoiceLabel = 'left_unpaid';
      } else if (inv.status === InvoiceStatus.CANCELLED) {
        invoiceLabel = 'already_cancelled';
      } else if (inv.status === InvoiceStatus.REFUNDED) {
        invoiceLabel = 'already_refunded';
      } else if (inv.status === InvoiceStatus.CREDITED) {
        invoiceLabel = 'already_credited';
      } else {
        invoiceLabel = `left_${String(inv.status).toLowerCase()}`;
      }
    });

    const partial =
      provider === 'failed' ||
      provider === 'unknown' ||
      dns === 'failed' ||
      dns === 'unknown' ||
      ownership === 'ambiguous' ||
      ownership === 'foreign';

    return {
      provider,
      dns,
      deploymentLocal,
      csLocal,
      subscription,
      invoiceLabel,
      ownership,
      partial,
      dnsHadRecord,
      appIdentifier,
      dnsIdentifier,
    };
  }

  // ─────────────────────────── 17B.4F-C4 (sous ON) ──────────────────────────

  /**
   * 17B.4F-C4 — émission d'un ARRÊT + bascule du service en
   * `CANCELLATION_PENDING`, DANS LA TRANSACTION du caller (le caller détient
   * déjà le verrou Order ; verrous ordonnés Order → HostingService →
   * Allocation → Deployment). Idempotent (upsert stop + CAS borné) — aucun
   * terminal n'est régressé, aucun marqueur n'est effacé.
   */
  private async c4MarkStops(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    // Verrou de LIGNE Order (si le caller ne le détient pas déjà) — l'ordre
    // global reste Order → HostingService → Allocation → Deployment.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const scopes: C4Scope[] = [{ type: 'ORDER', id: orderId }];
    const svcs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "HostingService" WHERE "orderId" = ${orderId} FOR UPDATE`;
    for (const s of svcs) {
      scopes.push({ type: 'SERVICE', id: s.id });
      const allocs = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "HostingServiceAllocation" WHERE "hostingServiceId" = ${s.id} FOR UPDATE`;
      for (const a of allocs) scopes.push({ type: 'ALLOCATION', id: a.id });
      // Résiliation demandée : ni PROVISIONING/ACTIVE/SUSPENDED → aucun CAS ;
      // un service déjà terminal (CANCELLED) n'est JAMAIS régressé.
      await tx.hostingService.updateMany({
        where: {
          id: s.id,
          status: {
            in: [
              HostingServiceStatus.PROVISIONING,
              HostingServiceStatus.ACTIVE,
              HostingServiceStatus.SUSPENDED,
            ],
          },
        },
        data: { status: HostingServiceStatus.CANCELLATION_PENDING },
      });
    }
    const deps = await tx.deployment.findMany({ where: { orderId }, select: { id: true } });
    for (const d of deps) scopes.push({ type: 'DEPLOYMENT', id: d.id });
    for (const scope of scopes) {
      await this.c4.requestStopInTx(tx, { scope, reason, actorId });
    }
  }

  /**
   * 17B.4F-C4 — delete distant TRACKÉ : tentative durable émise dans sa propre
   * transaction (refus ⇒ ZÉRO appel réseau), exécution réseau HORS
   * transaction, consignation du retour dans sa propre transaction.
   * Retour : `deleted`/`absent` (conclusifs), `failed` (appel en erreur,
   * retryable), `unknown` (dispatch refusé — incertitude conservée).
   */
  private async c4TrackedDelete(
    params: {
      nature: 'DELETE';
      scope: { type: 'DEPLOYMENT' | 'ORDER'; id: string };
      allocationId: string | null;
      orderId: string;
      holder: string;
      targetIntent: Record<string, unknown>;
    },
    call: () => Promise<unknown>,
  ): Promise<'deleted' | 'absent' | 'failed' | 'unknown'> {
    let ticket: { attemptId: string; targetIntentHash: string | null };
    try {
      ticket = await this.c4.beginDispatchStandalone(params);
    } catch {
      // Arrêt / créateur non résolu / tentative de création ouverte : AUCUN
      // appel réseau, l'incertitude est conservée (ressource non touchée).
      return 'unknown';
    }
    try {
      await call();
    } catch (e) {
      const absent = isAbsentExternalError(e);
      await this.c4.settleStandalone({
        attemptId: ticket.attemptId,
        holder: params.holder,
        outcome: absent ? 'ABSENT' : 'FAILED_RETRYABLE',
        targetIntentHash: ticket.targetIntentHash,
        returnedIdentifiers: absent ? { absent: true } : { error: 'provider_error' },
      });
      return absent ? 'absent' : 'failed';
    }
    await this.c4.settleStandalone({
      attemptId: ticket.attemptId,
      holder: params.holder,
      outcome: 'DELETED',
      targetIntentHash: ticket.targetIntentHash,
      returnedIdentifiers: { deleted: true },
    });
    return 'deleted';
  }

  /**
   * 17B.4F-C4 — libération de TOUTES les allocations du service après cleanup,
   * sous preuves suffisantes (par ressource), puis terminal `CANCELLED` du
   * service UNIQUEMENT si toutes les allocations sont RELEASED ET le
   * nettoyage concluant ; sinon le service reste `CANCELLATION_PENDING`.
   */
  private async c4AttemptReleases(
    orderId: string,
    actor: CancelActor,
    cleanup: CleanupOutcome,
  ): Promise<C4CancelC4> {
    const service = await this.prisma.hostingService.findUnique({
      where: { orderId },
      select: { id: true, status: true, userId: true },
    });
    if (!service) {
      return { serviceStatus: null, releases: [] };
    }
    const allocations = await this.prisma.hostingServiceAllocation.findMany({
      where: { hostingServiceId: service.id },
      select: { id: true, status: true },
    });

    const app: C4AppOutcome =
      cleanup.provider === 'deleted'
        ? 'deleted'
        : cleanup.provider === 'absent'
          ? 'absent'
          : cleanup.provider === 'failed'
            ? 'failed'
            : 'unknown';
    const dns: C4DnsOutcome =
      cleanup.dns === 'deleted'
        ? 'deleted'
        : cleanup.dns === 'absent'
          ? 'absent'
          : cleanup.dns === 'skipped'
            ? 'not_created'
            : cleanup.dns === 'failed'
              ? 'failed'
              : 'unknown';

    const releases: C4CancelC4['releases'] = [];
    for (const alloc of allocations) {
      if (alloc.status === HostingServiceAllocationStatus.RELEASED) {
        releases.push({ allocationId: alloc.id, status: 'already_released' });
        continue;
      }
      try {
        const res = await this.c4r.releaseAfterCleanup({
          allocationId: alloc.id,
          actorUserId: service.userId,
          orderId,
          app,
          dns,
          dnsHadRecord: cleanup.dnsHadRecord,
          appIdentifier: cleanup.appIdentifier,
          dnsIdentifier: cleanup.dnsIdentifier,
        });
        releases.push({
          allocationId: alloc.id,
          status: res.status,
          ...(res.blockedReason ? { blockedReason: res.blockedReason } : {}),
        });
      } catch {
        // Conflit sous verrou (recheck) : incertitude conservée, jamais libéré.
        releases.push({
          allocationId: alloc.id,
          status: 'blocked',
          blockedReason: 'call_uncertain',
        });
      }
    }

    // Terminal CANCELLED : TOUTES les allocations libérées + nettoyage concluant
    // (provider et DNS sans incertitude) — sans quoi CANCELLATION_PENDING reste.
    const allReleased = releases.every(
      (r) => r.status === 'released' || r.status === 'already_released' || r.status === 'pre_provider_released',
    );
    const cleanupConclusive =
      (cleanup.provider === 'deleted' || cleanup.provider === 'absent' || cleanup.provider === 'skipped') &&
      (cleanup.dns === 'deleted' || cleanup.dns === 'absent' || cleanup.dns === 'skipped');
    if (allReleased && cleanupConclusive) {
      await this.prisma.hostingService.updateMany({
        where: { id: service.id, status: HostingServiceStatus.CANCELLATION_PENDING },
        data: { status: HostingServiceStatus.CANCELLED },
      });
    }
    const fresh = await this.prisma.hostingService.findUnique({
      where: { id: service.id },
      select: { status: true },
    });
    return { serviceStatus: fresh?.status ?? service.status, releases };
  }

  /**
   * D3 + ownership complet — résolution d'appartenance du ClientSubdomain.
   * Schéma réel : ClientSubdomain n'a PAS de userId ; owner via
   * Order→Customer.userId et Deployment.userId uniquement.
   * 1) relation exacte `deploymentId === Deployment.id` de CETTE Order ;
   * 2) fallback legacy UNIQUEMENT si `deploymentId === null` et prouvé :
   *    fqdn + domainId ∈ {effective,requested} + owner concordant
   *    (Customer.userId existe ET Deployment.userId === Customer.userId) ;
   * 3) owner non prouvable → ambiguous (row conservée, partial, aucun delete) ;
   * 4) deploymentId d'un AUTRE Deployment → foreign (conservée, partial si fqdn).
   * Jamais updateMany par fqdn ; jamais createdAt comme preuve d'ownership.
   */
  private async resolveClientSubdomain(
    order: OrderGateRow,
    deployment: { id: string; userId: string } | null,
  ): Promise<ResolvedCs> {
    const select = {
      id: true,
      fqdn: true,
      domainId: true,
      recordId: true,
      deploymentId: true,
    } as const;

    if (deployment) {
      const byDep = await this.prisma.clientSubdomain.findUnique({
        where: { deploymentId: deployment.id },
        select,
      });
      if (byDep) return { cs: byDep, ownership: 'exact' };
    }

    if (!order.domainValue) return { cs: null, ownership: 'absent' };

    const byFqdn = await this.prisma.clientSubdomain.findFirst({
      where: { fqdn: order.domainValue },
      select,
    });
    if (!byFqdn) return { cs: null, ownership: 'absent' };

    // Liée à un AUTRE déploiement → hors périmètre (jamais supprimée/reliée).
    if (byFqdn.deploymentId && byFqdn.deploymentId !== deployment?.id) {
      return { cs: byFqdn, ownership: 'foreign' };
    }

    // Exact déjà couvert ci-dessus ; deploymentId non nul ici = ce deployment.
    if (byFqdn.deploymentId !== null) {
      return { cs: byFqdn, ownership: 'exact' };
    }

    // ── Legacy (deploymentId null) ──
    const domainIds = [order.effectiveDomainId, order.requestedDomainId].filter(
      (x): x is string => !!x,
    );
    if (domainIds.length === 0 || !domainIds.includes(byFqdn.domainId)) {
      return { cs: byFqdn, ownership: 'ambiguous' };
    }

    // Owner : Customer.userId requis ; sans Deployment de référence, imposssible
    // de prouver l'appartenance (CS n'a pas de userId) → ambiguous.
    if (!order.customerUserId || !deployment) {
      return { cs: byFqdn, ownership: 'ambiguous' };
    }
    if (deployment.userId !== order.customerUserId) {
      return { cs: byFqdn, ownership: 'ambiguous' };
    }
    return { cs: byFqdn, ownership: 'legacy_proven' };
  }

  private buildTarget(server: {
    panelProvider: string;
    apiBaseUrl: string | null;
    apiTokenEnc: string | null;
    strictTls: boolean;
  }): PanelTarget {
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc!);
    } catch {
      throw new Error('Impossible de déchiffrer le jeton API du panneau (ENCRYPTION_KEY ?).');
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl!,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }
}
