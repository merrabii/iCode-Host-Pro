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
import { ConnectorSession } from './payment-connector';
import { PaymentProviderService, ResolvedProvider } from './payment-provider.service';
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
   * GO P2 — MÊME clé + MÊME intention = MÊME paiement, quel que soit son état.
   * Aucune création récursive, aucune nouvelle clé, aucun second paiement.
   */
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

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');

    // 1. Identité de l'opération persistée AVANT le premier octet réseau.
    await this.prisma.cardPayment.update({
      where: { id: row.id },
      data: { providerCallState: 'DISPATCHED', dispatchedAt: new Date() },
    });

    let session: ConnectorSession;
    try {
      session = await resolved.connector.createCheckoutSession({
        reference: row.reference,
        amountCents: row.amountCents,
        currency: row.currency.toLowerCase(),
        customerEmail: (await this.wallet.ensureOwnedCustomer(user)).email,
        successUrl: `${webOrigin}/client/portefeuille/paiement?ref=${encodeURIComponent(row.reference)}`,
        cancelUrl: `${webOrigin}/client/portefeuille/paiement?ref=${encodeURIComponent(row.reference)}&canceled=1`,
        metadata: { reference: row.reference, customerId: row.customerId },
        // Clé STABLE par opération : toute reprise = même session prestataire.
        idempotencyKey: `topup:${row.reference}`,
      });
    } catch (err) {
      return this.handleDispatchFailure(row, user, err);
    }

    let updated: CardPayment;
    try {
      updated = await this.prisma.cardPayment.update({
        where: { id: row.id },
        data: {
          providerSessionRef: session.sessionRef,
          providerPaymentRef: session.paymentRef,
          checkoutUrl: session.checkoutUrl,
          livemode: session.livemode,
          expiresAt: session.expiresAt,
          providerCallState: 'RESOLVED',
        },
      });
    } catch (err) {
      // GO P3 — échec de PERSISTANCE après création chez le prestataire :
      // la clé `topup:<référence>` est déjà consommée, la reprise (même clé)
      // obtient la MÊME session. Aucune seconde création.
      await this.prisma.cardPayment
        .update({
          where: { id: row.id },
          data: { providerCallState: 'UNCERTAIN' },
        })
        .catch(() => undefined);
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'payment.topup.persistence_failed',
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

    await this.audit
      .record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'payment.topup.create',
        resourceType: 'cardPayment',
        resourceId: row.id,
        details: {
          reference: row.reference,
          amountCents: row.amountCents,
          currency: row.currency,
          providerCode: resolved.code,
          environment: resolved.environment,
        },
      })
      .catch(() => undefined); // l'audit ne casse jamais une session créée

    return this.toClientView(updated);
  }

  /** GO P3 — classement honnête de l'échec d'appel (jamais « FAILED » à tort). */
  private isUncertainDispatchError(err: unknown): boolean {
    if (err instanceof StripeHttpError) {
      if (typeof err.status === 'number') {
        if (err.status === 0) return true; // réseau/timeout : peut être arrivé
        if (err.status >= 500) return true; // 5xx : traité ou non, indécidable
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
  ): Promise<CardPaymentClientView> {
    const message =
      err instanceof StripeHttpError || err instanceof Error
        ? err.message
        : String(err);
    const uncertain = this.isUncertainDispatchError(err);

    if (uncertain) {
      await this.prisma.cardPayment.update({
        where: { id: row.id },
        data: { providerCallState: 'UNCERTAIN' },
      });
      await this.audit
        .record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'payment.topup.dispatch_uncertain',
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

    await this.prisma.cardPayment.update({
      where: { id: row.id },
      data: {
        status: CardPaymentStatus.FAILED,
        providerCallState: 'RESOLVED',
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

    // GO P3 — appel resté incertain (ou échec de persistance) : la relecture
    // rejoue d'abord la CRÉATION avec la MÊME clé `topup:<référence>` →
    // MÊME session chez le prestataire, jamais une seconde.
    if (this.needsProviderDispatch(row)) {
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
  async confirmPaid(input: {
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

      // GO P1 — un événement d'un AUTRE fournisseur ne touche JAMAIS la ligne :
      // ni crédit, ni débit, ni changement d'état, ni intervention.
      if (input.providerCode !== row.providerCode) {
        return {
          outcome: 'ignored' as const,
          reference: row.reference,
          reason: `fournisseur non rattaché (${input.providerCode} ≠ ${row.providerCode})`,
        };
      }

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
      data: { status: CardPaymentStatus.EXPIRED },
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
        failureCode: input.code ?? null,
        failureMessage: input.message?.slice(0, 500) ?? null,
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
   * GO P6 — le montant remboursé constaté n'est JAMAIS plafonné silencieusement
   * (`Math.min` masquait un écart de preuve) : au-delà du montant du paiement,
   * l'état devient `NEEDS_REVIEW` + intervention (signal honnête).
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

    const amountRefunded = Math.max(0, input.amountRefundedCents);
    if (amountRefunded > row.amountCents) {
      // GO P6 — preuve de remboursement supérieure au paiement : écart VISIBLE,
      // jamais un chiffre lissé.
      const reason = `remboursement constaté (${amountRefunded}) > montant du paiement (${row.amountCents})`;
      await this.prisma.cardPayment.update({
        where: { id: row.id },
        data: {
          refundedCents: row.refundedCents,
          status: CardPaymentStatus.NEEDS_REVIEW,
          interventionNeeded: true,
          interventionReason: reason,
        },
      });
      return row.id;
    }

    // Somme SANS plafond artificiel : `refundedCents` = réellement remboursé.
    const refunded = Math.max(amountRefunded, row.refundedCents);
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
