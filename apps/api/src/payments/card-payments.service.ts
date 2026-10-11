import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CardPayment,
  CardPaymentKind,
  CardPaymentStatus,
  OrderStatus,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types';
import { WalletService } from '../wallet/wallet.service';
import {
  ConfirmPaidContext,
  ConfirmTxOutcome,
  CheckoutService,
} from '../store/checkout.service';
import { PaymentSettingsService } from '../store/payment-settings.service';
import { ConnectorSession } from './payment-connector';
import { PaymentProviderService, ResolvedProvider } from './payment-provider.service';
import { assertNoBlockingCardPayment } from './blocking-payment.guard';
import { syncRefundedCents } from './refund-accounting';
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

/** Statuts « encore ouverts » : une tentative de règlement en cours. */
export const LIVE_CARD_STATUSES: CardPaymentStatus[] = [
  CardPaymentStatus.CREATED,
  CardPaymentStatus.PROCESSING,
];

export type ConfirmOutcome =
  | { outcome: 'credited'; reference: string; balanceCents: number }
  | { outcome: 'settled'; reference: string; orderId: string }
  | { outcome: 'already'; reference: string }
  | { outcome: 'needs_review'; reference: string; reason: string }
  | { outcome: 'ignored'; reference: string; reason: string }
  | { outcome: 'not_found' };

/** Résultat INTERNE d'une confirmation (les effets post-commit sont séparés). */
interface ConfirmBranch {
  outcome: ConfirmOutcome;
  /** Confirmation commande à rejouer APRÈS commit (email, provisioning). */
  postEffect?: { outcome: ConfirmTxOutcome; orderId: string; ctx: ConfirmPaidContext };
}

/** Entrée d'une confirmation (webhook signé ou relecture serveur). */
export interface ConfirmPaidInput {
  sessionRef?: string | null;
  paymentRef?: string | null;
  amountTotalCents?: number | null;
  currency?: string | null;
  livemode?: boolean | null;
  source: 'webhook' | 'poll';
  eventId?: string | null;
  /** GO P1 — fournisseur qui a authentifié cette source. */
  providerCode: string;
  /** GO P4 — identité marchande du connecteur vérifié de cette source. */
  merchantAccount?: string | null;
  /** GO P4 — référence portée par l'événement (rattachement). */
  reference?: string | null;
}

