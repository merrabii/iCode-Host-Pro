import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CardPayment,
  CardPaymentStatus,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types';
import { WalletService } from '../wallet/wallet.service';
import { PaymentProviderService } from './payment-provider.service';
import { StripeHttpError } from './stripe-connector';

export const CARD_PAYMENT_MIN_CENTS = 100;
export const CARD_PAYMENT_MAX_CENTS = 10_000_000;

/** Statuts depuis lesquels AUCUNE confirmation supplémentaire n'est acceptée. */
const TERMINAL_STATUSES: CardPaymentStatus[] = [
  CardPaymentStatus.SUCCEEDED,
  CardPaymentStatus.PARTIALLY_REFUNDED,
  CardPaymentStatus.REFUNDED,
  CardPaymentStatus.NEEDS_REVIEW,
];

export type ConfirmOutcome =
  | { outcome: 'credited'; reference: string; balanceCents: number }
  | { outcome: 'already'; reference: string }
  | { outcome: 'needs_review'; reference: string; reason: string }
  | { outcome: 'ignored'; reference: string; reason: string }
  | { outcome: 'not_found' };

export interface CardPaymentClientView {
  reference: string;
  status: CardPaymentStatus;
  amountCents: number;
  currency: string;
  refundedCents: number;
  interventionNeeded: boolean;
  interventionReason: string | null;
  failureMessage: string | null;
  disputedAt: Date | null;
  checkoutUrl: string | null;
  createdAt: Date;
  paidAt: Date | null;
  expiresAt: Date | null;
}

export interface CardPaymentAdminView extends CardPaymentClientView {
  id: string;
  providerCode: string;
  environment: string;
  merchantAccount: string;
  livemode: boolean | null;
  providerSessionRef: string | null;
  providerPaymentRef: string | null;
  walletTransactionId: string | null;
  customerId: string;
  customerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Clé d'idempotence fournie par le client (double-clic = une session). */
export function assertPaymentIdempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();
  if (!key) return `topup:${randomBytes(16).toString('hex')}`;
  if (
    key.length < 8 ||
    key.length > 128 ||
    !/^[A-Za-z0-9:_.\-]+$/.test(key)
  ) {
    throw new BadRequestException(
      "Clé d'idempotence invalide (8 à 128 caractères : lettres, chiffres, « : _ . - »).",
    );
  }
  return key;
}

/**
 * GO Stripe — intentions de paiement PAR CARTE (recharge de portefeuille).
 *
 * Invariants :
 *  - le navigateur n'est JAMAIS autorité : montant/devise/client/compte marchand/
 *    environnement sont déterminés puis REVÉRIFIÉS côté serveur à la
 *    confirmation (webhook signé ou relecture serveur) ;
 *  - le crédit wallet n'a lieu QU'UNE fois (CAS sous verrou `FOR UPDATE` +
 *    clé d'idempotence `cardpay:<id>` réutilisant le moteur du WalletService) ;
 *  - un montant/devise/client/compte marchand incohérent = `NEEDS_REVIEW` +
 *    audit, JAMAIS de crédit approximatif ;
 *  - mono-devise assumée : la recharge doit être dans la devise du portefeuille
 *    (aucune addition USD+EUR, aucun change automatique).
 */
