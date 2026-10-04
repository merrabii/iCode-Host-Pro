import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  BillingCycle,
  InvoiceLineKind,
  InvoiceStatus,
  OrderStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailSettingsService } from '../mail/mail-settings.service';
import { CheckoutService } from './checkout.service';
import { claimInvoiceSequence } from './invoice-sequence';
import { SuspensionEffectsService, applyHostingStatusInTx } from './suspension-effects.service';
import {
  RENEWAL_SCHEMA,
  acquireSweepLease,
  releaseSweepLease,
  sweepSchemaPrereqsOk,
} from './sweep-guards';
import { clientAreaUrl } from './web-links';

/** Env : période du scheduler de renouvellement (ms). `0`/absente → 60000. */
export const RENEWAL_SWEEP_MS_ENV = 'RENEWAL_SWEEP_MS';
/** Env : ACTIVATION EXPLICITE du timer (Q6, GO item 6). Absent ≠ 'true' → aucun timer. */
export const RENEWAL_SWEEP_ENABLED_ENV = 'RENEWAL_SWEEP_ENABLED';

/** Nom de la row `SweepLease` de ce sweep (exclusion multi-processus). */
export const RENEWAL_SWEEP_LEASE = 'renewal';

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
 *  1. **Renouvellement** (`autoRenew` + `nextBillingDate` échue +
 *     `renewalConsentAt` enregistré = consentement explicite Q-A, commande de la
 *     famille payée, souscription liée à la CHAÎNE et ACTIVE du même produit) →
 *     NOUVELLE commande (`renewsOrderId` chaîné, la mère bascule
 *     `autoRenew=false` dans la MÊME transaction : UNE seule tentative à la
 *     fois, contrainte unique en secours) + NOUVELLE facture UNPAID (numéros
 *     partagés D1, mentions/échéance figées, lignes RÉCURRENTES seulement).
 *     Puis **paiement atomique** : `CheckoutService.payOrderWithWallet`
 *     (débit + confirmation UNE SEULE transaction, clé `wallet-pay:<orderId>`,
 *     sans crédit compensatoire) → commande renouvellement PAID → ACTIVE sans
 *     provisioning (service inchangé). Solde insuffisant → facture reste UNPAID
 *     (la période suivante n'est JAMAIS ouverte avant règlement).
 *  2. **Reprise/relance de paiement** : renouvellement PENDING sans prélevement
 *     → réessai (le client a pu recharger) ; prélevé mais non confirmé (crash
 *     entre le débit et la confirmation) → re-confirmation idempotente.
 *  3. **Dunning** : facture UNPAID à `dueDate - dunningReminderDays` → UNE
 *     relance (marqueur `Invoice.dunningRemindedAt`, colonne P8) = audit +
 *     email best-effort.
 *  4. **Suspension à échéance** : facture UNPAID au-delà de
 *     `dueDate + dunningGraceDays` → **SOUSCRIPTION DE CETTE FACTURE**
 *     (résolution stricte facture → abonnement, jamais « le dernier abonnement
 *     actif du client ») ACTIVE → SUSPENDED (CAS **sous verrou** `FOR UPDATE`
 *     facture puis abonnement, impayé ET états revérifiés avant toute
 *     transition), services hébergement de CET abonnement ACTIVE → SUSPENDED
 *     dans la MÊME transaction (probe schéma préalable).
 *
 * **Effet provider (Q5, GO item 5)** : après commit, **arrêt réversible** des
 * applications concernées via `SuspensionEffectsService` (transport simulé en
 * test, C4 sous flag, aucune suppression). L'email client ne revendique **jamais**
 * « l'accès suspendu » quand seul le statut a changé : il décrit l'état
 * réellement constaté (arrêt confirmé / bloqué / échec visible). Toute
 * réactivation est contrôlée (whitelist admin) et rejoue la relance des apps.
 *
 * Timer simple (`setInterval`, sans dépendance) **OFF par défaut (Q6, GO
 * item 6)** : il ne démarre QUE sur activation explicite
 * (`RENEWAL_SWEEP_ENABLED=true`). L'exclusion multi-processus repose sur le
 * lease en base `SweepLease` (le booléen `running` local n'est qu'une passe
 * rapide ; les invariants métier, eux, sont garantis par les CAS par ligne de
 * chaque passe) et les prérequis de schéma sont probeés avant toute mutation.
 * `sweep()` reste PUBLIC et testable directement (horloge accélérée =
 * échéance rétrogradée en base), y compris via l'endpoint admin.
 */
@Injectable()
export class RenewalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RenewalService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly checkout: CheckoutService,
    private readonly mail: MailSettingsService,
    private readonly effects: SuspensionEffectsService,
  ) {}

  onModuleInit(): void {
    // Q6 (GO item 6) : ACTIVATION EXPLICITE — sans `=true` exact, AUCUN timer
    // (aucun renouvellement, aucun débit, aucun dunning, aucune suspension
    // automatique au démarrage).
    if (process.env[RENEWAL_SWEEP_ENABLED_ENV] !== 'true') return;
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

  /**
   * Un passage complet. Idempotent.
   * Ordre des gardes (Q6) : booléen local (passe rapide) → **prérequis de
   * schéma avant toute mutation** → **lease multi-processus** (`SweepLease`)
   * → passes. Chaque mutation individuelle reste en CAS/verrou par ligne
   * (autoRenew, dunningRemindedAt, verrous `FOR UPDATE`, clé wallet) : les
   * invariants tiennent même si deux processus se chevauchent autour du lease.
   */
  async sweep(): Promise<{
    created: number;
    paid: number;
    pending: number;
    reminded: number;
    suspended: number;
    stopped: number;
  }> {
    const zero = { created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 };
    if (this.running) return zero;
    // 1. Prérequis de schéma AVANT toute mutation (base pré-socle → skip).
    if (!(await sweepSchemaPrereqsOk(this.prisma, RENEWAL_SCHEMA))) {
      this.log.warn('renewal sweep: prérequis de schéma absents — passage ignoré');
      return zero;
    }
    // 2. Exclusion réelle entre processus (lease à expiration en base).
    const lease = await acquireSweepLease(this.prisma, RENEWAL_SWEEP_LEASE);
    if (!lease) {
      this.log.warn('renewal sweep: passe déjà en cours (autre processus) — passage ignoré');
      return zero;
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
      await releaseSweepLease(this.prisma, RENEWAL_SWEEP_LEASE, lease);
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
    // Échu + cycle récurrent + CONSENTEMENT enregistré (Q-A : sans
    // `renewalConsentAt`, AUCUN prélèvement automatique n'est planifié — les
    // têtes héritées sans consentement sont simplement ignorées) + famille
    // payée (PAID/PROVISIONING/ACTIVE).
    const heads = await this.prisma.order.findMany({
      where: {
        autoRenew: true,
        renewalConsentAt: { not: null },
        nextBillingDate: { lte: now },
        billingCycle: { not: BillingCycle.ONETIME },
        status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING, OrderStatus.ACTIVE] },
      },
      select: {
        id: true,
        renewsOrderId: true,
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
        renewalConsentAt: true,
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
        const gate = await this.gateSubscription(head, head.customer.userId);
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
            amountTtcCents: made.invoice.amountTtcCents,
            missedBillingDate: head.nextBillingDate,
            billingCycle: head.billingCycle,
          },
        });
        const outcome = await this.attemptPayment(
          made.renewal.id,
          made.invoice.amountTtcCents,
          { userId: head.customer.userId, email: head.customerEmail },
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
   * Garde d'éligibilité (lecture seule) — Q-A (item 4) : l'abonnement est
   * résolu par la CHAÎNE de renouvellements (`renewsOrderId`, garde 50), et
   * par l'abonnement porté par la facture de l'échéance quand il existe —
   * JAMAIS « simplement le dernier abonnement actif » du compte :
   * - `ok`   : abonnement lié à la chaîne, ACTIVE, même produit → renouveler ;
   * - `skip` : lié mais PENDING/SUSPENDED → on n'arrête PAS la chaîne
   *            (l'admin peut réactiver ; le renouvellement reprendra) ;
   * - `stop` : lié CANCELLED/REJECTED, ou aucun abonnement lié ;
   * - `stop_product` : abonnement lié d'un AUTRE produit (upgrade).
   * Fallback documenté : SANS lien de chaîne (données avant traçabilité
   * facture→abonnement), repli sur l'ancien comportement P8.
   */
  private async gateSubscription(
    head: { id: string; renewsOrderId: string | null; productId: string },
    userId: string | null,
  ): Promise<'ok' | 'skip' | 'stop' | 'stop_product'> {
    if (!userId) return 'stop';
    const chain: string[] = [head.id];
    let cursor = head.renewsOrderId;
    for (let guard = 0; cursor && guard < 50; guard++) {
      chain.push(cursor);
      const parent = await this.prisma.order.findUnique({
        where: { id: cursor },
        select: { renewsOrderId: true },
      });
      cursor = parent?.renewsOrderId ?? null;
    }
    const linked = await this.prisma.subscription.findFirst({
      where: { userId, orderId: { in: chain } },
      select: { productId: true, status: true },
    });
    if (linked) {
      if (linked.status === SubscriptionStatus.ACTIVE) {
        return linked.productId === head.productId ? 'ok' : 'stop_product';
      }
      if (
        linked.status === SubscriptionStatus.SUSPENDED ||
        linked.status === SubscriptionStatus.PENDING
      ) {
        return 'skip';
      }
      return 'stop'; // CANCELLED / REJECTED
    }
    // Fallback données pré-lien : ancien comportement P8 conservé.
    const active = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      select: { productId: true },
    });
    if (active) return active.productId === head.productId ? 'ok' : 'stop_product';
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
      renewsOrderId: string | null;
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
      renewalConsentAt: Date | null;
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
      // Q-A (item 4) — SEULEMENT les lignes RÉCURRENTES sont renouvelées :
      // produit/option/addons. Les lignes une-fois (frais d'installation =
      // ADJUSTMENT, crédits...) ne réapparaissent JAMAIS ; les totaux sont
      // RECALCULÉS depuis ces lignes (jamais recopiés tels quels).
      const recurringLines = (motherInv?.lines ?? []).filter(
        (l) =>
          l.kind === InvoiceLineKind.PRODUCT ||
          l.kind === InvoiceLineKind.OPTION ||
          l.kind === InvoiceLineKind.ADDON,
      );
      if (motherInv && recurringLines.length === 0) {
        // Rien de récurrent à facturer : la tête vient d'être close (flip ci-
        // dessus) — tracée dans l'historique, aucun renouvellement fabriqué.
        await tx.orderStatusHistory.create({
          data: {
            orderId: head.id,
            status: OrderStatus.PAID,
            note: 'Renouvellement close : aucune ligne récurrente sur la facture mère.',
            actorEmail: null,
          },
        });
        return null;
      }
      const computed = motherInv
        ? {
            amountHtCents: recurringLines.reduce(
              (s, l) => s + l.unitPriceHtCents * l.qty,
              0,
            ),
            taxAmountCents: recurringLines.reduce((s, l) => s + l.taxAmountCents, 0),
            amountTtcCents: recurringLines.reduce((s, l) => s + l.totalTtcCents, 0),
          }
        : {
            amountHtCents: head.amountHtCents,
            taxAmountCents: head.taxAmountCents,
            amountTtcCents: head.amountTtcCents,
          };

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
          // Q-A (item 4) : devise de la TÊTE (jamais une devise « réclamée »)
          // + consentement hérité de la tête (la chaîne reste traçable).
          currency: head.currency,
          taxRatePercent: head.taxRatePercent,
          amountHtCents: computed.amountHtCents,
          taxAmountCents: computed.taxAmountCents,
          amountTtcCents: computed.amountTtcCents,
          paymentMethodId: head.paymentMethodId,
          paymentMethodName: head.paymentMethodName,
          optionsSnapshot: head.optionsSnapshot ?? Prisma.JsonNull,
          addonsSnapshot: head.addonsSnapshot ?? Prisma.JsonNull,
          renewsOrderId: head.id,
          renewalConsentAt: head.renewalConsentAt,
        },
      });

      const invoice = await tx.invoice.create({
        data: {
          number: claim.invoiceNumber,
          orderId: renewal.id,
          customerId: head.customerId,
          status: InvoiceStatus.UNPAID,
          currency: head.currency,
          taxRatePercent: head.taxRatePercent,
          amountHtCents: computed.amountHtCents,
          taxAmountCents: computed.taxAmountCents,
          amountTtcCents: computed.amountTtcCents,
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
                create: recurringLines.map((l, i) => ({
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
   * Q-A (item 1) — paiement ATOMIQUE d'un renouvellement : débit + confirmation
   * dans UNE transaction (`CheckoutService.payOrderWithWallet`, clé
   * `wallet-pay:<orderId>`), JAMAIS de crédit compensatoire (le rollback de la
   * tx est le seul compensateur). `amount <= 0` → confirmation `free` (aucun
   * mouvement). Retourne `paid` ou `pending` : solde insuffisant, devise non
   * prise en charge, commande non trouvée ou non au propriétaire → relancé par
   * la passe suivante (jamais de débit silencieux).
   */
  private async attemptPayment(
    orderId: string,
    amountCents: number,
    owner: { userId: string | null; email: string },
    label: string,
  ): Promise<'paid' | 'pending'> {
    if (amountCents <= 0) {
      await this.checkout.confirmOrderPaid(orderId, { source: 'free' });
      return 'paid';
    }
    if (!owner.userId) {
      // Aucun compte lié au dossier : aucun prélèvement n'est JAMAIS possible.
      this.log.warn(`renewal payment order=${orderId} pending: aucun compte lié (${label})`);
      return 'pending';
    }
    try {
      await this.checkout.payOrderWithWallet(orderId, {
        sub: owner.userId,
        email: owner.email,
        role: Role.USER,
      });
      return 'paid';
    } catch (e) {
      if (e instanceof ConflictException || e instanceof NotFoundException) {
        this.log.warn(`renewal payment order=${orderId} pending (${label}): ${String(e)}`);
        return 'pending';
      }
      throw e;
    }
  }

  /**
   * Reprise : les renouvellements PENDING sont RE-VALIDÉS (garde d'éligibilité,
   * Q-A : jamais de prélèvement sur une chaîne close/suspendue/produit changé
   * depuis la création) puis re-prélevés/confirmés par le paiement atomique
   * (`payOrderWithWallet`) — qui sait lui-même récupérer un débit legacy non
   * compensé (confirmation SANS second débit) et refuser un double débit.
   */
  private async payPendingRenewals(): Promise<{ paid: number; pending: number }> {
    const pendingOrders = await this.prisma.order.findMany({
      where: { renewsOrderId: { not: null }, status: OrderStatus.PENDING_PAYMENT },
      select: {
        id: true,
        renewsOrderId: true,
        productId: true,
        amountTtcCents: true,
        customerEmail: true,
        customer: { select: { userId: true } },
        invoice: { select: { number: true } },
      },
      take: 10,
    });
    let paid = 0;
    let pending = 0;
    for (const o of pendingOrders) {
      try {
        const gate = await this.gateSubscription(o, o.customer.userId);
        if (gate !== 'ok') {
          // Chaîne close / suspendue / produit changé depuis la création :
          // AUCUN débit (la facture reste UNPAID, gérée par dunning/suspension).
          pending += 1;
          continue;
        }
        const outcome = await this.attemptPayment(
          o.id,
          o.amountTtcCents,
          { userId: o.customer.userId, email: o.customerEmail },
          o.invoice?.number ?? 'reprise',
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

  /**
   * Q5 (GO item 5) — suspension des impayés :
   *  - **portée** : une facture impayée n'affecte QUE l'abonnement auquel elle
   *    se rapporte (`Invoice.subscriptionId` → abonnement de sa commande →
   *    chaîne `renewsOrderId`) — JAMAIS « le dernier abonnement actif du
   *    client » (un second abonnement du même client reste intact) ;
   *  - **verrou** : facture `FOR UPDATE` puis abonnement `FOR UPDATE`, impayé
   *    ET états revérifiés dans la transaction avant toute transition (la
   *    course paiement/suspension est sérialisée : un règlement committé est
   *    vu sous verrou → aucune suspension) ;
   *  - **services** : les HostingService de CET abonnement passent
   *    ACTIVE → SUSPENDED dans la MÊME transaction (probe schéma préalable) ;
   *  - **effets provider post-commit** : arrêt réversible des apps via
   *    `SuspensionEffectsService` (aucune suppression), résumé honnête dans
   *    l'email (aucune revendication d'« accès suspendu » sur un simple
   *    changement de statut).
   */
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
        amountTtcCents: true,
        currency: true,
        subscriptionId: true,
        orderId: true,
        customer: { select: { userId: true, email: true, name: true } },
      },
      take: 25,
    });
    let suspended = 0;
    for (const inv of overdue) {
      const outcome = await this.suspendOneOverdue(inv, cutoff, graceDays);
      if (outcome) suspended += 1;
    }
    return suspended;
  }

  /** Une facture : verrou + relecture + transition + effets (post-commit). */
  private async suspendOneOverdue(
    inv: {
      id: string;
      number: string;
      dueDate: Date | null;
      amountTtcCents: number;
      currency: string;
      subscriptionId: string | null;
      orderId: string | null;
      customer: { userId: string | null; email: string; name: string | null };
    },
    cutoff: Date,
    graceDays: number,
  ): Promise<boolean> {
    const committed = await this.suspendOneInTx(inv, cutoff);
    if (!committed) return false;

    await this.audit
      .record({
        action: 'subscription.auto_suspend',
        resourceType: 'subscription',
        resourceId: committed.subId,
        details: {
          reason: 'invoice_overdue',
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          dueDate: inv.dueDate,
          graceDays,
          scope: 'invoice_subscription',
        },
      })
      .catch((e) => this.log.warn(`suspend audit sub=${committed.subId} failed: ${String(e)}`));

    // Effets provider post-commit (jamais dans la TX) : arrêt réversible,
    // aucune suppression ; échecs/blocages tracés et comptabilisés.
    const effects = await this.effects
      .suspendApps({
        subscriptionId: committed.subId,
        holder: 'system:renewal-sweep',
        orderId: committed.orderId,
      })
      .catch((e): SuspensionEffectsSummaryLike => {
        this.log.warn(`suspend effects sub=${committed.subId} failed: ${String(e)}`);
        return { apps: 0, done: 0, blocked: 0, failed: 0 };
      });

    await this.mail
      .sendPlain({
        to: inv.customer.email,
        subject: `Abonnement suspendu — facture ${inv.number} impayée`,
        text: [
          `Bonjour ${inv.customer.name || ''},`.trim(),
          '',
          `Votre facture ${inv.number} d'un montant de ${(
            inv.amountTtcCents / 100
          ).toFixed(2)} ${inv.currency} n'a pas été réglée dans le délai de grâce`,
          `(${graceDays} jours après échéance).`,
          '',
          'Votre abonnement est suspendu : le renouvellement automatique est bloqué.',
          effects.done > 0
            ? `${effects.done} application(s) hébergée(s) ont été arrêtée(s) de façon réversible : aucune donnée ni ressource n'a été supprimée.`
            : 'Aucune donnée ni ressource n’a été supprimée.',
          effects.blocked > 0 || effects.failed > 0
            ? `Arrêt d'applications non constaté sur ${effects.blocked + effects.failed} application(s) (bloqué ou en échec) : contactez le support.`
            : '',
          '',
          'Réglez depuis votre espace client : la réactivation est contrôlée après régularisation,',
          'sans double facturation.',
          clientAreaUrl(),
        ]
          .filter(Boolean)
          .join('\n'),
      })
      .catch((e) => this.log.warn(`suspend mail invoice=${inv.id} failed: ${String(e)}`));
    return true;
  }

  /** Transaction de suspension : verrous + revérification + CAS + services. */
  private async suspendOneInTx(
    inv: { id: string; subscriptionId: string | null; orderId: string | null },
    cutoff: Date,
  ): Promise<{ subId: string; orderId: string | null } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Verrou facture — l'état est revérifié SOUS VERROU.
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            dueDate: Date | null;
            subscriptionId: string | null;
            orderId: string | null;
          }>
        >`
          SELECT "id", "status", "dueDate", "subscriptionId", "orderId"
          FROM "Invoice" WHERE "id" = ${inv.id} FOR UPDATE`;
        const row = rows[0];
        if (!row) return null;
        if (row.status !== InvoiceStatus.UNPAID) return null; // réglée sous verrou
        if (!row.dueDate || row.dueDate >= cutoff) return null; // plus échue sous verrou

        // 2. Portée stricte : l'abonnement AUQUEL la facture se rapporte.
        const subId = await this.resolveSubscriptionIdInTx(tx, row);
        if (!subId) return null; // facture sans lien → AUCUNE autre souscription touchée

        // 3. Verrou abonnement + état revérifié.
        const subs = await tx.$queryRaw<Array<{ id: string; status: string; orderId: string | null }>>`
          SELECT "id", "status", "orderId" FROM "Subscription"
          WHERE "id" = ${subId} FOR UPDATE`;
        const sub = subs[0];
        if (!sub || sub.status !== SubscriptionStatus.ACTIVE) return null;

        // 4. CAS ACTIVE → SUSPENDED (deux sweeps concurrents → un seul gagne).
        const cas = await tx.subscription.updateMany({
          where: { id: subId, status: SubscriptionStatus.ACTIVE },
          data: { status: SubscriptionStatus.SUSPENDED },
        });
        if (cas.count !== 1) return null;

        // 5. Services hébergement de CET abonnement, MÊME transaction
        //    (probe schéma : base pré-C1 sans table → skip, jamais d'erreur).
        await applyHostingStatusInTx(
          tx,
          subId,
          'ACTIVE',
          'SUSPENDED',
        );

        return { subId, orderId: row.orderId ?? sub.orderId };
      });
    } catch (e) {
      this.log.warn(`suspend invoice=${inv.id} failed: ${String(e)}`);
      return null;
    }
  }

  /** Résolution stricte facture → abonnement (Q5). Jamais « dernier actif ». */
  private async resolveSubscriptionIdInTx(
    tx: Prisma.TransactionClient,
    row: { subscriptionId: string | null; orderId: string | null },
  ): Promise<string | null> {
    if (row.subscriptionId) {
      const s = await tx.subscription.findFirst({
        where: { id: row.subscriptionId },
        select: { id: true },
      });
      return s?.id ?? null;
    }
    if (!row.orderId) return null;
    const byOrder = await tx.subscription.findFirst({
      where: { orderId: row.orderId },
      select: { id: true },
    });
    if (byOrder) return byOrder.id;
    // Chaîne de renouvellement : remonte renewsOrderId vers l'abonnement d'origine.
    let cursor = row.orderId;
    for (let i = 0; i < 25; i += 1) {
      const parent = await tx.order.findUnique({
        where: { id: cursor },
        select: { renewsOrderId: true },
      });
      if (!parent?.renewsOrderId) return null;
      const chained = await tx.subscription.findFirst({
        where: { orderId: parent.renewsOrderId },
        select: { id: true },
      });
      if (chained) return chained.id;
      cursor = parent.renewsOrderId;
    }
    return null;
  }
}

/** Résumé d'effets utilisé pour le mail honnête (structure de secours). */
interface SuspensionEffectsSummaryLike {
  apps: number;
  done: number;
  blocked: number;
  failed: number;
}
