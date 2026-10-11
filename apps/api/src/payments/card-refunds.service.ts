import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CardPayment,
  CardPaymentKind,
  CardPaymentStatus,
  Prisma,
  Refund,
  RefundKind,
  RefundStatus,
  WalletTransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
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
import { syncRefundedCents } from './refund-accounting';
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
  /**
   * GO revue §3b — Stripe éponge les clés d'idempotence après au moins 24 h :
   * rejouer une demande PLUS VIEILLE que cette fenêtre n'est plus garantie
   * « même opération » → risque de SECOND remboursement. La reprise est donc
   * BORNÉE : passé 24 h, refus + intervention (jamais de relance à l'aveugle).
   */
  private static readonly IDEMPOTENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

  /**
   * GO V3 §1 — durée du lease d'une émission EN COURS : au-delà, une relance
   * peut déposséder le propriétaire (reprise contrôlée, même clé). Tant que
   * le lease court, AUCUNE seconde émission n'est possible.
   */
  private static readonly DISPATCH_LEASE_MS = 60_000;

  /** Jeton unique du propriétaire de l'émission en cours. */
  private newDispatchOwner(): string {
    return `${Date.now()}:${randomUUID()}`;
  }

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

      // GO revue §5c — un règlement de COMMANDE (kind = ORDER) n'a JAMAIS
      // crédité le portefeuille : le parcours « recharge » (qui débite le
      // crédit associé) lui est INTERDIT. Le remboursement suit son origine
      // via `POST /store/admin/orders/:orderId/refunds` (EXTERNAL_CARD, zéro
      // mouvement portefeuille).
      if (pay.kind === CardPaymentKind.ORDER || pay.orderId) {
        throw new ConflictException(
          `Paiement de commande (${pay.reference}) : le remboursement de recharge (débit portefeuille) ` +
            'est interdit — utilisez le remboursement de commande (POST /store/admin/orders/:orderId/refunds, ' +
            'vers la carte, sans mouvement portefeuille).',
        );
      }

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

      // GO revue §1 — incertitude prestataire non rapprochée : toute
      // opération dépendante du plafond est REFUSÉE tant que l'observation
      // sans montant n'est pas acquittée par l'admin (acknowledgedAt).
      const uncertain = await tx.refundObservation.findFirst({
        where: { cardPaymentId: pay.id, amountCents: null, acknowledgedAt: null },
        select: { providerRef: true },
      });
      if (uncertain) {
        throw new ConflictException(
          `Rapprochement requis : observation prestataire ${uncertain.providerRef} sans montant non acquittée — remboursement REFUSÉ tant que le rapprochement n'est pas effectué.`,
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
   * GO P5 + V3 §1 — émission SERIALISÉE : verrou LIGNE `Refund` (`FOR UPDATE`),
   * validation (PENDING, sans référence prestataire) puis revendication
   * EXCLUSIVE (`dispatchOwner` + lease `dispatchClaimedAt`) + `dispatchedAt`
   * COMMIS avant le moindre octet réseau. Aucun appel réseau sous transaction.
   *
   *  - une émission fraîche n'entre que si `dispatchedAt` est null (jamais
   *    envoyée) ;
   *  - une émission INTERROMPUE (PENDING, déjà dispatchée, lease expiré) est
   *    dépossédée par CAS conditionné aux valeurs observées — reprise avec la
   *    MÊME clé d'idempotence (jamais de double remboursement) ;
   *  - une émission encore sous lease (tentative vivante chez un pair) est
   *    REFUSÉE : la seconde requête n'émet aucun octet réseau ;
   *  - une annulation concurrente voit soit `status ≠ PENDING`, soit
   *    `dispatchedAt` renseigné → elle est REFUSÉE (réservation conservée).
   */
  private async enterDispatch(
    refundId: string,
  ): Promise<{ refund: Refund; payment: CardPayment; owner: string } | null> {
    const owner = this.newDispatchOwner();
    const now = new Date();
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
        // Fraîche : revendication exclusive (sous verrou, sérialisée).
        const claimed = await tx.refund.updateMany({
          where: { id: refund.id, dispatchedAt: null, dispatchOwner: null },
          data: {
            dispatchedAt: now,
            dispatchOwner: owner,
            dispatchClaimedAt: now,
          },
        });
        if (claimed.count !== 1) return null;
      } else {
        // Déjà dispatchée : reprise UNIQUEMENT si lease expiré (tentative
        // interrompue) ou propriétaire absent (ligne antérieure au lot V3).
        const leaseExpired =
          now.getTime() - (refund.dispatchClaimedAt?.getTime() ?? 0) >=
          CardRefundsService.DISPATCH_LEASE_MS;
        if (!leaseExpired && refund.dispatchOwner) return null;
        const claimed = await tx.refund.updateMany({
          where: {
            id: refund.id,
            status: RefundStatus.PENDING,
            providerRef: null,
            dispatchOwner: refund.dispatchOwner,
            dispatchedAt: refund.dispatchedAt,
          },
          data: { dispatchOwner: owner, dispatchClaimedAt: now },
        });
        if (claimed.count !== 1) return null;
      }
      const payment = refund.cardPaymentId
        ? await tx.cardPayment.findUnique({ where: { id: refund.cardPaymentId } })
        : null;
      if (!payment) return null;
      return { refund, payment, owner };
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
    const owner = entered.owner;
    const payment = entered.payment;
    // GO revue §3b — reprise BORNÉE : le premier envoi doit rester dans la
    // fenêtre d'idempotence du prestataire (24 h), sinon la relance pourrait
    // créer un SECOND remboursement → refus + intervention, jamais à l'aveugle.
    const expired = this.recoveryWindowExpiredReason(entered.refund);
    if (expired) {
      // GO V3 §1 — aucun octet réseau n'a été émis : on REND la
      // revendication (lease annulé) pour que la prochaine relance revoie
      // le MÊME refus « fenêtre dépassée », jamais un conflit de lease
      // fantôme.
      try {
        await this.prisma.refund.updateMany({
          where: { id: refund.id, dispatchOwner: owner },
          data: { dispatchOwner: null, dispatchClaimedAt: null },
        });
      } catch {
        // Le lease expire de toute façon : jamais d'erreur masquant le refus.
      }
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: `${this.prefixFor(entered.refund)}.recovery_window_expired`,
          resourceType: 'refund',
          resourceId: entered.refund.id,
          details: { reason: expired, handling: 'intervention_requise' },
        })
        .catch(() => undefined);
      throw new ConflictException(
        `Reprise refusée (${expired}) : intervention requise, jamais de second remboursement.`,
      );
    }
    if (!payment.providerPaymentRef) {
      await this.failRefund(
        refund.id,
        paymentReference,
        'Aucune référence de paiement prestataire (impossible de rembourser).',
        actor,
        { recredit: true, owner },
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
      const message =
        err instanceof StripeHttpError || err instanceof Error
          ? err.message
          : String(err);
      // GO revue §3c — refus CERTAIN du prestataire (4xx hors 408/429) :
      // rien n'a été créé → échec TRANCHÉ + compensation CAS (réservation
      // libérée, recrédit recharge), JAMAIS de reprise perpétuelle d'une
      // demande refusée (sinon la réservation resterait prise à vie).
      // Réseau/timeout/5xx/408/429 OU identité refusée = INCERTITUDE →
      // réservation conservée, PENDING ré-exploirable (retry même clé).
      if (this.isDefiniteProviderRefusal(err)) {
        await this.failRefund(refund.id, paymentReference, message, actor, {
          recredit: true,
          owner,
        });
        const freshRefusal = await this.prisma.refund.findUnique({
          where: { id: refund.id },
        });
        return this.toView(freshRefusal ?? refund, paymentReference);
      }
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: `${this.prefixFor(refund)}.provider_call_deferred`,
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
        { recredit: true, providerRef: outcome.providerRef, owner },
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
      // GO V3 §1 — confirmation conditionnée au PROPRIÉTAIRE courant de
      // l'émission : une réponse TARDIVE d'un prédécesseur dépossédé n'écrase
      // jamais l'issue écrite par le successeur (ni un statut clos par le
      // webhook).
      const cas = await tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.PENDING, dispatchOwner: owner },
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
        // GO §2 — comptabilisation UNITAIRE (règle `max` monotone) : la même
        // issue arrivée par la réponse API, le webhook ou le rapprochement
        // n'avance `refundedCents` qu'UNE fois ; un cumul au-delà du montant
        // encaissé est signalé (`NEEDS_REVIEW`), jamais lissé.
        await syncRefundedCents(tx, pay.id);
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
            ? `${this.prefixFor(refund)}.succeeded`
            : `${this.prefixFor(refund)}.engaged`,
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
   * GO revue §3b — première fenêtre de reprise dépassée ? `null` = reprise
   * encore sûre (ou jamais émis : rien à rejouer).
   */
  private recoveryWindowExpiredReason(refund: Refund): string | null {
    if (!refund.dispatchedAt) return null;
    const ageMs = Date.now() - refund.dispatchedAt.getTime();
    if (ageMs <= CardRefundsService.IDEMPOTENCE_RETENTION_MS) return null;
    return `premier envoi il y a ${Math.round(ageMs / 3_600_000)} h (clé d'idempotence prestataire épongée)`;
  }

  /**
   * GO revue §3c — refus QUALIFIÉ du prestataire prouvant que la demande
   * n'a rien créé. Miroir exact de `isUncertainDispatchError` (card-payments)
   * lu par NÉGATION : ici l'incertain est le cas par défaut (réservation
   * conservée, PENDING ré-exploirable), le certain est l'exception.
   */
  private isDefiniteProviderRefusal(err: unknown): boolean {
    const qualified =
      err instanceof StripeHttpError ||
      (err !== null &&
        typeof err === 'object' &&
        'name' in err &&
        String((err as { name?: unknown }).name) === 'StripeHttpError');
    if (!qualified) return false;
    const status = err instanceof StripeHttpError ? err.status : undefined;
    // Refus qualifié sans code HTTP (ou instance) : le prestataire a tranché.
    if (typeof status !== 'number') return true;
    // 408/429 ne prouvent JAMAIS que la demande n'a rien créé (incertains).
    // GO V3 §1 — idem pour 409 (conflit, souvent idempotence) : jamais
    // classé certain sur le seul statut HTTP (la demande a pu être créée).
    return (
      status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 409
    );
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
    opts: { recredit: boolean; providerRef?: string; owner?: string },
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
        action: `${this.prefixFor(refund)}.failed`,
        resourceType: 'refund',
        resourceId: refundId,
        details: {
          reason: reason.slice(0, 300),
          recredit: opts.recredit && refund.orderId === null,
        },
      })
      .catch(() => undefined);
  }

  /** Cœur de l'échec, réutilisable DANS la transaction de l'appelant. */
  private async failRefundInTx(
    tx: Prisma.TransactionClient,
    refund: Refund,
    paymentReference: string,
    reason: string,
    opts: { recredit: boolean; providerRef?: string; owner?: string },
  ): Promise<boolean> {
    // GO V3 §1 — `owner` présent (émission prestataire) : CAS conditionné au
    // PROPRIÉTAIRE courant, une réponse tardive d'un prédécesseur dépossédé
    // n'égare jamais la compensation. Sans owner (annulation admin avant
    // émission, constatation webhook) : CAS `PENDING` seul (inchangé).
    const cas = await tx.refund.updateMany({
      where: {
        id: refund.id,
        status: RefundStatus.PENDING,
        ...(opts.owner ? { dispatchOwner: opts.owner } : {}),
      },
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

    if (opts.recredit && refund.cardPaymentId && !refund.orderId) {
      // Compensation UNIQUEMENT pour une RECHARGE (un débit wallet a été
      // opéré à la création). Un remboursement de COMMANDE réglée par carte
      // n'a JAMAIS débité le portefeuille : recréditer ferait crédit gratuit.
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

  /** Traçabilité : recharge (`refund.topup.*`) vs commande (`refund.order.*`). */
  private prefixFor(refund: { orderId: string | null }): 'refund.order' | 'refund.topup' {
    return refund.orderId ? 'refund.order' : 'refund.topup';
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
          action: `${this.prefixFor(result.refund)}.cancel_refused`,
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
        action: `${this.prefixFor(result.refund)}.failed`,
        resourceType: 'refund',
        resourceId: refundId,
        details: {
          reason: reason?.trim() || 'Annulé par l’administrateur.',
          recredit: result.refund.orderId === null,
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
        // GO §2 — comptabilisation UNITAIRE (règle `max` monotone) : le
        // webhook, la réponse API et le rejeu convergent vers le MÊME
        // compteur ; jamais d'incrément cumulatif.
        await syncRefundedCents(tx, pay.id);
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
