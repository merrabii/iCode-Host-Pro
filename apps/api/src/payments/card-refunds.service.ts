import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CardPayment,
  CardPaymentStatus,
  Prisma,
  Refund,
  RefundKind,
  RefundStatus,
  WalletTransactionType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types';
import {
  assertRefundIdempotencyKey,
  refundCapExceeded,
} from '../store/refund.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectorRefundOutcome } from './payment-connector';
import { PaymentProviderService } from './payment-provider.service';
import { StripeHttpError } from './stripe-connector';

export interface CardRefundView {
  id: string;
  cardPaymentId: string;
  paymentReference: string;
  kind: RefundKind;
  status: RefundStatus;
  amountCents: number;
  currency: string;
  reason: string | null;
  failureReason: string | null;
  providerRef: string | null;
  walletTransactionId: string | null;
  pendingProviderCall: boolean;
  createdByEmail: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

/**
 * GO Stripe §6 — remboursement d'une RECHARGE carte vers la CARTE.
 *
 * Distinctions assumées (GO) :
 *  - commande → portefeuille : reste porté par `RefundService` (WALLET_CREDIT) ;
 *  - recharge → carte : CE service (EXTERNAL_CARD), rattaché à `CardPayment`,
 *    à son compte marchand et à sa devise d'origine ;
 *  - plafond cumulé sur le paiement (PENDING + SUCCEEDED + réservations) ;
 *  - idempotence par `Idempotency-Key` (aucun double remboursement) ;
 *  - le crédit de recharge est REVERSÉ (débit wallet) dans le même tour que
 *    l'intention : si le solde est insuffisant (crédit déjà dépensé) le
 *    remboursement est REFUSÉ explicitement — jamais de dette implicite ;
 *  - appel prestataire APRÈS la réservation (ordre sûr) : échec réseau =
 *    statut PENDING ré-exploitable (retry), échec définitif = compensation
 *    (recrédit idempotent) + statut FAILED.
 */
@Injectable()
export class CardRefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly provider: PaymentProviderService,
    private readonly audit: AuditService,
  ) {}

  private toView(
    refund: Refund,
    paymentReference: string,
  ): CardRefundView {
    return {
      id: refund.id,
      cardPaymentId: refund.cardPaymentId ?? '',
      paymentReference,
      kind: refund.kind,
      status: refund.status,
      amountCents: refund.amountCents,
      currency: refund.currency,
      reason: refund.reason,
      failureReason: refund.failureReason,
      providerRef: refund.providerRef,
      walletTransactionId: refund.walletTransactionId,
      pendingProviderCall:
        refund.kind === RefundKind.EXTERNAL_CARD &&
        refund.status === RefundStatus.PENDING &&
        !refund.providerRef,
      createdByEmail: refund.createdByEmail,
      createdAt: refund.createdAt,
      processedAt: refund.processedAt,
    };
  }

  /** Somme déjà engagée (acceptée prestataire) sur CE paiement. */
  private engagedCents(row: {
    refundedCents: number;
    id: string;
  }): number {
    return row.refundedCents;
  }

  /**
   * Réservations en cours (intention créée, appel prestataire non conclu) —
   * comptées dans le plafond pour qu'une reprise ne puisse jamais dépasser
   * le montant encaissé.
   */
  private async reservedCents(tx: Prisma.TransactionClient, cardPaymentId: string): Promise<number> {
    const agg = await tx.refund.aggregate({
      where: {
        cardPaymentId,
        status: RefundStatus.PENDING,
        providerRef: null,
      },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  private statusFor(refundedCents: number, amountCents: number): CardPaymentStatus {
    if (refundedCents <= 0) return CardPaymentStatus.SUCCEEDED;
    return refundedCents >= amountCents
      ? CardPaymentStatus.REFUNDED
      : CardPaymentStatus.PARTIALLY_REFUNDED;
  }

  // ── intention (admin) ───────────────────────────────────────────────────

  async createTopupRefund(
    input: {
      cardPaymentId: string;
      amountCents: number;
      reason?: string | null;
      idempotencyKey?: string;
    },
    actor: JwtPayload,
  ): Promise<CardRefundView> {
    const key = assertRefundIdempotencyKey(input.idempotencyKey);

    const prepared = await this.prisma.$transaction(async (tx) => {
      // Verrou PAIEMENT (ordre canonique : paiement → client).
      const rows = await tx.$queryRaw<CardPayment[]>`
        SELECT * FROM "CardPayment" WHERE id = ${input.cardPaymentId} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('Paiement introuvable.');
      const pay = rows[0];

      // Idempotence AVANT tout effet.
      const existing = await tx.refund.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (
          existing.cardPaymentId !== pay.id ||
          existing.amountCents !== input.amountCents ||
          existing.kind !== RefundKind.EXTERNAL_CARD
        ) {
          throw new ConflictException(
            "Clé d'idempotence déjà utilisée pour une autre opération de remboursement.",
          );
        }
        return { refund: existing, reference: pay.reference, replayed: true };
      }

      if (
        pay.status !== CardPaymentStatus.SUCCEEDED &&
        pay.status !== CardPaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new ConflictException(
          `Remboursement carte impossible sur un paiement « ${pay.status} » : seul un paiement encaissé peut être remboursé.`,
        );
      }

      const used =
        this.engagedCents(pay) + (await this.reservedCents(tx, pay.id));
      if (refundCapExceeded(pay.amountCents, used, input.amountCents)) {
        throw new ConflictException(
          `Plafond de remboursement dépassé : encaissé ${pay.amountCents} cents, déjà engagé ${used} cents, demandé ${input.amountCents} cents.`,
        );
      }

      // Verrou CLIENT : devise + solde sous verrou (jamais de dette implicite).
      const customers = await tx.$queryRaw<
        { walletBalanceCents: number; walletCurrency: string; email: string }[]
      >`
        SELECT "walletBalanceCents", "walletCurrency", email FROM "Customer"
        WHERE id = ${pay.customerId} FOR UPDATE`;
      if (customers.length === 0) throw new NotFoundException('Dossier client introuvable.');
      const customer = customers[0];
      if (customer.walletCurrency.toUpperCase() !== pay.currency.toUpperCase()) {
        throw new ConflictException(
          `Devise du paiement (${pay.currency}) ≠ devise du portefeuille (${customer.walletCurrency}) : aucune opération mixte.`,
        );
      }
      if (customer.walletBalanceCents < input.amountCents) {
        throw new ConflictException(
          `Solde insuffisant (${customer.walletBalanceCents} cents en ${customer.walletCurrency}) : ` +
            'le crédit de recharge a déjà été dépensé — remboursement carte REFUSÉ ' +
            '(aucune dette implicite, intervention requise).',
        );
      }

      let refund: Refund;
      try {
        refund = await tx.refund.create({
          data: {
            cardPaymentId: pay.id,
            kind: RefundKind.EXTERNAL_CARD,
            status: RefundStatus.PENDING,
            amountCents: input.amountCents,
            currency: pay.currency,
            reason: input.reason?.trim() || null,
            issueCreditNote: false,
            idempotencyKey: key,
            createdByUserId: actor.sub,
            createdByEmail: actor.email,
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          const raced = await tx.refund.findUnique({ where: { idempotencyKey: key } });
          if (raced) return { refund: raced, reference: pay.reference, replayed: true };
        }
        throw err;
      }

      // RÉVERSATION du crédit de recharge (débit) dans LE MÊME tour.
      await this.wallet.applyWithClient(
        tx,
        pay.customerId,
        {
          amountCents: input.amountCents,
          idempotencyKey: `cardrefund:${refund.id}`,
          currency: pay.currency.toUpperCase(),
          type: WalletTransactionType.DEBIT,
          // Pas de `reference` : `WalletTransaction.reference` est UNIQUE et
          // déjà portée par le crédit de cette recharge (CDP-…). Le lien se
          // fait par la note + `walletTransactionId` ci-dessous.
          note: `Remboursement recharge ${pay.reference} → carte`,
        },
        'debit',
      );

      // Traçabilité : rattachement wallet → remboursement (1 opération par
      // remboursement, contrainte UNIQUE côté Refund).
      const wtx = await tx.walletTransaction.findUnique({
        where: { idempotencyKey: `cardrefund:${refund.id}` },
        select: { id: true },
      });
      if (wtx) {
        refund = await tx.refund.update({
          where: { id: refund.id },
          data: { walletTransactionId: wtx.id },
        });
      }

      return { refund, reference: pay.reference, replayed: false };
    });

    if (prepared.replayed) {
      return this.toView(prepared.refund, prepared.reference);
    }

    await this.audit
      .record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'refund.topup.create',
        resourceType: 'cardPayment',
        resourceId: prepared.refund.cardPaymentId ?? prepared.refund.id,
        details: {
          refundId: prepared.refund.id,
          amountCents: prepared.refund.amountCents,
          currency: prepared.refund.currency,
          reference: prepared.reference,
          handling: 'réserve wallet + appel prestataire',
        },
      })
      .catch(() => undefined);

    return this.callProvider(prepared.refund, prepared.reference, actor);
  }

  // ── appel prestataire + confirmation / compensation ─────────────────────

  private async callProvider(
    refund: Refund,
    paymentReference: string,
    actor: JwtPayload,
  ): Promise<CardRefundView> {
    const payment = await this.prisma.cardPayment.findUnique({
      where: { id: refund.cardPaymentId ?? '' },
    });
    if (!payment || !payment.providerPaymentRef) {
      await this.failRefund(
        refund.id,
        paymentReference,
        'Aucune référence de paiement prestataire (impossible de rembourser).',
        actor,
        { recredit: true },
      );
      throw new ConflictException(
        'Référence prestataire absente : remboursement impossible (statut porté en échec, solde recrédité).',
      );
    }

    let outcome: ConnectorRefundOutcome;
    try {
      const resolved = await this.provider.resolve();
      outcome = await resolved.connector.createRefund({
        paymentRef: payment.providerPaymentRef,
        amountCents: refund.amountCents,
        idempotencyKey: refund.idempotencyKey,
      });
    } catch (err) {
      // INCERTITUDE (réseau/HTTP) : la réservation wallet est conservée et
      // l'intention reste PENDING ré-exploitable (retry idempotent).
      const message =
        err instanceof StripeHttpError || err instanceof Error
          ? err.message
          : String(err);
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'refund.topup.provider_call_deferred',
          resourceType: 'refund',
          resourceId: refund.id,
          details: { reason: message.slice(0, 300), handling: 'pending_retry' },
        })
        .catch(() => undefined);
      const fresh = await this.prisma.refund.findUnique({ where: { id: refund.id } });
      return this.toView(fresh ?? refund, paymentReference);
    }

    if (outcome.status === 'failed' || outcome.status === 'canceled') {
      await this.failRefund(
        refund.id,
        paymentReference,
        outcome.failureReason ?? `Réponse prestataire : ${outcome.status}.`,
        actor,
        { recredit: true, providerRef: outcome.providerRef },
      );
      const fresh = await this.prisma.refund.findUnique({ where: { id: refund.id } });
      return this.toView(fresh ?? refund, paymentReference);
    }

    // ACCEPTÉ (succeeded | pending | requires_action) : engagement définitif.
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CardPayment[]>`
        SELECT * FROM "CardPayment" WHERE id = ${refund.cardPaymentId} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('Paiement introuvable.');
      const pay = rows[0];
      const cas = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.PENDING },
        data: {
          providerRef: outcome.providerRef,
          processedAt: outcome.status === 'succeeded' ? new Date() : null,
          status: outcome.status === 'succeeded' ? RefundStatus.SUCCEEDED : RefundStatus.PENDING,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictException('Remboursement déjà confirmé ou clos.');
      }
      const refundedCents = Math.min(
        pay.refundedCents + refund.amountCents,
        pay.amountCents,
      );
      await tx.cardPayment.update({
        where: { id: pay.id },
        data: { refundedCents, status: this.statusFor(refundedCents, pay.amountCents) },
      });
      return tx.refund.findUnique({ where: { id: refund.id } });
    });

    await this.audit
      .record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action:
          updated?.status === RefundStatus.SUCCEEDED
            ? 'refund.topup.succeeded'
            : 'refund.topup.engaged',
        resourceType: 'refund',
        resourceId: refund.id,
        details: {
          providerRef: outcome.providerRef,
          amountCents: refund.amountCents,
          currency: refund.currency,
          providerStatus: outcome.status,
        },
      })
      .catch(() => undefined);

    return this.toView(updated ?? refund, paymentReference);
  }

  /** Échec définitif : statut FAILED + compensation idempotente du débit. */
  private async failRefund(
    refundId: string,
    paymentReference: string,
    reason: string,
    actor: JwtPayload,
    opts: { recredit: boolean; providerRef?: string },
  ): Promise<void> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.status !== RefundStatus.PENDING) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.refund.updateMany({
        where: { id: refundId, status: RefundStatus.PENDING },
        data: {
          status: RefundStatus.FAILED,
          failureReason: reason.slice(0, 300),
          providerRef: opts.providerRef ?? null,
          processedAt: new Date(),
        },
      });
        if (opts.recredit && refund.cardPaymentId) {
          const pay = await this.requirePayment(tx, refund.cardPaymentId);
          // Recrédit idempotent (clé distincte du débit) — jamais de double.
          await this.wallet.applyWithClient(
            tx,
            pay.customerId,
            {
              amountCents: refund.amountCents,
              idempotencyKey: `cardrefund-back:${refund.id}`,
              currency: refund.currency.toUpperCase(),
              type: WalletTransactionType.CREDIT,
              // `reference` volontairement absente : UNIQUE et déjà prise par
              // le crédit initial de la recharge (jamais de collision 500).
              note: `Échec remboursement carte ${paymentReference} : crédit restitué`,
            },
            'credit',
          );
        }

    });

    await this.audit
      .record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'refund.topup.failed',
        resourceType: 'refund',
        resourceId: refundId,
        details: { reason: reason.slice(0, 300), recredit: opts.recredit },
      })
      .catch(() => undefined);
  }

  private async requirePayment(
    tx: Prisma.TransactionClient,
    cardPaymentId: string,
  ): Promise<{ customerId: string }> {
    const row = await tx.cardPayment.findUnique({
      where: { id: cardPaymentId },
      select: { customerId: true },
    });
    if (!row) throw new NotFoundException('Paiement introuvable.');
    return row;
  }

  // ── reprise / annulation (admin) ────────────────────────────────────────

  /** Reprise d'un appel prestataire interrompu (même clé d'idempotence). */
  async retryProviderCall(refundId: string, actor: JwtPayload): Promise<CardRefundView> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.kind !== RefundKind.EXTERNAL_CARD) {
      throw new NotFoundException('Remboursement carte introuvable.');
    }
    if (refund.status !== RefundStatus.PENDING || refund.providerRef) {
      throw new ConflictException(
        'Seul un remboursement PENDING sans référence prestataire peut être repris.',
      );
    }
    const payment = await this.prisma.cardPayment.findUnique({
      where: { id: refund.cardPaymentId ?? '' },
      select: { reference: true },
    });
    if (!payment) throw new NotFoundException('Paiement introuvable.');
    return this.callProvider(refund, payment.reference, actor);
  }

  /** Abandon d'une intention non conclue : compensation + statut FAILED. */
  async cancelRefund(refundId: string, actor: JwtPayload, reason?: string): Promise<CardRefundView> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.kind !== RefundKind.EXTERNAL_CARD) {
      throw new NotFoundException('Remboursement carte introuvable.');
    }
    if (refund.status !== RefundStatus.PENDING || refund.providerRef) {
      throw new ConflictException(
        'Seul un remboursement PENDING sans référence prestataire peut être annulé.',
      );
    }
    const payment = await this.prisma.cardPayment.findUnique({
      where: { id: refund.cardPaymentId ?? '' },
      select: { reference: true },
    });
    if (!payment) throw new NotFoundException('Paiement introuvable.');
    await this.failRefund(
      refund.id,
      payment.reference,
      reason?.trim() || 'Annulé par l’administrateur.',
      actor,
      { recredit: true },
    );
    const fresh = await this.prisma.refund.findUnique({ where: { id: refund.id } });
    return this.toView(fresh ?? refund, payment.reference);
  }

  async listForPayment(cardPaymentId: string): Promise<CardRefundView[]> {
    const payment = await this.prisma.cardPayment.findUnique({
      where: { id: cardPaymentId },
      select: { reference: true },
    });
    if (!payment) throw new NotFoundException('Paiement introuvable.');
    const rows = await this.prisma.refund.findMany({
      where: { cardPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r, payment.reference));
  }
}
