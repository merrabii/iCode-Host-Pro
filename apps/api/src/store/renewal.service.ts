import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  BillingCycle,
  InvoiceStatus,
  OrderStatus,
  Prisma,
  SubscriptionStatus,
  WalletTransactionType,
  WalletTxStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailSettingsService } from '../mail/mail-settings.service';
import { WalletService } from '../wallet/wallet.service';
import { CheckoutService } from './checkout.service';
import { claimInvoiceSequence } from './invoice-sequence';
import { clientAreaUrl } from './web-links';

/** Env : période du scheduler de renouvellement (ms). `0`/absente → 60000. */
export const RENEWAL_SWEEP_MS_ENV = 'RENEWAL_SWEEP_MS';
/** Env : `RENEWAL_SWEEP_ENABLED=false` coupe le timer (tests isolés). */
export const RENEWAL_SWEEP_ENABLED_ENV = 'RENEWAL_SWEEP_ENABLED';

/** Jours bornés (0..3650) — valeur non numérique → repli par défaut. */
function clampDays(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(0, Math.trunc(n)), 3650);
}

/**
 * P8 (lot D2) — abonnements récurrents : échéances, renouvellement, dunning
 * et suspension automatique. Aucun prestataire (C1 reste bloqué §6-1) :
 * l'encaissement automatique passe par le **solde portefeuille** (C2).
 *
 * Quatre passes idempotentes, dans cet ordre :
 *
 *  1. **Renouvellement** (`autoRenew` + `nextBillingDate` échue, commande de la
 *     famille payée, souscription ACTIVE du même produit) → NOUVELLE commande
 *     (`renewsOrderId` chaîné, la mère bascule `autoRenew=false` dans la MÊME
 *     transaction : UNE seule tentative à la fois, contrainte unique en secours)
 *     + NOUVELLE facture UNPAID (numéros partagés D1, mentions/échéance
 *     figées). Puis **paiement par solde** (`WalletService.debit`, clé
 *     `renewal:<orderId>`) → `confirmOrderPaid(source 'wallet')` : la commande
 *     renouvellement passe PAID → ACTIVE sans provisioning (service inchangé).
 *     Solde insuffisant → facture reste UNPAID (la période suivante n'est
 *     JAMAIS ouverte avant règlement).
 *  2. **Reprise/relance de paiement** : renouvellement PENDING sans prélevement
 *     → réessai (le client a pu recharger) ; prélevé mais non confirmé (crash
 *     entre le débit et la confirmation) → re-confirmation idempotente.
 *  3. **Dunning** : facture UNPAID à `dueDate - dunningReminderDays` → UNE
 *     relance (marqueur `Invoice.dunningRemindedAt`, colonne P8) = audit +
 *     email best-effort.
 *  4. **Suspension à échéance** : facture UNPAID au-delà de
 *     `dueDate + dunningGraceDays` → souscription ACTIVE → SUSPENDED (CAS).
 *
 * **Effet infra : AUCUN (§6-4, décision owner)** — la suspension bloque le
 * renouvellement et l'accès commercial, elle n'arrête jamais d'app ni n'appelle
 * de provider (interdit ici, non tranché). Toute réactivation est manuelle
 * (whitelist admin existante).
 *
 * Timer simple (`setInterval`, sans dépendance), anti-chevauchement local,
 * désactivable par `RENEWAL_SWEEP_ENABLED=false` ; `sweep()` est PUBLIC et
 * testable directement (horloge accélérée = échéance rétrogradée en base).
 */