/** Commande verrouillée `FOR UPDATE` (colonnes utiles au règlement). */
type LockedOrderRow = {
  id: string;
  status: OrderStatus;
  customerId: string;
  amountTtcCents: number;
  currency: string;
};

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
  // GO revue §5c — le remboursement admin distingue ORDER / TOPUP : la vue
  // expose le kind et la commande liée (UI + garde serveur).
  kind: CardPaymentKind;
  orderId: string | null;
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
    private readonly settings: PaymentSettingsService,
    private readonly checkout: CheckoutService,
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
      kind: row.kind,
      orderId: row.orderId,
      updatedAt: row.updatedAt,
    };
  }

  // ── création (client) ───────────────────────────────────────────────────

  /**
   * GO P2 — identité COMPLÈTE d'une intention : même clé acceptée uniquement
   * pour le même client, le même montant et la même devise (tout écart = 409,
   * jamais d'effet silencieux sur une autre intention).
   */
  private sameIntent(
    row: CardPayment,
    customerId: string,
    amountCents: number,
    currency: string,
  ): boolean {
    return (
      row.customerId === customerId &&
      row.amountCents === amountCents &&
      row.currency.toLowerCase() === currency.toLowerCase()
    );
  }

  /**
   * GO P3 — fenêtre de reprise sûre : Stripe éponge les clés d'idempotence
   * après au moins 24 h. Passé ce délai, rejouer la même clé créerait une
   * NOUVELLE session → aucune reprise automatique, intervention humaine.
   */
  private static readonly IDEMPOTENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

  /**
   * GO V3 §1 — durée du lease d'une tentative d'appel EN COURS : au-delà,
   * l'inviteur peut déposséder le propriétaire (reprise contrôlée). Tant que
   * le lease court, AUCUNE seconde émission n'est possible.
   */
  private static readonly DISPATCH_LEASE_MS = 60_000;

  /** Jeton unique du propriétaire de la tentative d'appel en cours. */
  private newDispatchOwner(): string {
    return `${Date.now()}:${randomUUID()}`;
  }

  private recoveryBlockedReason(row: CardPayment): string | null {
    if (!row.dispatchedAt) return null;
    const ageMs = Date.now() - row.dispatchedAt.getTime();
    if (ageMs <= CardPaymentsService.IDEMPOTENCE_RETENTION_MS) return null;
    return `dernier envoi il y a ${Math.round(ageMs / 3_600_000)} h (clé d'idempotence prestataire épongée)`;
  }

  /** P3 — création à (re)prendre : jamais conclue, ou résultat incertain. */
  private needsProviderDispatch(row: CardPayment): boolean {
    if (
      row.status !== CardPaymentStatus.CREATED &&
      row.status !== CardPaymentStatus.PROCESSING
    ) {
      return false;
    }
    if (
      row.providerCallState === 'DISPATCHED' ||
      row.providerCallState === 'UNCERTAIN'
    ) {
      // Appel resté sans réponse concluante → reprise avec la MÊME clé.
      return true;
    }
    if (row.providerCallState === 'RESOLVED') return false; // issue constatée
    // `null` (ligne antérieure au GO) : une session déjà ouverte n'est pas
    // relancée, une création jamais ouverte l'est avec la même clé.
    return !row.checkoutUrl;
  }

  /**
   * GO §4 — aucun NOUVEL encaissement tant qu'un paiement du client reste
   * `UNCERTAIN` (issue non constatée) ou `NEEDS_REVIEW` avec alerte ouverte.
   *
   * Délègue à l'autorité UNIQUE partagée (`assertNoBlockingCardPayment`) :
   * recharge, règlement commande par carte et règlement PAR SOLDE opposent
   * exactement les mêmes conditions.
   */
  private async assertNoBlockingPayment(customerId: string): Promise<void> {
    await assertNoBlockingCardPayment(this.prisma, customerId);
  }

  /**
   * GO P2 — MÊME clé + MÊME intention = MÊME paiement, quel que soit son état.
   * Aucune création récursive, aucune nouvelle clé, aucun second paiement.
   */
  async createTopup(
    user: JwtPayload,
    dto: { amountCents: number; currency?: string; idempotencyKey?: string },
    idempotencyHeader?: string,
  ): Promise<CardPaymentClientView> {
    // GATE SERVEUR (réglage admin + ligne moyen CARTE) — avant toute lecture
    // ou écriture : le rejeu/reprise d'une intention passe par le même
    // contrôle (émission = création), un appel API direct subit le même 409.
    await this.settings.assertEnabled('cardTopup');
    await this.settings.assertCardMethodActive();
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

    const walletCurrency = customer.walletCurrency.toUpperCase();
    const currency = (dto.currency ?? customer.walletCurrency).toUpperCase();
    if (currency !== walletCurrency) {
      throw new ConflictException(
        `Portefeuille en ${walletCurrency} : une recharge en ${currency} est refusée ` +
          '(aucune conversion de change automatique dans ce lot).',
      );
    }

    const idem = assertPaymentIdempotencyKey(dto.idempotencyKey ?? idempotencyHeader);

    // Rejeu AVANT toute résolution : une intention déjà ouverte se relit même
    // si la configuration a changé (aucune requalification silencieuse).
    const existing = await this.prisma.cardPayment.findUnique({
      where: { idempotencyKey: idem },
    });
    if (existing) {
      if (!this.sameIntent(existing, customer.id, dto.amountCents, currency)) {
        throw new ConflictException(
          "Clé d'idempotence déjà utilisée pour une autre intention de paiement.",
        );
      }
      if (this.needsProviderDispatch(existing)) {
        // Reprise contrôlée (réponse perdue, crash, persistance échouée) :
        // MÊME référence, MÊME clé prestataire, JAMAIS de seconde session.
        return this.dispatchCheckout(existing, user, await this.provider.resolve());
      }
      return this.toClientView(existing);
    }

    // GO §4 — un résultat non établi (UNCERTAIN / alerte ouverte) bloque tout
    // NOUVEL encaissement du client (le rejeu d'une intention EXISTANTE,
    // traité ci-dessus, reste autorisé pour établir son issue).
    await this.assertNoBlockingPayment(customer.id);

    const resolved = await this.provider.resolve();
    if (!resolved.currencies.includes(currency)) {
      throw new BadRequestException(
        `Devise non autorisée par le prestataire (${resolved.currencies.join(', ')}).`,
      );
    }

    const reference = await this.newReference();
    let row: CardPayment;
    try {
      row = await this.prisma.cardPayment.create({
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
    } catch (err) {
      // GO P2 — double soumission CONCURRENTE sur la même clé : le second
      // créateur n'a jamais d'erreur technique ni de second dispatch, il sert
      // la ligne déjà ouverte par le premier (aucun appel prestataire en double).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.cardPayment.findUnique({
          where: { idempotencyKey: idem },
        });
        if (raced) {
          if (!this.sameIntent(raced, customer.id, dto.amountCents, currency)) {
            throw new ConflictException(
              "Clé d'idempotence déjà utilisée pour une autre intention de paiement.",
            );
          }
          return this.toClientView(raced);
        }
      }
      throw err;
    }

    return this.dispatchCheckout(row, user, resolved);
  }

  /**
   * Lot « paiement direct des commandes » — ouverture (ou relance) d'un
   * règlement PAR CARTE pour une commande, sans passer par le portefeuille.
   *
   *  - GATE `cardOrder` (réglage ADMIN, indépendant de la recharge) AVANT
   *    toute écriture : un appel API direct subit le même refus 409 ;
   *  - création sous VERROU `FOR UPDATE` de la commande → deux clics
   *    concurrents ne créent qu'UNE tentative ;
   *  - tentative vivante (CREATED/PROCESSING) = relance de la MÊME session
   *    (même clé prestataire), JAMAIS de seconde session ;
   *  - AUCUN mouvement de portefeuille : encaissement côté prestataire, puis
   *    règlement de la commande dans `confirmPaid` (CAS unique de la commande).
   */
  async createOrderPayment(
    orderId: string,
    user: JwtPayload,
    dto: { idempotencyKey?: string } = {},
    idempotencyHeader?: string,
  ): Promise<CardPaymentClientView> {
    // GATE SERVEUR (réglage admin + ligne moyen CARTE) — avant toute lecture
    // ou écriture : un appel API direct subit le même refus 409.
    await this.settings.assertEnabled('cardOrder');
    await this.settings.assertCardMethodActive();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { id: true, userId: true } } },
    });
    if (!order || !order.customer.userId || order.customer.userId !== user.sub) {
      throw new NotFoundException('Commande introuvable.');
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        `Commande ${order.status} : règlement par carte impossible.`,
      );
    }
    const amountCents = order.amountTtcCents;
    if (
      !Number.isInteger(amountCents) ||
      amountCents < CARD_PAYMENT_MIN_CENTS ||
      amountCents > CARD_PAYMENT_MAX_CENTS
    ) {
      throw new BadRequestException(
        `Montant ${amountCents} centimes hors de la plage de paiement par carte ` +
          `(${CARD_PAYMENT_MIN_CENTS} à ${CARD_PAYMENT_MAX_CENTS} centimes).`,
      );
    }
    const currency = order.currency.toUpperCase();
    const clientKey = dto.idempotencyKey ?? idempotencyHeader;
    const idem = clientKey ? assertPaymentIdempotencyKey(clientKey) : null;

    const resolved = await this.provider.resolve();
    if (!resolved.currencies.includes(currency)) {
      throw new BadRequestException(
        `Devise non autorisée par le prestataire (${resolved.currencies.join(', ')}).`,
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      // Verrou commande : sérialise les tentatives concurrentes de règlement
      // (règle de verrous : Carte puis Commande — ici la commande d'abord pour
      // la création, `confirmPaid` prend paiement puis commande ensuite).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Commande introuvable.');

      const cur = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (cur?.status !== OrderStatus.PENDING_PAYMENT) {
        throw new ConflictException(
          `Commande ${cur?.status ?? 'inconnue'} : règlement par carte impossible.`,
        );
      }

      // Relance : une tentative encore ouverte = MÊME session.
      const live = await tx.cardPayment.findFirst({
        where: { orderId, status: { in: LIVE_CARD_STATUSES } },
        orderBy: { createdAt: 'desc' },
      });
      if (live) {
        if (live.amountCents !== amountCents || live.currency !== currency) {
          throw new ConflictException(
            'Tentative de règlement en cours incohérente avec la commande (montant/devise) : intervention requise.',
          );
        }
        return live;
      }

      // Rejeu par clé client : MÊME clé = MÊME intention (jamais d'effet 2×).
      if (idem) {
        const prev = await tx.cardPayment.findUnique({
          where: { idempotencyKey: idem },
        });
        if (prev) {
          if (
            prev.orderId !== orderId ||
            prev.customerId !== order.customer.id ||
            prev.amountCents !== amountCents ||
            prev.currency !== currency
          ) {
            throw new ConflictException(
              "Clé d'idempotence déjà utilisée pour une autre intention de paiement.",
            );
          }
          return prev;
        }
      }

      // GO §4 — blocage customer-level avant toute NOUVELLE tentative
      // (les relances de tentative vivante / rejeu par clé ci-dessus restent
      // autorisés : ils établissent l'issue d'une opération déjà engagée).
      // Autorité UNIQUE partagée : recharge / commande par carte / solde.
      await assertNoBlockingCardPayment(tx, order.customer.id);

      const priorCount = await tx.cardPayment.count({ where: { orderId } });
      const reference = await this.newReference(tx);
      try {
        return await tx.cardPayment.create({
          data: {
            reference,
            kind: CardPaymentKind.ORDER,
            orderId,
            customerId: order.customer.id,
            status: CardPaymentStatus.CREATED,
            amountCents,
            currency,
            providerCode: resolved.code,
            environment: resolved.environment,
            merchantAccount: resolved.merchantAccount,
            idempotencyKey: idem ?? `order:${orderId}:${priorCount}`,
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictException(
            "Clé d'idempotence déjà utilisée pour une autre intention de paiement.",
          );
        }
        throw err;
      }
    });

    return this.dispatchCheckout(row, user, resolved);
  }

  /** Commande du client connecté — propriété exigée (jamais d'accès par sondage). */
  private async ownedOrder(
    orderId: string,
    user: JwtPayload,
  ): Promise<{ id: string; customerId: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { id: true, userId: true } } },
    });
    if (!order || !order.customer.userId || order.customer.userId !== user.sub) {
      throw new NotFoundException('Commande introuvable.');
    }
    return { id: order.id, customerId: order.customer.id };
  }

  /** Dernière tentative de règlement carte d'une commande (pour l'UI/polling). */
  async getOrderPayment(
    orderId: string,
    user: JwtPayload,
  ): Promise<CardPaymentClientView | null> {
    const owned = await this.ownedOrder(orderId, user);
    const row = await this.prisma.cardPayment.findFirst({
      where: { orderId: owned.id, customerId: owned.customerId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toClientView(row) : null;
  }

  /**
   * Relecture serveur après retour de la page hébergée — chemin de REPRISE
   * (jamais d'émission) : aucun gate ici, même si le moyen vient d'être
   * désactivé, pour conclure un paiement déjà ouvert.
   */
  async refreshOrderPayment(
    orderId: string,
    user: JwtPayload,
  ): Promise<CardPaymentClientView> {
    const owned = await this.ownedOrder(orderId, user);
    const row = await this.prisma.cardPayment.findFirst({
      where: { orderId: owned.id, customerId: owned.customerId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new NotFoundException('Paiement introuvable.');
    return this.refreshFromProvider(row.reference, user);
  }

  /**
   * GO P3 — appel prestataire encadré :
   *  1. identité de l'opération COMMITEE avant le réseau (`DISPATCHED`) ;
   *  2. réponse obtenue → références persistées (`RESOLVED`) ;
   *  3. refus certain (4xx prestataire) → `FAILED` + message, aucun crédit ;
   *  4. résultat incertain (réseau/timeout/5xx) → `UNCERTAIN`, statut inchangé :
   *     le client reçoit la vue, la page de suivi relance une reprise qui
   *     rejoue avec la MÊME clé → MÊME session chez le prestataire.
   * Aucune de ces étapes n'exécute d'appel réseau sous transaction.
   */
  private async dispatchCheckout(
    row: CardPayment,
    user: JwtPayload,
    resolved: ResolvedProvider,
  ): Promise<CardPaymentClientView> {
    if (row.checkoutUrl && row.providerCallState === 'RESOLVED') {
      return this.toClientView(row);
    }

    // GO P4 — reprise UNIQUEMENT sous l'identité d'origine (fournisseur +
    // compte marchand) : jamais de remplacement silencieux par la config active.
    if (
      row.providerCode !== resolved.code ||
      row.merchantAccount !== resolved.merchantAccount
    ) {
      await this.markIntervention(
        row.id,
        `identité d’origine ${row.providerCode}/${row.merchantAccount} ≠ configuration active ` +
          `${resolved.code}/${resolved.merchantAccount}`,
      );
      throw new ConflictException(
        'Fournisseur ou compte marchand modifié depuis l’ouverture : reprise refusée, intervention requise.',
      );
    }

    const blocked = this.recoveryBlockedReason(row);
    if (blocked) {
      await this.markIntervention(row.id, `reprise automatique impossible : ${blocked}`);
      throw new ConflictException(
        `Résultat incertain non repris automatiquement (${blocked}) : intervention requise.`,
      );
    }

    const isOrder = row.kind === CardPaymentKind.ORDER;
    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');

    // Destinataire de retour : recharge = portefeuille ; règlement d'une
    // commande = page de succès du tunnel (orderId + référence affichés).
    const backTo = isOrder
      ? `/checkout/success?orderId=${encodeURIComponent(row.orderId ?? '')}&ref=${encodeURIComponent(row.reference)}`
      : `/client/portefeuille/paiement?ref=${encodeURIComponent(row.reference)}`;
    const backToCancel = isOrder
      ? `/checkout/payment?orderId=${encodeURIComponent(row.orderId ?? '')}&ref=${encodeURIComponent(row.reference)}&canceled=1`
      : `/client/portefeuille/paiement?ref=${encodeURIComponent(row.reference)}&canceled=1`;

    const customerEmail = isOrder
      ? (
          await this.prisma.order.findUnique({
            where: { id: row.orderId! },
            select: { customerEmail: true },
          })
        )?.customerEmail ?? ''
      : (await this.wallet.ensureOwnedCustomer(user)).email;

    // 1. Identité de l'opération persistée AVANT le premier octet réseau.
    // GO §4 — `dispatchedAt` est le PREMIER envoi et reste IMMUABLE : chaque
    // reprise ne réécrit pas la fenêtre de 24 h de la reprise automatique.
    await this.prisma.cardPayment.updateMany({
      where: { id: row.id, dispatchedAt: null },
      data: { dispatchedAt: new Date() },
    });
    // GO V3 §1 — revendication EXCLUSIVE : un seul propriétaire émet à la
    // fois. La première revendication n'entre que sur une ligne JAMAIS
    // dispatchée (`providerCallState: null` + aucun propriétaire) ; une
    // tentative interrompue (`DISPATCHED` dont le lease est expiré) ou une
    // issue `UNCERTAIN` (appel terminé sans conclusion) est dépossédée par
    // CAS conditionné aux valeurs OBSERVÉES (jamais à l'aveugle). Tant qu'un
    // lease court, AUCUNE seconde émission n'est possible.
    const owner = this.newDispatchOwner();
    const now = new Date();
    let claimed = await this.prisma.cardPayment.updateMany({
      where: { id: row.id, providerCallState: null, dispatchOwner: null },
      data: {
        providerCallState: 'DISPATCHED',
        dispatchOwner: owner,
        dispatchClaimedAt: now,
      },
    });
    if (claimed.count !== 1) {
      const fresh = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
      if (!fresh) throw new NotFoundException('Paiement introuvable.');
      if (fresh.providerCallState === 'RESOLVED') return this.toClientView(fresh);
      // Reprise bornée : UNCERTAIN (issue non tranchée) OU DISPATCHED dont le
      // lease est expiré (tentative interrompue, plus personne n'émet).
      const leaseExpired =
        now.getTime() - (fresh.dispatchClaimedAt?.getTime() ?? 0) >=
        CardPaymentsService.DISPATCH_LEASE_MS;
      if (
        fresh.providerCallState === 'UNCERTAIN' ||
        (fresh.providerCallState === 'DISPATCHED' && leaseExpired)
      ) {
        claimed = await this.prisma.cardPayment.updateMany({
          where: {
            id: fresh.id,
            providerCallState: fresh.providerCallState,
            dispatchOwner: fresh.dispatchOwner,
            dispatchClaimedAt: fresh.dispatchClaimedAt,
          },
          data: {
            providerCallState: 'DISPATCHED',
            dispatchOwner: owner,
            dispatchClaimedAt: now,
          },
        });
      }
      if (claimed.count !== 1) {
        // Lease encore courant (tentative vivante chez un pair) OU course perdue :
        // retour de l'état RÉEL, AUCUN octet réseau émis par ce chemin.
        const latest = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
        return this.toClientView(latest ?? fresh);
      }
    }

    let session: ConnectorSession;
    try {
      session = await resolved.connector.createCheckoutSession({
        reference: row.reference,
        amountCents: row.amountCents,
        currency: row.currency.toLowerCase(),
        customerEmail,
        successUrl: `${webOrigin}${backTo}`,
        cancelUrl: `${webOrigin}${backToCancel}`,
        metadata: {
          reference: row.reference,
          customerId: row.customerId,
          kind: row.kind,
          ...(row.orderId ? { orderId: row.orderId } : {}),
        },
        // Clé STABLE par opération : toute reprise = même session prestataire.
        idempotencyKey: `${isOrder ? 'orderpay' : 'topup'}:${row.reference}`,
      });
    } catch (err) {
      return this.handleDispatchFailure(row, user, err, owner);
    }

    // GO revue §3d + V3 §1 — issue BORNÉE par CAS (`updateMany` = WhereInput
    // complet + nombre de lignes franchis) sur le PROPRIÉTAIRE courant : la
    // réponse n'est persistée que si CET appel est toujours propriétaire
    // (jamais l'issue d'un pair, jamais un rejeu dépossédé).
    const written = {
      providerSessionRef: session.sessionRef,
      providerPaymentRef: session.paymentRef,
      checkoutUrl: session.checkoutUrl,
      livemode: session.livemode,
      expiresAt: session.expiresAt,
      providerCallState: 'RESOLVED' as const,
    };
    let cas: { count: number };
    try {
      cas = await this.prisma.cardPayment.updateMany({
        where: { id: row.id, dispatchOwner: owner, providerCallState: 'DISPATCHED' },
        data: written,
      });
    } catch {
      // GO P3 — échec de PERSISTANCE après création chez le prestataire :
      // la clé `<kind>:<référence>` est déjà consommée, la reprise (même clé)
      // obtient la MÊME session. Aucune seconde création.
      await this.prisma.cardPayment
        .updateMany({
          where: { id: row.id, dispatchOwner: owner, providerCallState: 'DISPATCHED' },
          data: { providerCallState: 'UNCERTAIN' },
        })
        .catch(() => undefined);
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: isOrder
            ? 'payment.order.persistence_failed'
            : 'payment.topup.persistence_failed',
          resourceType: 'cardPayment',
          resourceId: row.id,
          details: { reference: row.reference, handling: 'reprise_meme_cle' },
        })
        .catch(() => undefined);
      throw new ConflictException(
        'Session ouverte chez le prestataire mais non enregistrée : résultat incertain, ' +
          'relancez la recharge (même intention) pour reprendre sans double création.',
      );
    }
    if (cas.count !== 1) {
      // GO revue §3d — réponse TARDIVE : une issue concurrente est déjà
      // persistée → retour de l'état RÉEL, AUCUN écrasement, aucun effet.
      const fresh = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
      return this.toClientView(fresh ?? row);
    }
    const fresh = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
    const updated: CardPayment =
      fresh && fresh.providerCallState === 'RESOLVED' ? fresh : { ...row, ...written };

    await this.audit
      .record({
        actorId: user.sub,
        actorEmail: user.email,
        action: isOrder ? 'payment.order.create' : 'payment.topup.create',
        resourceType: 'cardPayment',
        resourceId: row.id,
        details: {
          reference: row.reference,
          amountCents: row.amountCents,
          currency: row.currency,
          kind: row.kind,
          ...(row.orderId ? { orderId: row.orderId } : {}),
          providerCode: resolved.code,
          environment: resolved.environment,
        },
      })
      .catch(() => undefined); // l'audit ne casse jamais une session créée

    return this.toClientView(updated);
  }

  /** GO P3 + §4 — classement honnête de l'échec d'appel (jamais « FAILED » à tort). */
  private isUncertainDispatchError(err: unknown): boolean {
    if (err instanceof StripeHttpError) {
      if (typeof err.status === 'number') {
        if (err.status === 0) return true; // réseau/timeout : peut être arrivé
        if (err.status >= 500) return true; // 5xx : traité ou non, indécidable
        // GO §4 — 408 (timeout côté serveur) et 429 (rate limit) ne prouvent
        // JAMAIS que la requête n'a rien créé : résultat incertain.
        if (err.status === 408 || err.status === 429) return true;
        // GO V3 §1 — un 409 (conflit, souvent idempotence) n'est JAMAIS
        // classé comme preuve d'absence de création sur le seul statut HTTP :
        // la demande a pu être créée sous une autre tentative → incertain.
        if (err.status === 409) return true;
        return false; // 4xx : refus certain, rien n'a été créé
      }
      return false; // refus qualifié par le prestataire sans code HTTP
    }
    if (err && typeof err === 'object' && 'name' in err) {
      const name = String((err as { name?: unknown }).name);
      if (name === 'StripeHttpError') return false; // déclaration de refus
      if (name === 'AbortError' || name === 'TimeoutError') return true;
    }
    // Erreur non qualifiée (réponse 2xx illisible, bug d'adaptateur) : on ne
    // peut PAS prouver que la requête n'a rien créé → RÉSULTAT INCERTAIN.
    return true;
  }

  private async handleDispatchFailure(
    row: CardPayment,
    user: JwtPayload,
    err: unknown,
    owner: string,
  ): Promise<CardPaymentClientView> {
    const message =
      err instanceof StripeHttpError || err instanceof Error
        ? err.message
        : String(err);
    const uncertain = this.isUncertainDispatchError(err);
    const auditPrefix = row.kind === CardPaymentKind.ORDER ? 'payment.order' : 'payment.topup';

    if (uncertain) {
      // GO revue §3d + V3 §1 + GO V5 §1 — CAS borné au PROPRIÉTAIRE courant
      // ET à l'état encore admissible (`DISPATCHED` = en vol) : une décision
      // webhook déjà établie (`RESOLVED` — confirmation SUCCEEDED/FAILED/
      // EXPIRED) n'est JAMAIS dégradée à `UNCERTAIN` par une réponse tardive,
      // même si la revendication n'a pas encore été invalidée.
      const cas = await this.prisma.cardPayment.updateMany({
        where: { id: row.id, dispatchOwner: owner, providerCallState: 'DISPATCHED' },
        data: { providerCallState: 'UNCERTAIN' },
      });
      if (cas.count !== 1) {
        const settled = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
        return this.toClientView(settled ?? row);
      }
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: `${auditPrefix}.dispatch_uncertain`,
          resourceType: 'cardPayment',
          resourceId: row.id,
          details: { reference: row.reference, reason: message.slice(0, 300) },
        })
        .catch(() => undefined);
      // AUCUN statut FAILED : l'issue reste à constater (reprise contrôlée).
      const fresh = await this.prisma.cardPayment.findUnique({
        where: { id: row.id },
      });
      return this.toClientView(fresh ?? row);
    }

    // GO revue §3d + V3 §1 + GO V5 §1 — refus certain CAS borné au
    // PROPRIÉTAIRE courant ET à l'état encore admissible : une confirmation
    // webhook (`RESOLVED`) n'est JAMAIS convertie en `FAILED` par un refus
    // réseau tardif — le crédit déjà enregistré reste intact.
    const failCas = await this.prisma.cardPayment.updateMany({
      where: { id: row.id, dispatchOwner: owner, providerCallState: 'DISPATCHED' },
      data: {
        status: CardPaymentStatus.FAILED,
        providerCallState: 'RESOLVED',
        failureCode: err instanceof StripeHttpError ? String(err.status) : 'connector_error',
        failureMessage: message.slice(0, 500),
      },
    });
    if (failCas.count !== 1) {
      // Réponse TARDIVE : issue concurrente déjà tranchée → retour de l'état
      // RÉEL, sans audit « create_failed » mensonger.
      const fresh = await this.prisma.cardPayment.findUnique({ where: { id: row.id } });
      return this.toClientView(fresh ?? row);
    }
    await this.audit
      .record({
        actorId: user.sub,
        actorEmail: user.email,
        action: `${auditPrefix}.create_failed`,
        resourceType: 'cardPayment',
        resourceId: row.id,
        details: { reference: row.reference, reason: message.slice(0, 300) },
      })
      .catch(() => undefined);
    throw new ConflictException(
      `Ouverture de la session de paiement impossible : ${message}`,
    );
  }

  private async markIntervention(id: string, reason: string): Promise<void> {
    await this.prisma.cardPayment
      .updateMany({
        where: { id, interventionNeeded: false },
        data: { interventionNeeded: true, interventionReason: reason.slice(0, 300) },
      })
      .catch(() => undefined);
  }

  private async newReference(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = `CDP-${randomBytes(5).toString('hex').toUpperCase()}`;
      const clash = await client.cardPayment.findUnique({
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

    // GO P3 + §5 — appel resté incertain (ou échec de persistance) : la
    // relecture rejoue d'abord la CRÉATION avec la MÊME clé `topup:<référence>`
    // → MÊME session chez le prestataire, jamais une seconde.
    if (this.needsProviderDispatch(row)) {
      // GO §5 — une PREMIÈRE émission (jamais envoyée) subit le gate du
      // moyen : désactiver le parcours (réglage OU ligne moyen CARTE) bloque
      // aussi ce rejeu. Une opération DÉJÀ émise (reprise d'issue) reste
      // autorisée sans gate : établir l'issue prime sur la désactivation.
      if (!row.dispatchedAt && !row.checkoutUrl) {
        await this.settings.assertEnabled(
          row.kind === CardPaymentKind.ORDER ? 'cardOrder' : 'cardTopup',
        );
        await this.settings.assertCardMethodActive();
      }
      const resolved = await this.provider.resolveFor({
        providerCode: row.providerCode,
        merchantAccount: row.merchantAccount,
        environment: row.environment,
      });
      try {
        return await this.dispatchCheckout(row, user, resolved);
      } catch (err) {
        if (err instanceof ConflictException || err instanceof BadRequestException) {
          throw err; // refus explicite (identité changée, reprise périmée)
        }
        // chute : l'état courant est renvoyé plus bas, sans crédit approximatif
      }
    }

    if (TERMINAL_STATUSES.includes(row.status) || !row.providerSessionRef) {
      return this.toClientView(row);
    }
    // GO P1/P4 — relecture SOUS l'identité d'origine (fournisseur + compte),
    // JAMAIS sous la config active d'un autre fournisseur.
    const resolved = await this.provider.resolveFor({
      providerCode: row.providerCode,
      merchantAccount: row.merchantAccount,
      environment: row.environment,
    });
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
          providerCode: row.providerCode,
          merchantAccount: row.merchantAccount,
          reference: row.reference,
        });
      } else if (details.status === 'expired') {
        await this.markExpired(row.providerSessionRef, row.providerCode);
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
   *
   * GO P1 — `providerCode` (fournisseur qui a AUTHENTIFIÉ la source) et, quand
   * il est fourni, `merchantAccount` (identité du connecteur vérifié) sont
   * obligatoires : tout écart = `ignored`/`needs_review`, JAMAIS de crédit.
   * GO P4 — un montant ou une devise ABSENTS de la source = preuve incomplète
   * → `needs_review` (jamais de crédit sur une déclaration partielle).
   */
  async confirmPaid(input: ConfirmPaidInput): Promise<ConfirmOutcome> {
    if (!input.sessionRef && !input.paymentRef) return { outcome: 'not_found' };

    const branch = await this.prisma.$transaction(
      async (tx): Promise<ConfirmBranch> => {
      const rows =
        input.sessionRef != null
          ? await tx.$queryRaw<CardPayment[]>`
            SELECT * FROM "CardPayment" WHERE "providerSessionRef" = ${input.sessionRef} FOR UPDATE`
          : await tx.$queryRaw<CardPayment[]>`
            SELECT * FROM "CardPayment" WHERE "providerPaymentRef" = ${input.paymentRef} FOR UPDATE`;
      if (rows.length === 0) return { outcome: { outcome: 'not_found' as const } };
      const row = rows[0];

      // GO P1 — un événement d'un AUTRE fournisseur ne touche JAMAIS la ligne :
      // ni crédit, ni débit, ni changement d'état, ni intervention.
      if (input.providerCode !== row.providerCode) {
        return {
          outcome: {
            outcome: 'ignored' as const,
            reference: row.reference,
            reason: `fournisseur non rattaché (${input.providerCode} ≠ ${row.providerCode})`,
          },
        };
      }

      if (TERMINAL_STATUSES.includes(row.status)) {
        return { outcome: { outcome: 'already' as const, reference: row.reference } };
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
          outcome: {
            outcome: 'ignored' as const,
            reference: row.reference,
            reason: 'succession contradictoire',
          },
        };
      }

      // GO P4 — preuves exigeantes : tout écart ou toute absence = preuve
      // incohérente/incomplète, jamais un crédit « à peu près ».
      const problems: string[] = [];
      if (input.merchantAccount != null && input.merchantAccount !== row.merchantAccount) {
        problems.push('compte marchand');
      }
      if (input.reference != null && input.reference !== row.reference) {
        problems.push('référence');
      }
      if (input.amountTotalCents == null) {
        problems.push('montant absent de la source');
      } else if (input.amountTotalCents !== row.amountCents) {
        problems.push('montant');
      }
      if (input.currency == null) {
        problems.push('devise absente de la source');
      } else if (input.currency.toLowerCase() !== row.currency.toLowerCase()) {
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
            providerCallState: 'RESOLVED',
            // GO V5 §1 — décision webhook terminale : revendication invalidée.
            dispatchOwner: null,
            dispatchClaimedAt: null,
          },
        });
        return {
          outcome: { outcome: 'needs_review' as const, reference: row.reference, reason },
        };
      }

      // ─── DIVERGENCE DES PARCOURS ─────────────────────────────────────────
      // `kind = ORDER` : règlement d'UNE COMMANDE (aucun mouvement de
      // portefeuille) — chemin du lot « paiement direct ». `kind = TOPUP` :
      // recharge du portefeuille (chemin historique, inchangé).
      if (row.kind === CardPaymentKind.ORDER) {
        return this.settleOrderInTx(tx, row, input);
      }

      return { outcome: await this.settleTopupInTx(tx, row, input) };
      },
    );

    // Effets POST-COMMIT d'un règlement de commande (email + provisioning) :
    // best-effort, JAMAIS après un commit sans les avoir tentés.
    if (branch.postEffect && !branch.postEffect.outcome.alreadyConfirmed) {
      await this.checkout.afterConfirmOrderPaid(
        branch.postEffect.outcome,
        branch.postEffect.orderId,
        branch.postEffect.ctx,
      );
    }
    return branch.outcome;
  }

  /**
   * Corps de la RECHARGE (kind = TOPUP) : contrôle de la devise du
   * portefeuille, crédit idempotent (`cardpay:<id>`), CAS du paiement.
   */
  private async settleTopupInTx(
    tx: Prisma.TransactionClient,
    row: CardPayment,
    input: ConfirmPaidInput,
  ): Promise<ConfirmOutcome> {
    const customer = await tx.customer.findUnique({
      where: { id: row.customerId },
      select: { walletCurrency: true },
    });
    if (!customer) {
      return { outcome: 'not_found' };
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
      return { outcome: 'needs_review', reference: row.reference, reason };
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
        // §4 — issue ÉTABLIE : l'appel n'est plus UNCERTAIN (le blocage des
        // nouveaux encaissements s'efface pour ce paiement).
        providerCallState: 'RESOLVED',
        // GO V5 §1 — la décision webhook est TERMINALE : la revendication
        // d'expédition est INVALIDÉE (lease annulé) pour qu'aucune réponse
        // tardive ne tente plus d'écrire sur cette ligne.
        dispatchOwner: null,
        dispatchClaimedAt: null,
      },
    });
    if (cas.count !== 1) {
      // Course perdue malgré le verrou (défense en profondeur) : aucun
      // double crédit possible, le crédit éventuel reste rattaché à la clé.
      return { outcome: 'already', reference: row.reference };
    }

    return {
      outcome: 'credited',
      reference: row.reference,
      balanceCents: credit.balanceCents,
    };
  }

  /**
   * Règlement d'UNE COMMANDE par carte (kind = ORDER) — LA transaction porte à
   * la fois le règlement et le marquage du paiement :
   *
   *  1. verrou `FOR UPDATE` de la commande (ordre canonique Carte puis
   *     Commande — verrous déjà pris : paiement puis commande) ;
   *  2. contrôles défensifs client / montant / devise (la source a déjà été
   *     contrôlée contre le paiement ci-dessus) ;
   *  3. CAS unique `PENDING_PAYMENT → PAID` via `CheckoutService.confirmOrderWithin`
   *     : mêmes droits, mêmes états, même historique qu'un règlement par solde ;
   *  4. CAS du paiement `CREATED/PROCESSING → SUCCEEDED` (défense en profondeur) ;
   *  5. effets (email, provisioning) RENVOYÉS pour exécution APRÈS commit.
   *
   * ZÉRO mouvement de portefeuille : la commande réglée par carte n'est ni
   * créditée ni débitée (encaissement côté prestataire uniquement).
   */
  private async settleOrderInTx(
    tx: Prisma.TransactionClient,
    row: CardPayment,
    input: ConfirmPaidInput,
  ): Promise<ConfirmBranch> {
    const review = async (reason: string): Promise<ConfirmBranch> => {
      await tx.cardPayment.update({
        where: { id: row.id },
        data: {
          status: CardPaymentStatus.NEEDS_REVIEW,
          paidAt: new Date(),
          interventionNeeded: true,
          interventionReason: reason.slice(0, 300),
          providerCallState: 'RESOLVED',
          // GO V5 §1 — branche terminal (intervention humaine) : revendication
          // invalidée, aucune réponse tardive ne peut plus dégrader ce constat.
          dispatchOwner: null,
          dispatchClaimedAt: null,
        },
      });
      return { outcome: { outcome: 'needs_review', reference: row.reference, reason } };
    };

    if (!row.orderId) {
      return review('paiement de commande sans commande rattachée');
    }

    // 1. Verrou commande — sérialise avec tout autre règlement concurrent.
    const orders = await tx.$queryRaw<LockedOrderRow[]>`
      SELECT id, status, "customerId", "amountTtcCents", currency
      FROM "Order" WHERE id = ${row.orderId} FOR UPDATE`;
    if (orders.length === 0) {
      return review('commande rattachée introuvable');
    }
    const order = orders[0];

    // 2. Contrôles commande ↔ paiement (jamais de règlement « à peu près »).
    const mismatches: string[] = [];
    if (order.customerId !== row.customerId) mismatches.push('client');
    if (order.amountTtcCents !== row.amountCents) mismatches.push('montant');
    if (String(order.currency).toUpperCase() !== row.currency.toUpperCase()) {
      mismatches.push('devise');
    }
    if (mismatches.length > 0) {
      return review(`commande/paiement incohérents (${mismatches.join(' + ')})`);
    }

    // 3. CAS de la commande — MÊME corps que tout autre règlement.
    const ctx: ConfirmPaidContext = {
      source: 'card',
      reference: row.reference,
    };
    let conf: ConfirmTxOutcome;
    try {
      conf = await this.checkout.confirmOrderWithin(tx, row.orderId, ctx);
    } catch (err) {
      if (
        err instanceof ConflictException ||
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      ) {
        // Commande annulée / remboursée / non réglable : fonds encaissés chez
        // le prestataire, AUCUN droit ouvert, AUCUN recrédit → intervention
        // (remboursement suivi par l'admin, jamais un crédit wallet inventé).
        const reason = err instanceof Error ? err.message : 'règlement refusé';
        return review(`règlement de commande refusé : ${reason}`);
      }
      throw err; // autre erreur → rollback intégral (le prestataire rejoue)
    }

    // 4. Marquage du paiement (défense en profondeur sous verrou).
    const common = {
      paidAt: new Date(),
      providerPaymentRef: input.paymentRef ?? row.providerPaymentRef,
      livemode: input.livemode ?? row.livemode,
      // §4 — issue ÉTABLIE (règlement ou contradiction tranchée) : l'appel
      // n'est plus UNCERTAIN.
      providerCallState: 'RESOLVED',
      // GO V5 §1 — décision webhook TERMINALE : revendication invalidée
      // (aucune réponse tardive ne peut plus écrire sur cette ligne).
      dispatchOwner: null,
      dispatchClaimedAt: null,
    };
    if (conf.alreadyConfirmed) {
      // La commande est déjà réglée par un AUTRE moyen alors que la session
      // carte était ouverte : fonds encaissés → aucun recrédit automatique,
      // intervention explicite pour rembourser sur le paiement d'origine.
      await tx.cardPayment.updateMany({
        where: {
          id: row.id,
          status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
        },
        data: {
          ...common,
          interventionNeeded: true,
          interventionReason:
            'commande réglée par un autre moyen alors que ce règlement par carte était ouvert',
        },
      });
      return {
        outcome: {
          outcome: 'needs_review',
          reference: row.reference,
          reason: 'commande déjà réglée par un autre moyen',
        },
      };
    }

    const cas = await tx.cardPayment.updateMany({
      where: {
        id: row.id,
        status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
      },
      data: { ...common, status: CardPaymentStatus.SUCCEEDED },
    });
    return {
      outcome:
        cas.count === 1
          ? { outcome: 'settled', reference: row.reference, orderId: row.orderId }
          : { outcome: 'already', reference: row.reference },
      postEffect: { outcome: conf, orderId: row.orderId, ctx },
    };
  }

  /**
   * CAS `CREATED → EXPIRED` (aucun crédit).
   * GO P1 — limité au fournisseur ayant authentifié l'événement.
   */
  async markExpired(sessionRef: string, providerCode: string): Promise<boolean> {
    const res = await this.prisma.cardPayment.updateMany({
      where: {
        providerSessionRef: sessionRef,
        providerCode,
        status: CardPaymentStatus.CREATED,
      },
      data: {
        status: CardPaymentStatus.EXPIRED,
        providerCallState: 'RESOLVED',
        // GO V5 §1 — décision webhook terminale : revendication invalidée.
        dispatchOwner: null,
        dispatchClaimedAt: null,
      },
    });
    return res.count === 1;
  }

  /**
   * CAS `CREATED/PROCESSING → CANCELED|FAILED` (aucun crédit).
   * GO P1 — limité au fournisseur ayant authentifié l'événement.
   */
  async markFailed(input: {
    sessionRef?: string | null;
    paymentRef?: string | null;
    providerCode: string;
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
        providerCode: input.providerCode,
        status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
      },
      data: {
        status: input.status,
        providerCallState: 'RESOLVED',
        failureCode: input.code ?? null,
        failureMessage: input.message?.slice(0, 500) ?? null,
        // GO V5 §1 — décision webhook terminale : revendication invalidée.
        dispatchOwner: null,
        dispatchClaimedAt: null,
      },
    });
    return res.count === 1 ? null : null;
  }

  /**
   * GO P7 — note d'échec SANS changement d'état : un `payment_intent` encore
   * vivant reste `CREATED/PROCESSING` (un succès ultérieur reste créditable),
   * l'erreur est simplement rendue visible côté client.
   */
  async markFailureNotice(input: {
    paymentRef: string;
    providerCode: string;
    code?: string | null;
    message?: string | null;
  }): Promise<string | null> {
    const res = await this.prisma.cardPayment.updateMany({
      where: {
        providerPaymentRef: input.paymentRef,
        providerCode: input.providerCode,
        status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
      },
      data: {
        failureCode: input.code ?? null,
        failureMessage: input.message?.slice(0, 500) ?? null,
      },
    });
    return res.count === 1 ? null : null;
  }

  /**
   * CAS `CREATED → PROCESSING` : paiement non confirmé (aucun crédit).
   * GO P1 — limité au fournisseur ayant authentifié l'événement.
   */
  async markProcessing(
    sessionRef: string | null,
    paymentRef: string | null,
    providerCode: string,
  ): Promise<void> {
    if (!sessionRef && !paymentRef) return;
    const where: Prisma.CardPaymentWhereInput = sessionRef
      ? { providerSessionRef: sessionRef }
      : { providerPaymentRef: paymentRef! };
    await this.prisma.cardPayment.updateMany({
      where: { ...where, providerCode, status: CardPaymentStatus.CREATED },
      data: { status: CardPaymentStatus.PROCESSING },
    });
  }

  /**
   * Remboursement constaté CÔTÉ PRESTATAIRE (dashboard) : l'état carte est
   * mis à jour, mais le crédit wallet n'est PAS modifié automatiquement —
   * c'est une opération hors plateforme → intervention + audit explicite
   * (jamais de dette silencieuse, jamais de remboursement double).
   *
   * GO §2/§1 — l'observation prestataire n'est qu'un PLANCHER : le compteur
   * `refundedCents` est RECALCULÉ par l'UNION DES IDENTITÉS (somme des
   * remboursements internes soldés ∪ observations externes distinctes ∪
   * plancher cumulatif `charge.amount_refunded` ∪ courant). Une même opération
   * arrivant par `charge.refunded`, `refund.updated` et la réponse API
   * n'avance donc qu'UNE fois (le double count est structurellement
   * impossible) ; un dépassement du montant encaissé devient `NEEDS_REVIEW`
   * + intervention, jamais un chiffre lissé.
   *
   * NB : `amountRefundedCents` est le CUMUL `charge.amount_refunded` (seule
   * source cumulée) — le montant INDIVIDUEL d'un `refund.*` passe par
   * `recordRefundObservation` (identité), JAMAIS par ici.
   */
  async applyChargeRefunded(input: {
    paymentRef: string;
    amountRefundedCents: number;
    chargeRefundIds: string[];
    /** GO P1 — fournisseur ayant authentifié l'événement. */
    providerCode: string;
  }): Promise<string | null> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerPaymentRef: input.paymentRef, providerCode: input.providerCode },
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

    const observed = Math.max(0, Math.floor(input.amountRefundedCents));
    await this.prisma.$transaction(async (tx) => {
      await syncRefundedCents(tx, row.id, { observedCumulativeCents: observed });
      if (!ours) {
        // GO §2/§6 — remboursement hors plateforme : signal VISIBLE, solde
        // jamais modifié automatiquement (l'admin vérifie et rembourse).
        await tx.cardPayment.update({
          where: { id: row.id },
          data: {
            interventionNeeded: true,
            interventionReason:
              'remboursement prestataire hors plateforme : vérifier le solde wallet',
          },
        });
      }
    });
    if (!ours && row.walletTransactionId) {
      await this.prisma.walletTransaction.updateMany({
        where: { id: row.walletTransactionId },
        data: { disputedAt: new Date() },
      });
    }
    return row.id;
  }

  /**
   * GO revue §1 — remboursement EXTERNE observé par IDENTITÉ (`refund.*`).
   *
   * Le montant individuel du remboursement est enregistré comme une
   * observation `[cardPaymentId, providerRef]` (jamais comme un plancher
   * cumulé de charge) puis le compteur est recalculé par UNION : deux
   * remboursements externes distincts 300 puis 400 donnent 700, jamais
   * max → 400. Une observation SANS montant est une incertitude explicite
   * (motif « rapprochement ») qui bloque les opérations dépendantes du
   * plafond jusqu'à l'acquittement admin.
   *
   * Sans remboursement interne correspondant : signal hors plateforme
   * visible (`interventionNeeded`), solde wallet JAMAIS modifié ici.
   */
  async recordRefundObservation(input: {
    paymentRef: string;
    providerRef: string;
    /** Montant individuel du remboursement ; null = inconnu (incertitude). */
    amountCents: number | null;
    providerStatus: string;
    /** GO P1 — fournisseur ayant authentifié l'événement. */
    providerCode: string;
  }): Promise<string | null> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerPaymentRef: input.paymentRef, providerCode: input.providerCode },
    });
    if (!row) return null;

    await this.prisma.$transaction(async (tx) => {
      // Verrou PAIEMENT en PREMIER (ordre canonique) : l'upsert des
      // observations prend une clé étrangère sur le paiement (FOR KEY SHARE)
      // qui bloquerait le FOR UPDATE de sync — deux observations concurrentes
      // se croiseraient (deadlock). Le verrou ligne rend l'upsert suivant
      // sérialisé ; sync reprend le même verrou (réentrant dans la tx).
      await tx.$queryRaw`SELECT id FROM "CardPayment" WHERE id = ${row.id} FOR UPDATE`;

      // Identité durable : rejeu = même ligne (aucun second avancement).
      await tx.refundObservation.upsert({
        where: {
          cardPaymentId_providerRef: {
            cardPaymentId: row.id,
            providerRef: input.providerRef,
          },
        },
        // Un montant ultérieur comble l'incertitude ; un repli sans montant
        // ne dégrade JAMAIS une identité déjà chiffrée.
        update: { amountCents: input.amountCents ?? undefined },
        create: {
          cardPaymentId: row.id,
          providerCode: input.providerCode,
          providerRef: input.providerRef,
          amountCents: input.amountCents,
          status: input.providerStatus,
          source: 'webhook:refund.*',
        },
      });

      const ours = await tx.refund.findFirst({
        where: { cardPaymentId: row.id, providerRef: input.providerRef },
        select: { id: true },
      });
      if (!ours) {
        // Signal hors plateforme : AVANT sync (la raison « rapprochement » de
        // sync prime si une incertitude est ouverte).
        await tx.cardPayment.update({
          where: { id: row.id },
          data: {
            interventionNeeded: true,
            interventionReason:
              'remboursement prestataire hors plateforme : vérifier le solde wallet',
          },
        });
      }

      // UNION des identités (l'incertitude sans montant est relevée ici).
      await syncRefundedCents(tx, row.id);
    });

    if (!row.walletTransactionId) return row.id;
    // Observation externe : la trace wallet est marquée (solde INCHANGÉ —
    // aucun crédit annulé automatiquement, l'admin vérifie et rembourse).
    await this.prisma.walletTransaction.updateMany({
      where: { id: row.walletTransactionId },
      data: { disputedAt: new Date() },
    });
    return row.id;
  }

  /** Litige carte : drapeau visible + audit, solde inchangé (traitement conservateur). */
  async applyDispute(input: {
    paymentRef: string;
    disputeId: string;
    reason: string | null;
    closed?: boolean;
    /** GO P1 — fournisseur ayant authentifié l'événement. */
    providerCode: string;
  }): Promise<string | null> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerPaymentRef: input.paymentRef, providerCode: input.providerCode },
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
  async resolveIntervention(id: string, note: string, resolvedBy?: string): Promise<void> {
    const res = await this.prisma.cardPayment.updateMany({
      where: { id, interventionNeeded: true },
      data: { interventionNeeded: false, interventionReason: note.slice(0, 300) },
    });
    if (res.count !== 1) {
      throw new ConflictException('Aucune intervention en attente sur ce paiement.');
    }
    // GO revue §1 — le rapprochement acquitte les observations ouvertes :
    // l'incertitude (montant inconnu) est levée, la TRACE est conservée
    // (acknowledgedAt/acknowledgedBy) — jamais de ligne effacée.
    await this.prisma.refundObservation.updateMany({
      where: { cardPaymentId: id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: resolvedBy ?? null },
    });
    // §4 — l'humain a établi l'issue : l'appel n'est plus UNCERTAIN (le
    // blocage des nouveaux encaissements s'efface, l'historique est conservé).
    await this.prisma.cardPayment
      .updateMany({
        where: { id, providerCallState: 'UNCERTAIN' },
        data: { providerCallState: 'RESOLVED' },
      })
      .catch(() => undefined);
  }
}