@Injectable()
export class CardPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly provider: PaymentProviderService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // ── vues ────────────────────────────────────────────────────────────────

  toClientView(row: CardPayment): CardPaymentClientView {
    const pending = row.status === CardPaymentStatus.CREATED;
    return {
      reference: row.reference,
      status: row.status,
      amountCents: row.amountCents,
      currency: row.currency,
      refundedCents: row.refundedCents,
      interventionNeeded: row.interventionNeeded,
      interventionReason: row.interventionReason,
      failureMessage: row.failureMessage,
      disputedAt: row.disputedAt,
      checkoutUrl: pending ? row.checkoutUrl : null,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      expiresAt: row.expiresAt,
    };
  }

  toAdminView(
    row: CardPayment & { customer?: { email: string | null } | null },
  ): CardPaymentAdminView {
    return {
      ...this.toClientView(row),
      id: row.id,
      providerCode: row.providerCode,
      environment: row.environment,
      merchantAccount: row.merchantAccount,
      livemode: row.livemode,
      providerSessionRef: row.providerSessionRef,
      providerPaymentRef: row.providerPaymentRef,
      walletTransactionId: row.walletTransactionId,
      customerId: row.customerId,
      customerEmail: row.customer?.email ?? null,
      updatedAt: row.updatedAt,
    };
  }

  // ── création (client) ───────────────────────────────────────────────────

  async createTopup(
    user: JwtPayload,
    dto: { amountCents: number; currency?: string; idempotencyKey?: string },
    idempotencyHeader?: string,
  ): Promise<CardPaymentClientView> {
    const customer = await this.wallet.ensureOwnedCustomer(user);

    if (
      !Number.isInteger(dto.amountCents) ||
      dto.amountCents < CARD_PAYMENT_MIN_CENTS ||
      dto.amountCents > CARD_PAYMENT_MAX_CENTS
    ) {
      throw new BadRequestException(
        'Montant invalide : entre 1,00 et 100 000,00 (entier en centimes).',
      );
    }

    const resolved = await this.provider.resolve();

    const walletCurrency = customer.walletCurrency.toUpperCase();
    const currency = (dto.currency ?? customer.walletCurrency).toUpperCase();
    if (currency !== walletCurrency) {
      throw new ConflictException(
        `Portefeuille en ${walletCurrency} : une recharge en ${currency} est refusée ` +
          '(aucune conversion de change automatique dans ce lot).',
      );
    }
    if (!resolved.currencies.includes(currency)) {
      throw new BadRequestException(
        `Devise non autorisée par le prestataire (${resolved.currencies.join(', ')}).`,
      );
    }

    const idem = assertPaymentIdempotencyKey(dto.idempotencyKey ?? idempotencyHeader);

    // Rejeu : même clé = MÊME session (aucun second paiement ouvert).
    const existing = await this.prisma.cardPayment.findUnique({
      where: { idempotencyKey: idem },
    });
    if (existing) {
      if (
        existing.customerId !== customer.id ||
        existing.amountCents !== dto.amountCents ||
        existing.currency.toLowerCase() !== currency.toLowerCase()
      ) {
        throw new ConflictException(
          "Clé d'idempotence déjà utilisée pour une autre intention de paiement.",
        );
      }
      if (existing.status === CardPaymentStatus.CREATED && existing.checkoutUrl) {
        return this.toClientView(existing);
      }
      if (existing.status !== CardPaymentStatus.CREATED) {
        // Session déjà utilisée : on rouvre proprement une NOUVELLE session
        // (clé différente) plutôt que de rejouer un paiement abouti.
        return this.createTopup(
          user,
          {
            amountCents: dto.amountCents,
            currency,
            idempotencyKey: undefined,
          },
          undefined,
        );
      }
      return this.toClientView(existing);
    }

    const reference = await this.newReference();
    const row = await this.prisma.cardPayment.create({
      data: {
        reference,
        customerId: customer.id,
        status: CardPaymentStatus.CREATED,
        amountCents: dto.amountCents,
        currency,
        providerCode: resolved.code,
        environment: resolved.environment,
        merchantAccount: resolved.merchantAccount,
        idempotencyKey: idem,
      },
    });

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');

    try {
      const session = await resolved.connector.createCheckoutSession({
        reference,
        amountCents: dto.amountCents,
        currency: currency.toLowerCase(),
        customerEmail: customer.email,
        successUrl: `${webOrigin}/client/portefeuille/paiement?ref=${encodeURIComponent(reference)}`,
        cancelUrl: `${webOrigin}/client/portefeuille/paiement?ref=${encodeURIComponent(reference)}&canceled=1`,
        metadata: { reference, customerId: customer.id },
      });
      const updated = await this.prisma.cardPayment.update({
        where: { id: row.id },
        data: {
          providerSessionRef: session.sessionRef,
          providerPaymentRef: session.paymentRef,
          checkoutUrl: session.checkoutUrl,
          livemode: session.livemode,
          expiresAt: session.expiresAt,
        },
      });
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'payment.topup.create',
          resourceType: 'cardPayment',
          resourceId: row.id,
          details: {
            reference,
            amountCents: dto.amountCents,
            currency,
            providerCode: resolved.code,
            environment: resolved.environment,
          },
        })
        .catch(() => undefined); // l'audit ne casse jamais une session créée
      return this.toClientView(updated);
    } catch (err) {
      const message =
        err instanceof StripeHttpError || err instanceof Error
          ? err.message
          : String(err);
      await this.prisma.cardPayment.update({
        where: { id: row.id },
        data: {
          status: CardPaymentStatus.FAILED,
          failureCode: err instanceof StripeHttpError ? String(err.status) : 'connector_error',
          failureMessage: message.slice(0, 500),
        },
      });
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'payment.topup.create_failed',
          resourceType: 'cardPayment',
          resourceId: row.id,
          details: { reference, reason: message.slice(0, 300) },
        })
        .catch(() => undefined);
      throw new ConflictException(
        `Ouverture de la session de paiement impossible : ${message}`,
      );
    }
  }

  private async newReference(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = `CDP-${randomBytes(5).toString('hex').toUpperCase()}`;
      const clash = await this.prisma.cardPayment.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (!clash) return reference;
    }
    throw new ConflictException('Référence de paiement déjà utilisée.');
  }

  // ── lecture / rafraîchissement serveur (client) ─────────────────────────

  private async ownedRow(reference: string, user: JwtPayload): Promise<CardPayment> {
    const customer = await this.wallet.ensureOwnedCustomer(user);
    const row = await this.prisma.cardPayment.findUnique({
      where: { reference },
    });
    if (!row || row.customerId !== customer.id) {
      throw new NotFoundException('Paiement introuvable.');
    }
    return row;
  }

  async getOwn(reference: string, user: JwtPayload): Promise<CardPaymentClientView> {
    return this.toClientView(await this.ownedRow(reference, user));
  }

  async listOwn(user: JwtPayload): Promise<CardPaymentClientView[]> {
    const customer = await this.wallet.ensureOwnedCustomer(user);
    const rows = await this.prisma.cardPayment.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toClientView(r));
  }

  /**
   * Rafraîchissement côté SERVEUR après retour de la page hébergée : on
   * relit l'état chez le prestataire et on confirme si le paiement est constaté.
   * Le navigateur déclenche seulement l'appel — la décision est ici.
   */
  async refreshFromProvider(
    reference: string,
    user: JwtPayload,
  ): Promise<CardPaymentClientView> {
    const row = await this.ownedRow(reference, user);
    if (TERMINAL_STATUSES.includes(row.status) || !row.providerSessionRef) {
      return this.toClientView(row);
    }
    const resolved = await this.provider.resolve();
    try {
      const details = await resolved.connector.retrieveSession(row.providerSessionRef);
      if (details.paymentStatus === 'paid') {
        await this.confirmPaid({
          sessionRef: row.providerSessionRef,
          paymentRef: details.paymentRef,
          amountTotalCents: details.amountTotalCents,
          currency: details.currency,
          livemode: details.livemode,
          source: 'poll',
        });
      } else if (details.status === 'expired') {
        await this.markExpired(row.providerSessionRef);
      } else if (details.status === 'unknown' && details.paymentStatus === 'unknown') {
        // Simulateur redémarré / état indisponible : aucun changement d'état.
      }
    } catch (err) {
      // Relecture impossible (réseau) : on renvoie l'état courant, JAMAIS de
      // crédit approximatif. L'incertitude reste visible côté client.
      if (err instanceof ConflictException || err instanceof BadRequestException) throw err;
    }
    const fresh = await this.prisma.cardPayment.findUnique({
      where: { id: row.id },
    });
    return this.toClientView(fresh ?? row);
  }

  // ── confirmation (webhook signé OU relecture serveur) ───────────────────

  /**
   * CHEIN UNIQUE de crédit : CAS `CREATED/PROCESSING → SUCCEEDED` sous verrou
   * ligne, avec revérification montant/devise/compte marchand/environnement.
   * Un appel parallèle ou un rejeu webhook = `already` (aucun second crédit).
   */
  async confirmPaid(input: {
    sessionRef?: string | null;
    paymentRef?: string | null;
    amountTotalCents?: number | null;
    currency?: string | null;
    livemode?: boolean | null;
    source: 'webhook' | 'poll';
    eventId?: string | null;
  }): Promise<ConfirmOutcome> {
    if (!input.sessionRef && !input.paymentRef) return { outcome: 'not_found' };

    return this.prisma.$transaction(async (tx) => {
      const rows =
        input.sessionRef != null
          ? await tx.$queryRaw<CardPayment[]>`
            SELECT * FROM "CardPayment" WHERE "providerSessionRef" = ${input.sessionRef} FOR UPDATE`
          : await tx.$queryRaw<CardPayment[]>`
            SELECT * FROM "CardPayment" WHERE "providerPaymentRef" = ${input.paymentRef} FOR UPDATE`;
      if (rows.length === 0) return { outcome: 'not_found' as const };
      const row = rows[0];

      if (TERMINAL_STATUSES.includes(row.status)) {
        return { outcome: 'already' as const, reference: row.reference };
      }
      if (
        row.status === CardPaymentStatus.FAILED ||
        row.status === CardPaymentStatus.CANCELED ||
        row.status === CardPaymentStatus.EXPIRED
      ) {
        // Événement successif après un échec déjà tranché : contradiction
        // signalée, jamais de crédit « à posteriori » silencieux.
        await tx.cardPayment.update({
          where: { id: row.id },
          data: {
            interventionNeeded: true,
            interventionReason: 'succession contradictoire d’événements',
          },
        });
        return {
          outcome: 'ignored' as const,
          reference: row.reference,
          reason: 'succession contradictoire',
        };
      }

      const problems: string[] = [];
      if (
        input.amountTotalCents != null &&
        input.amountTotalCents !== row.amountCents
      ) {
        problems.push('montant');
      }
      if (input.currency != null && input.currency.toLowerCase() !== row.currency.toLowerCase()) {
        problems.push('devise');
      }
      if (input.livemode === true) {
        problems.push('environnement LIVE détecté en mode test');
      }
      if (problems.length > 0) {
        const reason = `incohérence ${problems.join(' + ')}`;
        await tx.cardPayment.update({
          where: { id: row.id },
          data: {
            status: CardPaymentStatus.NEEDS_REVIEW,
            interventionNeeded: true,
            interventionReason: reason,
          },
        });
        return { outcome: 'needs_review' as const, reference: row.reference, reason };
      }

      const customer = await tx.customer.findUnique({
        where: { id: row.customerId },
        select: { walletCurrency: true },
      });
      if (!customer) {
        return { outcome: 'not_found' as const };
      }
      if (customer.walletCurrency.toUpperCase() !== row.currency.toUpperCase()) {
        const reason = 'devise du paiement ≠ devise du portefeuille';
        await tx.cardPayment.update({
          where: { id: row.id },
          data: {
            status: CardPaymentStatus.NEEDS_REVIEW,
            interventionNeeded: true,
            interventionReason: reason,
          },
        });
        return { outcome: 'needs_review' as const, reference: row.reference, reason };
      }

      const idempotencyKey = `cardpay:${row.id}`;
      const credit = await this.wallet.applyWithClient(
        tx,
        row.customerId,
        {
          amountCents: row.amountCents,
          idempotencyKey,
          currency: row.currency.toUpperCase(),
          type: WalletTransactionType.CREDIT,
          reference: row.reference,
          note: `Recharge carte ${row.reference}`,
        },
        'credit',
      );

      const walletTx = await tx.walletTransaction.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });

      const cas = await tx.cardPayment.updateMany({
        where: {
          id: row.id,
          status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
        },
        data: {
          status: CardPaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          walletTransactionId: walletTx?.id ?? null,
          providerPaymentRef: input.paymentRef ?? row.providerPaymentRef,
          livemode: input.livemode ?? row.livemode,
        },
      });
      if (cas.count !== 1) {
        // Course perdue malgré le verrou (défense en profondeur) : aucun
        // double crédit possible, le crédit éventuel reste rattaché à la clé.
        return { outcome: 'already' as const, reference: row.reference };
      }

      return {
        outcome: 'credited' as const,
        reference: row.reference,
        balanceCents: credit.balanceCents,
      };
    });
  }

  /** CAS `CREATED → EXPIRED` (aucun crédit). */
  async markExpired(sessionRef: string): Promise<boolean> {
    const res = await this.prisma.cardPayment.updateMany({
      where: { providerSessionRef: sessionRef, status: CardPaymentStatus.CREATED },
      data: { status: CardPaymentStatus.EXPIRED },
    });
    return res.count === 1;
  }

  /** CAS `CREATED/PROCESSING → CANCELED|FAILED` (aucun crédit). */
  async markFailed(input: {
    sessionRef?: string | null;
    paymentRef?: string | null;
    status: 'FAILED' | 'CANCELED';
    code?: string | null;
    message?: string | null;
  }): Promise<string | null> {
    if (!input.sessionRef && !input.paymentRef) return null;
    const where: Prisma.CardPaymentWhereInput = input.sessionRef
      ? { providerSessionRef: input.sessionRef }
      : { providerPaymentRef: input.paymentRef! };
    const res = await this.prisma.cardPayment.updateMany({
      where: {
        ...where,
        status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
      },
      data: {
        status: input.status,
        failureCode: input.code ?? null,
        failureMessage: input.message?.slice(0, 500) ?? null,
      },
    });
    return res.count === 1 ? null : null;
  }

  /** CAS `CREATED → PROCESSING` : paiement non confirmé (aucun crédit). */
  async markProcessing(sessionRef: string | null, paymentRef: string | null): Promise<void> {
    if (!sessionRef && !paymentRef) return;
    const where: Prisma.CardPaymentWhereInput = sessionRef
      ? { providerSessionRef: sessionRef }
      : { providerPaymentRef: paymentRef! };
    await this.prisma.cardPayment.updateMany({
      where: { ...where, status: CardPaymentStatus.CREATED },
      data: { status: CardPaymentStatus.PROCESSING },
    });
  }

  /**
   * Remboursement constaté CÔTÉ PRESTATAIRE (dashboard) : l'état carte est
   * mis à jour, mais le crédit wallet n'est PAS modifié automatiquement —
   * c'est une opération hors plateforme → intervention + audit explicite
   * (jamais de dette silencieuse, jamais de remboursement double).
   */
  async applyChargeRefunded(input: {
    paymentRef: string;
    amountRefundedCents: number;
    chargeRefundIds: string[];
  }): Promise<string | null> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerPaymentRef: input.paymentRef },
    });
    if (!row) return null;

    // Remboursement ÉMIS par la plateforme (reconnu par `providerRef`) :
    // l'état carte est simplement aligné, sans intervention.
    const ours =
      input.chargeRefundIds.length > 0
        ? await this.prisma.refund.findFirst({
            where: {
              cardPaymentId: row.id,
              providerRef: { in: input.chargeRefundIds },
            },
            select: { id: true },
          })
        : null;

    const refunded = Math.min(
      Math.max(input.amountRefundedCents, row.refundedCents),
      row.amountCents,
    );
    const fully = refunded >= row.amountCents;
    await this.prisma.cardPayment.update({
      where: { id: row.id },
      data: {
        refundedCents: refunded,
        status: fully ? CardPaymentStatus.REFUNDED : CardPaymentStatus.PARTIALLY_REFUNDED,
        ...(ours
          ? {}
          : {
              interventionNeeded: true,
              interventionReason:
                'remboursement prestataire hors plateforme : vérifier le solde wallet',
            }),
      },
    });
    if (!ours && row.walletTransactionId) {
      await this.prisma.walletTransaction.updateMany({
        where: { id: row.walletTransactionId },
        data: { disputedAt: new Date() },
      });
    }
    return row.id;
  }

  /** Litige carte : drapeau visible + audit, solde inchangé (traitement conservateur). */
  async applyDispute(input: {
    paymentRef: string;
    disputeId: string;
    reason: string | null;
    closed?: boolean;
  }): Promise<string | null> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerPaymentRef: input.paymentRef },
    });
    if (!row) return null;
    await this.prisma.cardPayment.update({
      where: { id: row.id },
      data: {
        disputedAt: new Date(),
        interventionNeeded: true,
        interventionReason: input.closed
          ? `litige ${input.disputeId} clos (${input.reason ?? 'sans motif'}) : vérifier manuellement`
          : `litige ${input.disputeId} ouvert (${input.reason ?? 'sans motif'}) : traitement conservateur`,
      },
    });
    if (row.walletTransactionId) {
      await this.prisma.walletTransaction.updateMany({
        where: { id: row.walletTransactionId },
        data: { disputedAt: new Date() },
      });
    }
    return row.id;
  }

  /** Levée admin d'une alerte après vérification manuelle. */
  async resolveIntervention(id: string, note: string): Promise<void> {
    const res = await this.prisma.cardPayment.updateMany({
      where: { id, interventionNeeded: true },
      data: { interventionNeeded: false, interventionReason: note.slice(0, 300) },
    });
    if (res.count !== 1) {
      throw new ConflictException('Aucune intervention en attente sur ce paiement.');
    }
  }
}
