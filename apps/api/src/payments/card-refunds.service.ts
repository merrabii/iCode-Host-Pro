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

  /** Somme déjà ENCAISSÉE côté prestataire (remboursements aboutis) — GO P6. */
  private engagedCents(row: {
    refundedCents: number;
    id: string;
  }): number {
    return row.refundedCents;
  }

  /**
   * Réservations/engagements en cours (intention créée, prestataire non
   * encore conclu) : comptés dans le plafond pour qu'une reprise ne puisse
   * jamais dépasser le montant encaissé.
   *
   * GO P6 — TOUT remboursement `PENDING` compte (avec ou sans `providerRef`) :
   * un engagement accepté par le prestataire reste réservé jusqu'à son issue
   * (aucun trou de plafond entre l'acceptation et le règlement).
   * Le compteur dénormalisé `pendingRefundCents` (maintenu sous verrou) ne
   * sert que de plancher : l'agrégat reste la vérité pour les lignes antérieures.
   */
  private async reservedCents(tx: Prisma.TransactionClient, cardPaymentId: string): Promise<number> {
    const agg = await tx.refund.aggregate({
      where: {
        cardPaymentId,
        status: RefundStatus.PENDING,
      },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  /** Engagés = encaissés + réservations (jamais comptés deux fois) — GO P6. */
  private async usedCents(
    tx: Prisma.TransactionClient,
    pay: { id: string; refundedCents: number; pendingRefundCents: number },
  ): Promise<number> {
    const reserved = Math.max(
      pay.pendingRefundCents ?? 0,
      await this.reservedCents(tx, pay.id),
    );
    return this.engagedCents(pay) + reserved;
  }

  private statusFor(refundedCents: number, amountCents: number): CardPaymentStatus {
    if (refundedCents <= 0) return CardPaymentStatus.SUCCEEDED;
    return refundedCents >= amountCents
      ? CardPaymentStatus.REFUNDED
      : CardPaymentStatus.PARTIALLY_REFUNDED;
  }

  /**
   * Libération d'une réservation — GO P6 : CAS borné (`>= montant`), le
   * compteur ne devient JAMAIS négatif même si deux chemins se croisent.
   */
  private async releaseReservation(
    tx: Prisma.TransactionClient,
    cardPaymentId: string | null,
    amountCents: number,
  ): Promise<void> {
    if (!cardPaymentId) return;
    await tx.cardPayment.updateMany({
      where: { id: cardPaymentId, pendingRefundCents: { gte: amountCents } },
      data: { pendingRefundCents: { decrement: amountCents } },
    });
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

      // GO P6 — plafond = ENCAISSÉS + RÉSERVATIONS + demandé ≤ encaissé.
      const used = await this.usedCents(tx, pay);
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

      // GO P6 — réservation DENORMALISÉE engagée sous verrou paiement
      // (libérée à l'issue, jamais de compteur négatif).
      await tx.cardPayment.update({
        where: { id: pay.id },
        data: { pendingRefundCents: { increment: input.amountCents } },
      });

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

  /**
   * GO P5 — émission SERIALISÉE : verrou LIGNE `Refund` (`FOR UPDATE`),
   * validation (PENDING, sans référence prestataire) puis `dispatchedAt`
   * COMMIS avant le moindre octet réseau. Aucun appel réseau sous transaction.
   *
   *  - deux émissions concurrentes = la seconde attend le verrou et repart
   *    avec la MÊME clé d'idempotence (jamais de double remboursement) ;
   *  - une annulation concurrente voit soit `status ≠ PENDING`, soit
   *    `dispatchedAt` renseigné → elle est REFUSÉE (réservation conservée).
   */
  private async enterDispatch(
    refundId: string,
  ): Promise<{ refund: Refund; payment: CardPayment } | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Refund[]>`
        SELECT * FROM "Refund" WHERE id = ${refundId} FOR UPDATE`;
      const refund = rows[0];
      if (
        !refund ||
        refund.kind !== RefundKind.EXTERNAL_CARD ||
        refund.status !== RefundStatus.PENDING ||
        refund.providerRef
      ) {
        return null;
      }
      if (!refund.dispatchedAt) {
        await tx.refund.updateMany({
          where: { id: refund.id, dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        });
      }
      const payment = refund.cardPaymentId
        ? await tx.cardPayment.findUnique({ where: { id: refund.cardPaymentId } })
        : null;
      if (!payment) return null;
      return { refund, payment };
    });
  }

  private async callProvider(
    refund: Refund,
    paymentReference: string,
    actor: JwtPayload,
  ): Promise<CardRefundView> {
    const entered = await this.enterDispatch(refund.id);
    if (!entered) {
      const fresh = await this.prisma.refund.findUnique({ where: { id: refund.id } });
      if (fresh && (fresh.status !== RefundStatus.PENDING || fresh.providerRef)) {
        // Déjà confirmé/clos par un autre chemin : aucun second appel.
        return this.toView(fresh, paymentReference);
      }
      throw new ConflictException(
        'Remboursement déjà en cours de traitement (appel prestataire concurrent).',
      );
    }
    const payment = entered.payment;
    if (!payment.providerPaymentRef) {
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
      // GO P4 — opération sous l'IDENTITÉ D'ORIGINE du paiement (fournisseur
      // + compte marchand), jamais la configuration active d'un autre compte.
      const resolved = await this.provider.resolveFor({
        providerCode: payment.providerCode,
        merchantAccount: payment.merchantAccount,
        environment: payment.environment,
      });
      outcome = await resolved.connector.createRefund({
        paymentRef: payment.providerPaymentRef,
        amountCents: refund.amountCents,
        idempotencyKey: refund.idempotencyKey,
      });
    } catch (err) {
      // INCERTITUDE (réseau/HTTP) OU identité refusée : la réservation wallet
      // est conservée et l'intention reste PENDING ré-exploirable (retry avec
      // la MÊME clé prestataire).
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

      if (outcome.status === 'succeeded') {
        // GO P6 — L'ENCAISSEMENT RÉEL seulement entre dans `refundedCents`
        // (aucun plafond silencieux : un cumul au-delà du montant encaissé est
        // signalé, jamais lissé).
        const refundedCents = pay.refundedCents + refund.amountCents;
        const overflow = refundedCents > pay.amountCents;
        await tx.cardPayment.update({
          where: { id: pay.id },
          data: {
            refundedCents,
            ...(overflow
              ? {
                  status: CardPaymentStatus.NEEDS_REVIEW,
                  interventionNeeded: true,
                  interventionReason: `remboursement cumulé (${refundedCents}) > montant encaissé (${pay.amountCents})`,
                }
              : { status: this.statusFor(refundedCents, pay.amountCents) }),
          },
        });
        await this.releaseReservation(tx, pay.id, refund.amountCents);
      }
      // GO P6 — accepté mais non réglé (pending/requires_action) : l'engagement
      // RESTE dans `pendingRefundCents`, `refundedCents` n'avance qu'au règlement.
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

  /**
   * Échec définitif : statut FAILED + compensation idempotente du débit.
   *
   * GO P5 — la compensation n'a lieu QUE si le CAS `PENDING → FAILED` a
   * réellement franchi UNE ligne : sinon le remboursement est déjà confirmé
   * (crédit chez le prestataire) et recréditer reviendrait à doubler.
   */
  private async failRefund(
    refundId: string,
    paymentReference: string,
    reason: string,
    actor: JwtPayload,
    opts: { recredit: boolean; providerRef?: string },
  ): Promise<void> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.status !== RefundStatus.PENDING) return;

    const done = await this.prisma.$transaction((tx) =>
      this.failRefundInTx(tx, refund, paymentReference, reason, opts),
    );
    if (!done) return;

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

  /** Cœur de l'échec, réutilisable DANS la transaction de l'appelant. */
  private async failRefundInTx(
    tx: Prisma.TransactionClient,
    refund: Refund,
    paymentReference: string,
    reason: string,
    opts: { recredit: boolean; providerRef?: string },
  ): Promise<boolean> {
    const cas = await tx.refund.updateMany({
      where: { id: refund.id, status: RefundStatus.PENDING },
      data: {
        status: RefundStatus.FAILED,
        failureReason: reason.slice(0, 300),
        providerRef: opts.providerRef ?? null,
        processedAt: new Date(),
      },
    });
    if (cas.count !== 1) return false; // déjà clos : AUCUNE compensation

    // Réservation libérée (CAS borné, compteur jamais négatif).
    await this.releaseReservation(tx, refund.cardPaymentId, refund.amountCents);

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
    return true;
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

  /**
   * Abandon d'une intention non conclue : compensation + statut FAILED.
   *
   * GO P5 — sérialisé avec l'émission par verrou LIGNE `Refund` :
   *  - `dispatchedAt` déjà renseigné → REFUS (le prestataire a pu créer le
   *    remboursement : recréditer reviendrait à doubler) ; la réservation
   *    wallet est CONSERVÉE et l'alerte est journalisée ;
   *  - sinon échec + recrédit dans LA MÊME transaction, conditionnés au CAS
   *    `PENDING → FAILED` (jamais de compensation sur une ligne déjà close).
   */
  async cancelRefund(refundId: string, actor: JwtPayload, reason?: string): Promise<CardRefundView> {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Refund[]>`
        SELECT * FROM "Refund" WHERE id = ${refundId} FOR UPDATE`;
      const refund = rows[0];
      if (!refund || refund.kind !== RefundKind.EXTERNAL_CARD) {
        throw new NotFoundException('Remboursement carte introuvable.');
      }
      if (refund.status !== RefundStatus.PENDING || refund.providerRef) {
        throw new ConflictException(
          'Seul un remboursement PENDING sans référence prestataire peut être annulé.',
        );
      }
      if (refund.dispatchedAt) {
        return { refund, reference: null as string | null, refused: true, applied: false };
      }
      const payment = refund.cardPaymentId
        ? await tx.cardPayment.findUnique({
            where: { id: refund.cardPaymentId },
            select: { reference: true },
          })
        : null;
      if (!payment) throw new NotFoundException('Paiement introuvable.');
      const applied = await this.failRefundInTx(
        tx,
        refund,
        payment.reference,
        reason?.trim() || 'Annulé par l’administrateur.',
        { recredit: true },
      );
      return { refund, reference: payment.reference, refused: false, applied };
    });

    if (result.refused) {
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'refund.topup.cancel_refused',
          resourceType: 'refund',
          resourceId: refundId,
          details: {
            dispatchedAt: result.refund.dispatchedAt,
            handling: 'reservation_conservee_verification_requise',
          },
        })
        .catch(() => undefined);
      throw new ConflictException(
        'Appel prestataire déjà émis pour ce remboursement : annulation refusée ' +
          '(réservation conservée — vérifiez le remboursement chez le prestataire avant toute compensation).',
      );
    }

    if (result.applied) {
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'refund.topup.failed',
          resourceType: 'refund',
          resourceId: refundId,
          details: {
            reason: reason?.trim() || 'Annulé par l’administrateur.',
            recredit: true,
          },
        })
        .catch(() => undefined);
    }
    const fresh = await this.prisma.refund.findUnique({ where: { id: refundId } });
    return this.toView(
      fresh ?? result.refund,
      result.reference ?? '—',
    );
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

  /**
   * GO P6 — issue d'un remboursement CONNU relue chez le prestataire
   * (`refund.created/updated/failed/canceled` signés).
   *
   *  - idempotent par `providerRef` (CAS `PENDING → …` : un rejeu n'a aucun
   *    effet supplémentaire) ;
   *  - limité au fournisseur ayant authentifié l'événement (GO P1) ;
   *  - `succeeded` = SEUL moment où `refundedCents` avance (réservation
   *    libérée, cumul signalé s'il dépasse l'encaissé, jamais lissé) ;
   *  - `failed`/`canceled` = compensation CAS + recrédit (la carte n'a rien
   *    reçu, le crédit de recharge est restitué) ;
   *  - `pending`/`requires_action` = engagement déjà enregistré, aucun effet.
   * `null` = remboursement INCONNU (traité par l'appelant comme un
   * remboursement hors plateforme, GO P6).
   */
  async applyProviderRefundStatus(input: {
    providerRef: string;
    status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
    providerCode: string;
  }): Promise<{
    refundId: string;
    cardPaymentId: string | null;
    status: RefundStatus;
    changed: boolean;
  } | null> {
    const refund = await this.prisma.refund.findFirst({
      where: { providerRef: input.providerRef },
    });
    if (!refund || refund.kind !== RefundKind.EXTERNAL_CARD) return null;

    const payment = refund.cardPaymentId
      ? await this.prisma.cardPayment.findUnique({ where: { id: refund.cardPaymentId } })
      : null;
    if (!payment) return null;
    // GO P1 — jamais d'effet pour un événement d'un autre fournisseur.
    if (payment.providerCode !== input.providerCode) return null;

    const base = {
      refundId: refund.id,
      cardPaymentId: refund.cardPaymentId,
      status: refund.status,
      changed: false,
    };

    if (input.status === 'pending' || input.status === 'requires_action') {
      return base; // engagement déjà compté, rien à faire
    }

    if (input.status === 'succeeded') {
      if (refund.status === RefundStatus.SUCCEEDED) return base; // idempotent
      const changed = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<CardPayment[]>`
          SELECT * FROM "CardPayment" WHERE id = ${payment.id} FOR UPDATE`;
        if (rows.length === 0) return false;
        const pay = rows[0];
        const cas = await tx.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.PENDING },
          data: { status: RefundStatus.SUCCEEDED, processedAt: new Date() },
        });
        if (cas.count !== 1) return false;
        const refundedCents = pay.refundedCents + refund.amountCents;
        const overflow = refundedCents > pay.amountCents;
        await tx.cardPayment.update({
          where: { id: pay.id },
          data: {
            refundedCents,
            ...(overflow
              ? {
                  status: CardPaymentStatus.NEEDS_REVIEW,
                  interventionNeeded: true,
                  interventionReason: `remboursement cumulé (${refundedCents}) > montant encaissé (${pay.amountCents})`,
                }
              : { status: this.statusFor(refundedCents, pay.amountCents) }),
          },
        });
        await this.releaseReservation(tx, pay.id, refund.amountCents);
        return true;
      });
      return {
        refundId: refund.id,
        cardPaymentId: refund.cardPaymentId,
        status: changed ? RefundStatus.SUCCEEDED : refund.status,
        changed,
      };
    }

    // failed / canceled : compensation CONDITIONNÉE au CAS.
    const changed = await this.prisma.$transaction((tx) =>
      this.failRefundInTx(
        tx,
        refund,
        payment.reference,
        `Issue prestataire « ${input.status} » (${input.providerRef}).`,
        { recredit: true, providerRef: input.providerRef },
      ),
    );
    const fresh = await this.prisma.refund.findUnique({ where: { id: refund.id } });
    return {
      refundId: refund.id,
      cardPaymentId: refund.cardPaymentId,
      status: fresh?.status ?? refund.status,
      changed,
    };
  }
}