@Injectable()
export class RenewalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RenewalService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly checkout: CheckoutService,
    private readonly mail: MailSettingsService,
  ) {}

  onModuleInit(): void {
    if (process.env[RENEWAL_SWEEP_ENABLED_ENV] === 'false') return;
    const raw = process.env[RENEWAL_SWEEP_MS_ENV];
    const ms = raw === undefined ? 60_000 : Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.log.warn(`renewal sweep failed: ${String(e)}`));
    }, ms);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un passage complet. Idempotent, anti-chevauchement local. */
  async sweep(): Promise<{
    created: number;
    paid: number;
    pending: number;
    reminded: number;
    suspended: number;
    stopped: number;
  }> {
    if (this.running) {
      return { created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 };
    }
    this.running = true;
    try {
      const renewals = await this.createDueRenewals();
      const payments = await this.payPendingRenewals();
      const reminded = await this.dunningReminders();
      const suspended = await this.suspendOverdue();
      return {
        created: renewals.created,
        paid: renewals.paid + payments.paid,
        pending: renewals.pending + payments.pending,
        reminded,
        suspended,
        stopped: renewals.stopped,
      };
    } finally {
      this.running = false;
    }
  }

  // ───────────────────── 1. Renouvellement des échéances ────────────────────

  private async createDueRenewals(): Promise<{
    created: number;
    paid: number;
    pending: number;
    stopped: number;
  }> {
    const now = new Date();
    // Échu + cycle récurrent + famille payée (PAID/PROVISIONING/ACTIVE).
    const heads = await this.prisma.order.findMany({
      where: {
        autoRenew: true,
        nextBillingDate: { lte: now },
        billingCycle: { not: BillingCycle.ONETIME },
        status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING, OrderStatus.ACTIVE] },
      },
      select: {
        id: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        productId: true,
        productName: true,
        packId: true,
        billingCycle: true,
        currency: true,
        taxRatePercent: true,
        amountHtCents: true,
        taxAmountCents: true,
        amountTtcCents: true,
        paymentMethodId: true,
        paymentMethodName: true,
        optionsSnapshot: true,
        addonsSnapshot: true,
        nextBillingDate: true,
        customer: { select: { userId: true } },
      },
      take: 10,
      orderBy: { nextBillingDate: 'asc' },
    });

    let created = 0;
    let paid = 0;
    let pending = 0;
    let stopped = 0;
    for (const head of heads) {
      try {
        const gate = await this.gateSubscription(head.productId, head.customer.userId);
        if (gate === 'stop' || gate === 'stop_product') {
          stopped += await this.stopChain(
            head.id,
            gate === 'stop_product' ? 'product_changed' : 'no_active_subscription',
          );
          continue;
        }
        if (gate === 'skip') continue;
        const made = await this.createRenewalOrder(head, now);
        if (!made) continue;
        created += 1;
        await this.audit.record({
          action: 'subscription.renewal_created',
          resourceType: 'order',
          resourceId: made.renewal.id,
          details: {
            motherOrderId: head.id,
            invoiceNumber: made.invoiceNumber,
            amountTtcCents: head.amountTtcCents,
            missedBillingDate: head.nextBillingDate,
            billingCycle: head.billingCycle,
          },
        });
        const outcome = await this.attemptPayment(
          made.renewal.id,
          made.invoice.id,
          made.invoice.amountTtcCents,
          head.customerId,
          made.invoiceNumber,
        );
        if (outcome === 'paid') paid += 1;
        else pending += 1;
      } catch (e) {
        this.log.warn(`renewal head=${head.id} failed: ${String(e)}`);
        await this.audit
          .record({
            action: 'renewal.create_failed',
            resourceType: 'order',
            resourceId: head.id,
            details: { error: String(e) },
          })
          .catch(() => {});
      }
    }
    return { created, paid, pending, stopped };
  }

  /**
   * Garde d'éligibilité (lecture seule) :
   * - `ok`   : souscription ACTIVE du MÊME produit → renouveler ;
   * - `skip` : souscription PENDING/SUSPENDED → on n'arrête PAS la chaîne
   *            (l'admin peut réactiver ; le renouvellement reprendra) ;
   * - `stop` : aucune souscription / CANCELLED / REJECTED / produit changé
   *            (upgrade) → la chaîne s'arrête définitivement.
   */
  private async gateSubscription(
    productId: string,
    userId: string | null,
  ): Promise<'ok' | 'skip' | 'stop' | 'stop_product'> {
    if (!userId) return 'stop';
    const active = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      select: { id: true, productId: true },
    });
    if (active) return active.productId === productId ? 'ok' : 'stop_product';
    const latest = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    if (latest && (latest.status === SubscriptionStatus.SUSPENDED || latest.status === SubscriptionStatus.PENDING)) {
      return 'skip';
    }
    return 'stop';
  }

  /** Stop définitif de la chaîne (CAS sur `autoRenew`) + audit. */
  private async stopChain(headId: string, reason: string): Promise<number> {
    const flipped = await this.prisma.order.updateMany({
      where: { id: headId, autoRenew: true },
      data: { autoRenew: false },
    });
    if (flipped.count !== 1) return 0;
    await this.audit.record({
      action: 'renewal.chain_stopped',
      resourceType: 'order',
      resourceId: headId,
      details: { reason },
    });
    return 1;
  }

  /**
   * Crée la commande de renouvellement + sa facture UNPAID, et ferme
   * `autoRenew` sur la mère, dans UNE transaction atomique.
   * `null` = la mère a déjà été traitée (concurrence) → idempotent.
   */
  private async createRenewalOrder(
    head: {
      id: string;
      customerId: string;
      customerName: string;
      customerEmail: string;
      customerPhone: string | null;
      productId: string;
      productName: string;
      packId: string | null;
      billingCycle: string;
      currency: string;
      taxRatePercent: Prisma.Decimal;
      amountHtCents: number;
      taxAmountCents: number;
      amountTtcCents: number;
      paymentMethodId: string | null;
      paymentMethodName: string | null;
      optionsSnapshot: Prisma.JsonValue;
      addonsSnapshot: Prisma.JsonValue;
      nextBillingDate: Date | null;
    },
    now: Date,
  ): Promise<{
    renewal: { id: string };
    invoice: { id: string; amountTtcCents: number };
    invoiceNumber: string;
  } | null> {
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: head.id, autoRenew: true },
        data: { autoRenew: false },
      });
      if (flipped.count !== 1) return null;

      const motherInv = await tx.invoice.findUnique({
        where: { orderId: head.id },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });
      const claim = await claimInvoiceSequence(tx);
      const billing = claim.billing;
      const dueDays = clampDays(billing?.invoiceDueDays, 14);
      const issuedAt = now;
      const dueDate = new Date(issuedAt.getTime() + dueDays * 86_400_000);

      const renewal = await tx.order.create({
        data: {
          customerId: head.customerId,
          customerName: head.customerName,
          customerEmail: head.customerEmail,
          customerPhone: head.customerPhone,
          productId: head.productId,
          productName: head.productName,
          packId: head.packId,
          status: OrderStatus.PENDING_PAYMENT,
          billingCycle: head.billingCycle as BillingCycle,
          currency: claim.currency,
          taxRatePercent: head.taxRatePercent,
          amountHtCents: head.amountHtCents,
          taxAmountCents: head.taxAmountCents,
          amountTtcCents: head.amountTtcCents,
          paymentMethodId: head.paymentMethodId,
          paymentMethodName: head.paymentMethodName,
          optionsSnapshot: head.optionsSnapshot ?? Prisma.JsonNull,
          addonsSnapshot: head.addonsSnapshot ?? Prisma.JsonNull,
          renewsOrderId: head.id,
        },
      });

      const invoice = await tx.invoice.create({
        data: {
          number: claim.invoiceNumber,
          orderId: renewal.id,
          customerId: head.customerId,
          status: InvoiceStatus.UNPAID,
          currency: claim.currency,
          taxRatePercent: head.taxRatePercent,
          amountHtCents: head.amountHtCents,
          taxAmountCents: head.taxAmountCents,
          amountTtcCents: head.amountTtcCents,
          issuedAt,
          dueDate,
          legalMentionsSnapshot: motherInv?.legalMentionsSnapshot ?? {},
          billingAddress: motherInv?.billingAddress ?? {
            name: head.customerName,
            email: head.customerEmail,
            phone: head.customerPhone,
          },
          lines: motherInv
            ? {
                create: motherInv.lines.map((l, i) => ({
                  kind: l.kind,
                  label: l.label,
                  qty: l.qty,
                  unitPriceHtCents: l.unitPriceHtCents,
                  taxRatePercent: l.taxRatePercent,
                  taxAmountCents: l.taxAmountCents,
                  totalTtcCents: l.totalTtcCents,
                  sortOrder: i,
                })),
              }
            : undefined,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: renewal.id,
          status: OrderStatus.PENDING_PAYMENT,
          note: `Renouvellement échu (${head.productName}) — facture ${claim.invoiceNumber} à régler (solde ou relance).`,
          actorEmail: null,
        },
      });

      return { renewal, invoice, invoiceNumber: claim.invoiceNumber };
    });
  }

  // ───────────────────── 2. Paiement / reprise ──────────────────────────────

  /**
   * Débite le solde (clé idempotente `renewal:<orderId>`) puis confirme la
   * commande. `amount <= 0` → confirmation `free` (aucun mouvement).
   * Retourne `paid` (débit réussi + confirmé) ou `pending` (solde insuffisant
   * ou prélevé non confirmé — relancé par la passe suivante).
   */
  private async attemptPayment(
    orderId: string,
    invoiceId: string | null,
    amountCents: number,
    customerId: string,
    invoiceNumber: string,
  ): Promise<'paid' | 'pending'> {
    if (amountCents <= 0) {
      await this.checkout.confirmOrderPaid(orderId, { source: 'free' });
      return 'paid';
    }
    try {
      await this.wallet.debit(customerId, {
        amountCents,
        idempotencyKey: `renewal:${orderId}`,
        orderId,
        invoiceId,
        note: `Renouvellement automatique — facture ${invoiceNumber}`,
      });
    } catch (e) {
      if (e instanceof ConflictException) return 'pending'; // solde insuffisant
      throw e;
    }
    try {
      await this.checkout.confirmOrderPaid(orderId, { source: 'wallet' });
    } catch (e) {
      // Compensation best-effort : la confirmation a échoué après le débit.
      await this.wallet
        .credit(customerId, {
          amountCents,
          idempotencyKey: `renewal-refund:${orderId}`,
          orderId,
          invoiceId,
          note: 'Annulation du prélèvement de renouvellement (confirmation impossible).',
        })
        .catch(() => {});
      throw e;
    }
    return 'paid';
  }

  /**
   * Reprise : les renouvellements PENDING sont soit re-prélevés (le client a
   * rechargé), soit re-confirmés si le prélevement existe déjà (crash entre le
   * débit et la confirmation).
   */
  private async payPendingRenewals(): Promise<{ paid: number; pending: number }> {
    const pendingOrders = await this.prisma.order.findMany({
      where: { renewsOrderId: { not: null }, status: OrderStatus.PENDING_PAYMENT },
      select: { id: true, customerId: true, amountTtcCents: true, invoice: { select: { id: true, number: true, amountTtcCents: true } } },
      take: 10,
    });
    let paid = 0;
    let pending = 0;
    for (const o of pendingOrders) {
      try {
        const debit = await this.prisma.walletTransaction.findFirst({
          where: { orderId: o.id, type: WalletTransactionType.DEBIT, status: WalletTxStatus.SUCCEEDED },
          select: { id: true },
        });
        if (debit) {
          await this.checkout.confirmOrderPaid(o.id, { source: 'wallet' });
          paid += 1;
          continue;
        }
        const invoice = o.invoice;
        const outcome = await this.attemptPayment(
          o.id,
          invoice?.id ?? null,
          o.amountTtcCents,
          o.customerId,
          invoice?.number ?? '?',
        );
        if (outcome === 'paid') paid += 1;
        else pending += 1;
      } catch (e) {
        this.log.warn(`renewal payment retry order=${o.id} failed: ${String(e)}`);
        pending += 1;
      }
    }
    return { paid, pending };
  }

  // ───────────────────── 3. Dunning — rappel ────────────────────────────────

  private async dunningReminders(): Promise<number> {
    const settings = await this.prisma.billingSetting.findFirst({ orderBy: { createdAt: 'asc' } });
    const reminderDays = clampDays(settings?.dunningReminderDays, 3);
    const now = new Date();
    const horizon = new Date(now.getTime() + reminderDays * 86_400_000);
    const due = await this.prisma.invoice.findMany({
      where: {
        status: InvoiceStatus.UNPAID,
        dueDate: { not: null, lte: horizon },
        dunningRemindedAt: null,
      },
      select: {
        id: true,
        number: true,
        dueDate: true,
        amountTtcCents: true,
        currency: true,
        customer: { select: { email: true, name: true } },
      },
      take: 25,
    });
    let reminded = 0;
    for (const inv of due) {
      const cas = await this.prisma.invoice.updateMany({
        where: { id: inv.id, status: InvoiceStatus.UNPAID, dunningRemindedAt: null },
        data: { dunningRemindedAt: now },
      });
      if (cas.count !== 1) continue;
      reminded += 1;
      await this.audit.record({
        action: 'billing.dunning_reminder',
        resourceType: 'invoice',
        resourceId: inv.id,
        details: { number: inv.number, dueDate: inv.dueDate, amountTtcCents: inv.amountTtcCents },
      });
      await this.mail
        .sendPlain({
          to: inv.customer.email,
          subject: `Rappel : facture ${inv.number} à régler`,
          text: [
            `Bonjour ${inv.customer.name || ''},`.trim(),
            '',
            `Votre facture ${inv.number} d'un montant de ${(
              inv.amountTtcCents / 100
            ).toFixed(2)} ${inv.currency} est à régler avant le ${
              inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : 'date non définie'
            }.`,
            '',
            'Vous pouvez régler depuis votre espace client (portefeuille).',
            clientAreaUrl(),
          ].join('\n'),
        })
        .catch((e) => this.log.warn(`dunning mail invoice=${inv.id} failed: ${String(e)}`));
    }
    return reminded;
  }

  // ───────────────────── 4. Suspension à échéance ───────────────────────────

  private async suspendOverdue(): Promise<number> {
    const settings = await this.prisma.billingSetting.findFirst({ orderBy: { createdAt: 'asc' } });
    const graceDays = clampDays(settings?.dunningGraceDays, 14);
    const now = new Date();
    const cutoff = new Date(now.getTime() - graceDays * 86_400_000);
    const overdue = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.UNPAID, dueDate: { not: null, lt: cutoff } },
      select: {
        id: true,
        number: true,
        dueDate: true,
        customer: { select: { userId: true, email: true, name: true } },
      },
      take: 25,
    });
    let suspended = 0;
    for (const inv of overdue) {
      const userId = inv.customer.userId;
      if (!userId) continue;
      const sub = await this.prisma.subscription.findFirst({
        where: { userId, status: SubscriptionStatus.ACTIVE },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!sub) continue; // déjà suspendu/annulé → idempotent
      const cas = await this.prisma.subscription.updateMany({
        where: { id: sub.id, status: SubscriptionStatus.ACTIVE },
        data: { status: SubscriptionStatus.SUSPENDED },
      });
      if (cas.count !== 1) continue;
      suspended += 1;
      await this.audit.record({
        action: 'subscription.auto_suspend',
        resourceType: 'subscription',
        resourceId: sub.id,
        details: {
          reason: 'invoice_overdue',
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          dueDate: inv.dueDate,
          graceDays,
        },
      });
      await this.mail
        .sendPlain({
          to: inv.customer.email,
          subject: `Abonnement suspendu — facture ${inv.number} impayée`,
          text: [
            `Bonjour ${inv.customer.name || ''},`.trim(),
            '',
            `Votre facture ${inv.number} n'a pas été réglée dans le délai de grâce`,
            `(${graceDays} jours après échéance). Votre abonnement est suspendu :`,
            'le renouvellement est bloqué et l’accès est suspendu.',
            '',
            'Réglez depuis votre espace client puis contactez le support pour réactiver.',
            clientAreaUrl(),
          ].join('\n'),
        })
        .catch((e) => this.log.warn(`suspend mail invoice=${inv.id} failed: ${String(e)}`));
    }
    return suspended;
  }
}
