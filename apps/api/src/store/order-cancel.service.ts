import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceStatus, OrderStatus, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { PanelKind, PanelTarget, PanelTransportFactory } from '../servers/panel-transport.factory';

/** Résultat d'une opération externe (provider ou DNS) sur cancel. */
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
  ) {}

  async cancelProvisioning(
    orderId: string,
    reason: string,
    actor: CancelActor,
  ): Promise<CancelProvisioningResult> {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 8) {
      throw new ConflictException('Le motif d’annulation doit faire au moins 8 caractères.');
    }

    // ── Phase 0 : lecture gate (aucune mutation) ──
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
    if (order.status !== OrderStatus.PROVISIONING && order.status !== OrderStatus.CANCELLED) {
      throw new ConflictException(
        `Annulation du provisioning impossible depuis le statut ${order.status} (PROVISIONING ou CANCELLED uniquement).`,
      );
    }
    const orderGate: OrderGateRow = {
      id: order.id,
      status: order.status,
      domainValue: order.domainValue,
      effectiveDomainId: order.effectiveDomainId,
      requestedDomainId: order.requestedDomainId,
      customerUserId: order.customer?.userId ?? null,
    };

    let alreadyCancelled = false;
    let orderJustCancelled = false;

    // ── Phase 1 (D1) : CAS + history + reconcileNextAt dans UNE transaction ──
    if (order.status === OrderStatus.PROVISIONING) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const won = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PROVISIONING },
          data: { status: OrderStatus.CANCELLED },
        });
        if (won.count === 1) {
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
        if (re.status === OrderStatus.CANCELLED) {
          // Rejeu idempotent : neutralise aussi l'éligibilité runner.
          await tx.deployment.updateMany({
            where: { orderId },
            data: { reconcileNextAt: null },
          });
          return {
            kind: 'replay' as const,
            order: {
              ...re,
              customerUserId: re.customer?.userId ?? null,
            },
          };
        }
        // Activation (ou autre transition) gagnée → 409, zéro écriture de cleanup.
        throw new ConflictException(
          `Course perdue face à une transition concurrente (statut actuel ${re.status}).`,
        );
      });
      if (outcome.kind === 'cancelled') {
        orderJustCancelled = true;
        orderGate.status = OrderStatus.CANCELLED;
      } else {
        alreadyCancelled = true;
        orderGate.status = outcome.order.status;
        orderGate.domainValue = outcome.order.domainValue;
        orderGate.effectiveDomainId = outcome.order.effectiveDomainId;
        orderGate.requestedDomainId = outcome.order.requestedDomainId;
        orderGate.customerUserId = outcome.order.customerUserId;
      }
    } else {
      // Déjà CANCELLED au gate : neutralisation idempotente avant rejeu cleanup.
      alreadyCancelled = true;
      await this.prisma.deployment.updateMany({
        where: { orderId },
        data: { reconcileNextAt: null },
      });
    }

    // ── Phase 2 : rows pour cleanup externe ──
    const deployment = await this.prisma.deployment.findUnique({
      where: { orderId },
      include: { server: true },
    });
    const resolved = await this.resolveClientSubdomain(orderGate, deployment);

    // ── Phase 3 : externe provider (PanelTransport, resourceId opaque) ──
    // C2 : sans Deployment → absent/skipped confirmé ; avec resourceId opaque →
    // suppression PanelTransport ; Deployment SANS resourceId → unknown (jamais
    // interprété comme « pas de ressource provider »), row conservée.
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
            this.log.warn('cancel: suppression provider échouée — ressource conservée');
          }
        }
      } else {
        provider = 'failed';
        providerConfirmed = false;
      }
    } else {
      // C2 : resourceId opaque absent → état inconnu, jamais « skipped » confirmé.
      provider = 'unknown';
      providerConfirmed = false;
      this.log.warn('cancel: ressource provider non identifiable — déploiement conservé');
    }

    // ── Phase 4 : externe DNS (D2 + D3) ──
    let dns: ExternalCleanup = 'skipped';
    let dnsConfirmed = true;
    if (resolved.ownership === 'absent' || !resolved.cs) {
      dns = 'skipped';
      dnsConfirmed = true;
    } else if (
      resolved.ownership === 'ambiguous' ||
      resolved.ownership === 'foreign'
    ) {
      // D3/C1 : appartenance non prouvée ou row d'un autre déploiement →
      // ni delete CF ni delete local.
      dns = 'unknown';
      dnsConfirmed = false;
    } else if (resolved.cs.domainId && resolved.cs.recordId) {
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
          this.log.warn('cancel: suppression DNS échouée — enregistrement conservé');
        }
      }
    } else {
      // D2 : identifiants incomplets → JAMAIS interprétés comme « record absent ».
      dns = 'unknown';
      dnsConfirmed = false;
    }

    // ── Phase 5 : rows locales conditionnelles + Subscription (lien exact) ──
    let deploymentLocal: LocalCleanup = 'absent';
    let csLocal: LocalCleanup = 'absent';
    let subscription: CancelProvisioningResult['subscription'] = 'absent';
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

      // Invoice — STRICTEMENT lecture seule en B1 (jamais d'écriture).
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

    // C2 : provider unknown/failed → partial forcé (impossible partial=false).
    const partial =
      provider === 'failed' ||
      provider === 'unknown' ||
      dns === 'failed' ||
      dns === 'unknown' ||
      ownership === 'ambiguous' ||
      ownership === 'foreign';

    // ── Phase 6 : audit (détails métier contrôlés — pas d'exception brute) ──
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'order.cancel_provisioning',
      resourceType: 'order',
      resourceId: orderId,
      details: {
        reason: trimmed,
        orderJustCancelled,
        alreadyCancelled,
        provider,
        dns,
        deployment: deploymentLocal,
        clientSubdomain: csLocal,
        csOwnership: ownership,
        invoice: invoiceLabel,
        invoicePolicy: 'no_auto_change_b1',
        subscription,
        partial,
      },
    });

    return {
      orderId,
      orderStatus: OrderStatus.CANCELLED,
      alreadyCancelled,
      provider,
      dns,
      deployment: deploymentLocal,
      clientSubdomain: csLocal,
      invoice: invoiceLabel,
      subscription,
      partial,
    };
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
