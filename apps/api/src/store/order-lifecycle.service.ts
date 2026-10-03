import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InvoiceStatus, OrderStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';

/** Env : période du sweep de reprise (ms). `0`/absente→60000 ; désactivable. */
export const ORDER_SWEEP_MS_ENV = 'ORDER_SWEEP_MS';
/** Env : durée de grâce des commandes en attente de règlement (heures). */
export const PENDING_PAYMENT_TTL_HOURS_ENV = 'PENDING_PAYMENT_TTL_HOURS';

/** Commande PAID « confirmée mais non lancée » depuis ce délai → relance. */
export const RELAUNCH_AFTER_MS = 2 * 60_000;

/**
 * Reprise durable de la vie d'une commande (GO socle commercial) :
 *
 *  1. **Expiration** des `PENDING_PAYMENT` au-delà de la durée de grâce
 *     (défaut 48 h) : `→ CANCELLED`, facture `UNPAID → CANCELLED`, historique
 *     + audit — jamais de droits ouverts, jamais d'encaissement fabriqué.
 *     Le client peut ensuite repartir pour un NOUVEAU achat (clé chaînée,
 *     cf. `CheckoutService.resolveIntention`).
 *
 *  2. **Relance du provisioning** pour une commande `PAID` restée sur place
 *     plus de 2 minutes : interruption entre la CONFIRMATION du règlement et
 *     le lancement de l'exécution (crash réseau/process) → reprise SANS double
 *     encaissement (le règlement est déjà confirmé une seule fois) et SANS
 *     double exécution (`ProvisioningService.provisionOrder` est idempotent :
 *     `PROVISIONING`/`ACTIVE` → no-op).
 *
 * Timer simple (`setInterval`, sans dépendance), anti-chevauchement local,
 * désactivable par `ORDER_SWEEP_ENABLED=false` (tests isolés). Le sweep est
 * PUBLIC et testable directement (`sweep()`).
 */
@Injectable()
export class OrderLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OrderLifecycleService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
  ) {}

  onModuleInit(): void {
    if (process.env.ORDER_SWEEP_ENABLED === 'false') return;
    const raw = process.env[ORDER_SWEEP_MS_ENV];
    const ms = raw === undefined ? 60_000 : Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.log.warn(`sweep failed: ${String(e)}`));
    }, ms);
    // Ne maintient pas le processus en vie (tests, arrêts propres).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un passage de reprise. Idempotent, anti-chevauchement local. */
  async sweep(): Promise<{ expired: number; relaunched: number }> {
    if (this.running) return { expired: 0, relaunched: 0 };
    this.running = true;
    try {
      const expired = await this.expireStalePending();
      const relaunched = await this.relaunchStuckPaid();
      return { expired, relaunched };
    } finally {
      this.running = false;
    }
  }

  /** PENDING_PAYMENT au-delà de la grâce (défaut 48 h) → CANCELLED tracé. */
  private async expireStalePending(): Promise<number> {
    const hours = Number(process.env[PENDING_PAYMENT_TTL_HOURS_ENV] ?? 48);
    const ttlMs = (Number.isFinite(hours) && hours > 0 ? hours : 48) * 3_600_000;
    const cutoff = new Date(Date.now() - ttlMs);
    // P8 (D2) : les commandes de RENOUVELLEMENT (renewsOrderId) ne expirent
    // JAMAIS ici — leur facture UNPAID vit le cycle complet de dunning
    // (rappel → suspension à dueDate + dunningGraceDays) ; les annuler à 48 h
    // détruirait l'impayé avant sa relance. Leur résolution est celle de
    // `RenewalService` (paiement tardif, suspension ou annulation admin).
    const stale = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: { lt: cutoff },
        renewsOrderId: null,
      },
      select: { id: true, customerEmail: true },
      take: 25,
    });
    let expired = 0;
    for (const o of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const cas = await tx.order.updateMany({
            where: { id: o.id, status: OrderStatus.PENDING_PAYMENT },
            data: { status: OrderStatus.CANCELLED },
          });
          if (cas.count !== 1) return;
          await tx.invoice.updateMany({
            where: { orderId: o.id, status: InvoiceStatus.UNPAID },
            data: { status: InvoiceStatus.CANCELLED },
          });
          await tx.orderStatusHistory.create({
            data: {
              orderId: o.id,
              status: OrderStatus.CANCELLED,
              note: 'Expiré — règlement jamais confirmé dans le délai de grâce.',
              actorEmail: null,
            },
          });
        });
        await this.audit.record({
          action: 'order.expired',
          resourceType: 'order',
          resourceId: o.id,
          details: { from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.CANCELLED },
        });
        expired += 1;
      } catch (e) {
        this.log.warn(`expire order=${o.id} failed: ${String(e)}`);
      }
    }
    return expired;
  }

  /** PAID restée immobile > 2 min → relance du provisioning (idempotent). */
  private async relaunchStuckPaid(): Promise<number> {
    const cutoff = new Date(Date.now() - RELAUNCH_AFTER_MS);
    const stuck = await this.prisma.order.findMany({
      where: { status: OrderStatus.PAID, updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 10,
    });
    let relaunched = 0;
    for (const o of stuck) {
      try {
        await this.provisioning.provisionOrder(o.id);
        relaunched += 1;
        await this.audit.record({
          action: 'order.relaunch_provisioning',
          resourceType: 'order',
          resourceId: o.id,
          details: { from: OrderStatus.PAID },
        });
      } catch (e) {
        // L'échec reste VISIBLE (audit) — jamais un succès annoncé à tort.
        this.log.warn(`relaunch order=${o.id} failed: ${String(e)}`);
        await this.audit
          .record({
            action: 'provision.launch_failed',
            resourceType: 'order',
            resourceId: o.id,
            details: { error: String(e), via: 'order-lifecycle-sweep' },
          })
          .catch(() => {});
      }
    }
    return relaunched;
  }
}
