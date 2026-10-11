import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CardPaymentKind,
  CardPaymentStatus,
  InvoiceLineKind,
  InvoiceStatus,
  OrderStatus,
  Prisma,
  RefundKind,
  RefundStatus,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/types';
import { claimInvoiceSequence } from './invoice-sequence';

export interface CreateRefundInput {
  amountCents: number;
  kind: RefundKind;
  reason?: string | null;
  issueCreditNote?: boolean;
}

export interface RefundView {
  id: string;
  // GO Stripe — nullable : un remboursement de RECHARGE carte n'a pas de
  // commande (rattachement `cardPaymentId`).
  orderId: string | null;
  // Lot « paiement direct des commandes » — un remboursement de COMMANDE
  // réglée par carte porte les DEUX rattachements (orderId + cardPaymentId) :
  // suivi de l'origine, AUCUN mouvement de portefeuille.
  cardPaymentId: string | null;
  invoiceId: string | null;
  kind: RefundKind;
  status: RefundStatus;
  amountCents: number;
  currency: string;
  reason: string | null;
  issueCreditNote: boolean;
  idempotencyKey: string;
  walletTransactionId: string | null;
  creditNoteInvoiceId: string | null;
  providerRef: string | null;
  createdByEmail: string | null;
  processedAt: Date | null;
  createdAt: Date;
  replayed: boolean;
}

/**
 * GO Q9 — identité d'une intention de remboursement. Un rejeu (même clé) n'est
 * accepté que si TOUT correspond ; sinon 409, jamais d'effet silencieux.
 */
export function refundIdentityMatches(
  existing: {
    orderId: string | null;
    amountCents: number;
    kind: RefundKind;
    issueCreditNote: boolean;
    reason: string | null;
  },
  orderId: string,
  input: CreateRefundInput,
): boolean {
  return (
    existing.orderId === orderId &&
    existing.amountCents === input.amountCents &&
    existing.kind === input.kind &&
    existing.issueCreditNote === (input.issueCreditNote ?? false) &&
    (existing.reason ?? null) === (input.reason ?? null)
  );
}

/** GO Q9 — plafond : cumul (PENDING + SUCCEEDED) + demande ≤ montant encaissé. */
export function refundCapExceeded(
  capturedCents: number,
  usedCents: number,
  amountCents: number,
): boolean {
  return usedCents + amountCents > capturedCents;
}

/** GO P5 — ligne source (facture d'origine) qu'une pièce de crédit recrédite. */
export interface CreditNoteSourceLine {
  id: string;
  label: string;
  taxRatePercent: Prisma.Decimal | number | string;
  taxAmountCents: number;
  totalTtcCents: number;
  sortOrder: number;
}

/** GO P5 — brouillon d'une ligne CREDIT d'un avoir. */
export interface CreditNoteLineDraft {
  sourceLineId: string;
  label: string;
  qty: number;
  unitPriceHtCents: number;
  taxRatePercent: number;
  taxAmountCents: number;
  totalTtcCents: number;
  sortOrder: number;
}

/**
 * GO P5 — allocation d'un remboursement sur les lignes RÉELLEMENT
 * recréditées de la facture d'origine (ordre `sortOrder`) :
 *  • chaque ligne conserve son TRAITEMENT FISCAL propre — aucun taux global
 *    appliqué à des frais non taxés ;
 *  • une fraction partielle arrondit la taxe au centime, HT = TTC − taxe ;
 *  • une couverture TOTALE de la ligne reprend le reste EXACT (aucune dérive
 *    d'arrondi : somme des pièces = totaux source) ;
 *  • `creditedBySource` = sommes déjà émises sur chaque ligne source par
 *    les avoirs précédents (restes disponibles).
 * Lève ConflictException si le montant dépasse les lignes disponibles.
 */
export function allocateCreditLines(
  sourceLines: readonly CreditNoteSourceLine[],
  creditedBySource: ReadonlyMap<string, { ttc: number; tax: number }>,
  amountCents: number,
): { lines: CreditNoteLineDraft[]; ht: number; tax: number; ttc: number } {
  const ordered = [...sourceLines].sort((a, b) => a.sortOrder - b.sortOrder);
  const lines: CreditNoteLineDraft[] = [];
  let rem = amountCents;
  let ht = 0;
  let tax = 0;
  let ttc = 0;
  for (const src of ordered) {
    if (rem <= 0) break;
    const taken = creditedBySource.get(src.id) ?? { ttc: 0, tax: 0 };
    const remLineTtc = src.totalTtcCents - taken.ttc;
    const remLineTax = src.taxAmountCents - taken.tax;
    if (remLineTtc <= 0) continue;
    const part = Math.min(rem, remLineTtc);
    const partTax =
      part === remLineTtc
        ? remLineTax // couverture totale : reste EXACT de la ligne
        : Math.round((remLineTax * part) / remLineTtc); // fraction : taxe arrondie
    const partHt = part - partTax;
    lines.push({
      sourceLineId: src.id,
      label: src.label,
      qty: 1,
      unitPriceHtCents: partHt,
      taxRatePercent: Number(src.taxRatePercent),
      taxAmountCents: partTax,
      totalTtcCents: part,
      sortOrder: lines.length,
    });
    ht += partHt;
    tax += partTax;
    ttc += part;
    rem -= part;
  }
  if (rem > 0) {
    throw new ConflictException(
      `Lignes de facture insuffisantes pour l'avoir : ${amountCents} cents demandés, ${ttc} cents disponibles.`,
    );
  }
  return { lines, ht, tax, ttc };
}

/** Header Idempotency-Key : 8..128 caractères imprimables ASCII. */
export function assertRefundIdempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();
  if (key.length < 8 || key.length > 128 || !/^[\x20-\x7E]+$/.test(key)) {
    throw new BadRequestException(
      'Header Idempotency-Key requis (8 à 128 caractères imprimables).',
    );
  }
  return key;
}

/**
 * GO Q9 — fondations INTERNES des remboursements/avoirs.
 *
 * Décisions de conception (item 9 verbatim) :
 *  • liens au paiement d'origine : chaque Remboursement porte `orderId` (verrou
 *    `FOR UPDATE` d'abord) et `invoiceId` (facture réglée visée) ;
 *  • plafond : cumul PENDING+SUCCEEDED ≤ `Order.amountTtcCents` (aucun
 *    remboursement cumulé supérieur au montant encaissé) ;
 *  • idempotence : `idempotencyKey` unique — même clé + même intention = rejeu
 *    sans effet ; même clé + intention différente = 409 ; le crédit wallet est
 *    lui-même idempotent (`refund:<clé>`) ;
 *  • concurrence : verrou COMMANDE d'abord (ordre canonique commande → facture
 *    → client, identique au paiement) — deux remboursements concurrents de la
 *    même commande sont sérialisés, le plafond est exact ;
 *  • interne vs externe : WALLET_CREDIT s'exécute dans la même transaction ;
 *    EXTERNAL_CARD reste PENDING tant que le prestataire n'a pas confirmé
 *    réellement — AUCUN succès externe n'est déclarable aujourd'hui (l'adaptateur
 *    carte n'est pas configuré, décision GO : carte réelle désactivée) ;
 *  • avoirs : `issueCreditNote` émet UNE PIÈCE `CREDITED` par remboursement,
 *    liée par `creditNoteOfId` (numéros `AV-` sur la séquence partagée) — un
 *    avoir déjà émis n'est jamais augmenté ni re-rendu (GO P5) ; montants
 *    HT/taxe depuis les lignes réellement recréditées (`allocateCreditLines`,
 *    traitement fiscal par ligne, restes exacts via `InvoiceLine.sourceLineId`,
 *    coordonnées de facturation reprises) ;
 *  • traçabilité : audits `refund.created` / `refund.succeeded` /
 *    `refund.provider_confirmation_refused` + snapshots acteur.
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  async createRefund(
    orderId: string,
    input: CreateRefundInput,
    idempotencyKey: string | undefined,
    actor: JwtPayload,
  ): Promise<RefundView> {
    const key = assertRefundIdempotencyKey(idempotencyKey);
    if (
      input.kind === RefundKind.EXTERNAL_CARD &&
      (input.issueCreditNote ?? false)
    ) {
      throw new BadRequestException(
        "Un avoir n'est émis que pour un remboursement interne (WALLET_CREDIT).",
      );
    }
    const reason = input.reason?.trim() || null;

    // ── Lot « paiement direct des commandes » — ORIGINE DU RÈGLEMENT ──────
    // Une commande réglée PAR CARTE est remboursée VERS LA CARTE : le
    // règlement suit son origine (rattachement `orderId` + `cardPaymentId`,
    // AUCUN mouvement de portefeuille). Lecture NON verrouillée : elle sert
    // seulement à choisir l'ordre de verrou (paiement → commande, l'ordre
    // canonique partagé avec `confirmPaid` — jamais d'attente circulaire).
    const cardRows = await this.prisma.cardPayment.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        reference: true,
        status: true,
        kind: true,
        interventionNeeded: true,
        currency: true,
      },
    });
    const originOf = (rows: typeof cardRows) =>
      rows.find(
        (p) =>
          p.kind === CardPaymentKind.ORDER &&
          !p.interventionNeeded &&
          (p.status === CardPaymentStatus.SUCCEEDED ||
            p.status === CardPaymentStatus.PARTIALLY_REFUNDED),
      ) ?? null;
    const cardOrigin = originOf(cardRows);

    if (cardOrigin && input.kind === RefundKind.WALLET_CREDIT) {
      throw new ConflictException({
        message:
          `Commande réglée par carte (${cardOrigin.reference}) : le remboursement vers le solde ` +
          'du portefeuille est REFUSÉ — le règlement suit son origine ' +
          '(remboursement vers la carte, sans mouvement de portefeuille).',
        code: 'REFUND_ORIGIN_CARD',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 0) Verrou PAIEMENT(S) de la commande AVANT la commande — ordre
        //    canonique Carte → Commande (identique à `confirmPaid` : un
        //    règlement concurrent attend notre libération, jamais l'inverse).
        for (const p of cardRows) {
          await tx.$queryRaw`SELECT id FROM "CardPayment" WHERE id = ${p.id} FOR UPDATE`;
        }
        // 1) Verrou COMMANDE (ordre canonique : commande → facture → client).
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            status: OrderStatus;
            paidAt: Date | null;
            amountTtcCents: number;
            currency: string;
            customerId: string;
          }>
        >`
          SELECT id, status, "paidAt", "amountTtcCents", currency, "customerId"
          FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        if (rows.length === 0) {
          throw new NotFoundException('Commande introuvable.');
        }
        const order = rows[0];
        if (!order.paidAt) {
          throw new ConflictException(
            'Commande non encaissée : seul un paiement confirmé peut être remboursé.',
          );
        }

        // 2) Idempotence AVANT tout effet.
        const existing = await tx.refund.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) {
          if (
            !refundIdentityMatches(existing, orderId, { ...input, reason })
          ) {
            throw new ConflictException(
              "Clé d'idempotence déjà utilisée pour une autre opération de remboursement.",
            );
          }
          return this.toView(existing, true); // rejeu : AUCUN second effet
        }

        // 3) Plafond cumulé, sous le verrou commande (sérialisé par commande).
        const agg = await tx.refund.aggregate({
          where: {
            orderId,
            status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
          },
          _sum: { amountCents: true },
        });
        const used = agg._sum.amountCents ?? 0;
        if (refundCapExceeded(order.amountTtcCents, used, input.amountCents)) {
          throw new ConflictException(
            `Plafond de remboursement dépassé : encaissé ${order.amountTtcCents} cents, déjà engagé ${used} cents, demandé ${input.amountCents} cents.`,
          );
        }

        const origin = await tx.invoice.findUnique({
          where: { orderId },
          select: {
            id: true,
            number: true,
            status: true,
            currency: true,
            taxRatePercent: true,
            customerId: true,
            legalMentionsSnapshot: true,
            billingAddress: true,
          },
        });

        // 3bis) ORIGINE revérifiée SOUS verrou : un règlement concurrent ne
        //       peut pas se committer pendant que nous tenons la commande, le
        //       statut lu ici est stable.
        const freshCardRows = await tx.cardPayment.findMany({
          where: { orderId },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            reference: true,
            status: true,
            kind: true,
            interventionNeeded: true,
            currency: true,
          },
        });
        const originNow = originOf(freshCardRows);
        if (originNow) {
          const lockedIds = new Set(cardRows.map((p) => p.id));
          if (!lockedIds.has(originNow.id)) {
            // Défensif : origine apparue entre la lecture et les verrous —
            // refus explicite (aucune attente de verrou sous verrou commande,
            // donc aucun cycle avec un règlement en cours).
            throw new ConflictException(
              'Origine de règlement apparue pendant la préparation : nouvelle tentative requise.',
            );
          }
          if (input.kind !== RefundKind.EXTERNAL_CARD) {
            throw new ConflictException({
              message:
                `Commande réglée par carte (${originNow.reference}) : le remboursement vers le solde ` +
                'du portefeuille est REFUSÉ — le règlement suit son origine ' +
                '(remboursement vers la carte, sans mouvement de portefeuille).',
              code: 'REFUND_ORIGIN_CARD',
            });
          }
          return this.createCardOrderRefundInTx(tx, {
            orderId,
            order,
            invoiceId: origin?.id ?? null,
            input,
            key,
            reason,
            actor,
            orderUsed: used,
            cardRow: originNow,
          });
        }

        // 4) Enregistrement de l'intention (PENDING d'abord).
        const refund = await tx.refund.create({
          data: {
            orderId,
            invoiceId: origin?.id ?? null,
            kind: input.kind,
            status: RefundStatus.PENDING,
            amountCents: input.amountCents,
            currency: order.currency,
            reason,
            issueCreditNote: input.issueCreditNote ?? false,
            idempotencyKey: key,
            createdByUserId: actor.sub,
            createdByEmail: actor.email ?? null,
          },
        });

        if (input.kind === RefundKind.WALLET_CREDIT) {
          // 5) Effet interne dans LA MÊME transaction : opération indépendante
          //    du prestataire (le choix carte ne peut pas bloquer celle-ci).
          const walletKey = `refund:${key}`;
          await this.wallet.applyWithClient(
            tx,
            order.customerId,
            {
              amountCents: input.amountCents,
              idempotencyKey: walletKey,
              currency: order.currency,
              orderId,
              invoiceId: origin?.id ?? null,
              type: WalletTransactionType.REFUND,
              note: reason ? `Remboursement : ${reason}` : 'Remboursement',
            },
            'credit',
          );
          const wtx = await tx.walletTransaction.findUnique({
            where: { idempotencyKey: walletKey },
            select: { id: true },
          });

          // 6) Avoir : UNE PIÈCE par remboursement (GO P5). Un avoir déjà
          //    émis n'est JAMAIS augmenté — documents et PDF des pièces
          //    émises restent intacts ; chaque nouvelle pièce est LIÉE
          //    (creditNoteOfId + lignes sourceLineId) et NUMÉROTÉE sur la
          //    séquence partagée. Montants HT/taxe calculés depuis les
          //    lignes RÉELLEMENT recréditées : traitement fiscal propre à
          //    chaque ligne, aucun taux global sur des frais non taxés.
          let creditNoteInvoiceId: string | null = null;
          if (input.issueCreditNote) {
            if (!origin) {
              throw new ConflictException(
                "Aucune facture liée à ce paiement : émission d'avoir impossible.",
              );
            }
            const sourceLines = await tx.invoiceLine.findMany({
              where: { invoiceId: origin.id, sourceLineId: null },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                label: true,
                taxRatePercent: true,
                taxAmountCents: true,
                totalTtcCents: true,
                sortOrder: true,
              },
            });
            const creditedRows = sourceLines.length
              ? await tx.invoiceLine.groupBy({
                  by: ['sourceLineId'],
                  where: {
                    sourceLineId: { in: sourceLines.map((l) => l.id) },
                  },
                  _sum: { totalTtcCents: true, taxAmountCents: true },
                })
              : [];
            const credited = new Map<string, { ttc: number; tax: number }>();
            for (const r of creditedRows) {
              if (r.sourceLineId === null) continue;
              credited.set(r.sourceLineId, {
                ttc: r._sum.totalTtcCents ?? 0,
                tax: r._sum.taxAmountCents ?? 0,
              });
            }
            const draft = allocateCreditLines(
              sourceLines,
              credited,
              input.amountCents,
            );
            const claim = await claimInvoiceSequence(tx);
            const note = await tx.invoice.create({
              data: {
                number: `AV-${claim.invoiceNumber}`,
                customerId: origin.customerId,
                status: InvoiceStatus.CREDITED,
                currency: origin.currency,
                taxRatePercent: origin.taxRatePercent,
                amountHtCents: draft.ht,
                taxAmountCents: draft.tax,
                amountTtcCents: draft.ttc,
                paidAt: new Date(),
                creditNoteOfId: origin.id,
                legalMentionsSnapshot:
                  origin.legalMentionsSnapshot == null
                    ? Prisma.DbNull
                    : (origin.legalMentionsSnapshot as Prisma.InputJsonValue),
                // GO P5 : coordonnées de facturation reprises sur l'avoir.
                billingAddress:
                  origin.billingAddress == null
                    ? Prisma.DbNull
                    : (origin.billingAddress as Prisma.InputJsonValue),
                pdfRenderedStatus: null,
              },
            });
            for (const l of draft.lines) {
              await tx.invoiceLine.create({
                data: {
                  invoiceId: note.id,
                  kind: InvoiceLineKind.CREDIT,
                  sourceLineId: l.sourceLineId,
                  label: l.label,
                  qty: l.qty,
                  unitPriceHtCents: l.unitPriceHtCents,
                  taxRatePercent: l.taxRatePercent,
                  taxAmountCents: l.taxAmountCents,
                  totalTtcCents: l.totalTtcCents,
                  sortOrder: l.sortOrder,
                },
              });
            }
            creditNoteInvoiceId = note.id;
          }

          // 7) Statuts sur cumul RÉUSSI uniquement (GO P4) : une intention
          //    externe PENDING (non confirmée prestataire) ne constitue pas
          //    un remboursement — elle réserve seulement le plafond (étape 3).
          //    Le remboursement courant (wallet) bascule SUCCEEDED dans CETTE
          //    transaction : son montant compte comme réussi.
          const total = used + input.amountCents;
          const succeededAgg = await tx.refund.aggregate({
            where: { orderId, status: RefundStatus.SUCCEEDED },
            _sum: { amountCents: true },
          });
          const succeededTotal =
            (succeededAgg._sum.amountCents ?? 0) + input.amountCents;
          const fullyRefunded = succeededTotal === order.amountTtcCents;
          if (origin && fullyRefunded) {
            const target = creditNoteInvoiceId
              ? InvoiceStatus.CREDITED // réglé par avoir
              : InvoiceStatus.REFUNDED; // remboursement direct
            // CAS : seul PAID bascule (le PDF se re-stampe via Q8).
            await tx.invoice.updateMany({
              where: { id: origin.id, status: InvoiceStatus.PAID },
              data: { status: target },
            });
          }
          let orderStatusChanged = false;
          // Bascule UNIQUEMENT sur cumul complet (sinon la commande reste
          // PAID : un remboursement partiel n'éteint pas l'encaissement).
          if (order.status === OrderStatus.PAID && fullyRefunded) {
            const upd = await tx.order.updateMany({
              where: { id: orderId, status: OrderStatus.PAID },
              data: { status: OrderStatus.REFUNDED },
            });
            orderStatusChanged = upd.count === 1;
          }

          const done = await tx.refund.update({
            where: { id: refund.id },
            data: {
              status: RefundStatus.SUCCEEDED,
              walletTransactionId: wtx?.id ?? null,
              creditNoteInvoiceId,
              processedAt: new Date(),
            },
          });
          await this.audit.record(
            {
              actorId: actor.sub,
              actorEmail: actor.email,
              action: 'refund.succeeded',
              resourceType: 'refund',
              resourceId: done.id,
              details: {
                orderId,
                amountCents: input.amountCents,
                currency: order.currency,
                kind: input.kind,
                creditNoteInvoiceId,
                usedAfter: total,
                succeededAfter: succeededTotal,
                captured: order.amountTtcCents,
                fullyRefunded,
                orderStatusChanged,
              },
            },
            tx,
          );
          return this.toView(done, false);
        }

        // 8) Externe : PENDING, aucun effet, providerRef null — jamais de
        //    succès déclaré sans confirmation RÉELLE (adaptateur non configuré).
        await this.audit.record(
          {
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'refund.created',
            resourceType: 'refund',
            resourceId: refund.id,
            details: {
              orderId,
              amountCents: input.amountCents,
              currency: order.currency,
              kind: input.kind,
              provider: 'disabled',
            },
          },
          tx,
        );
        return this.toView(refund, false);
      }, { maxWait: 10000, timeout: 30000 });
    } catch (e) {
      // P2002 UNIQUEMENT sur la clé d'idempotence (course sur une autre
      // commande) : les autres collisions (numéro de facture…) ne sont PAS
      // requalifiées en conflit d'idempotence — elles remontent telles quelles.
      const target = (
        e instanceof Prisma.PrismaClientKnownRequestError
          ? (e.meta as { target?: unknown } | undefined)?.target
          : undefined
      ) as string | string[] | undefined;
      const hitKey =
        typeof target === 'string'
          ? target.includes('idempotencyKey')
          : Array.isArray(target) &&
            target.some((t) => String(t).includes('idempotencyKey'));
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        hitKey
      ) {
        throw new ConflictException(
          "Clé d'idempotence déjà utilisée pour une autre opération de remboursement.",
        );
      }
      throw e;
    }
  }

  /**
   * Remboursement d'une COMMANDE RÉGLÉE PAR CARTE — suivi de l'origine.
   *
   * Verrous déjà acquis par l'appelant, dans l'ordre canonique PAIEMENT →
   * COMMANDE (le seul partagé avec `confirmPaid` : aucun cycle d'attente).
   *
   *  • double plafond : commande (cumul PENDING+SUCCEEDED ≤ encaissé) +
   *    paiement (encaissés + réservations ≤ encaissé sur CE paiement) ;
   *  • création `PENDING` rattachée aux DEUX liens (`orderId` +
   *    `cardPaymentId`) + réservation dénormalisée `pendingRefundCents` ;
   *  • AUCUN mouvement de portefeuille (le client n'a jamais été crédité) et
   *    AUCUN avoir (réservé au parcours interne `WALLET_CREDIT`) ;
   *  • l'ÉMISSION vers le prestataire est déclenchée par l'appelant (hors
   *    transaction : aucun réseau sous verrou), idempotente par clé.
   */
  private async createCardOrderRefundInTx(
    tx: Prisma.TransactionClient,
    args: {
      orderId: string;
      order: {
        id: string;
        status: OrderStatus;
        paidAt: Date | null;
        amountTtcCents: number;
        currency: string;
        customerId: string;
      };
      invoiceId: string | null;
      input: CreateRefundInput;
      key: string;
      reason: string | null;
      actor: JwtPayload;
      orderUsed: number;
      cardRow: {
        id: string;
        reference: string;
        status: CardPaymentStatus;
        currency: string;
      };
    },
  ): Promise<RefundView> {
    const { orderId, order, invoiceId, input, key, reason, actor, cardRow } = args;

    if (
      cardRow.status !== CardPaymentStatus.SUCCEEDED &&
      cardRow.status !== CardPaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new ConflictException(
        `Paiement d'origine « ${cardRow.status} » : seul un règlement encaissé peut être remboursé.`,
      );
    }
    if (cardRow.currency.toUpperCase() !== order.currency.toUpperCase()) {
      throw new ConflictException(
        `Devise du paiement (${cardRow.currency}) ≠ devise de la commande (${order.currency}) : aucune opération mixte.`,
      );
    }

    // Paiement DÉJÀ verrouillé par l'appelant : valeurs stables.
    const pay = await tx.cardPayment.findUnique({ where: { id: cardRow.id } });
    if (!pay) throw new NotFoundException('Paiement d’origine introuvable.');

    // GO revue §1 — incertitude prestataire non rapprochée : opération
    // dépendante du plafond REFUSÉE jusqu'à l'acquittement admin.
    const uncertain = await tx.refundObservation.findFirst({
      where: { cardPaymentId: pay.id, amountCents: null, acknowledgedAt: null },
      select: { providerRef: true },
    });
    if (uncertain) {
      throw new ConflictException(
        `Rapprochement requis : observation prestataire ${uncertain.providerRef} sans montant non acquittée — remboursement REFUSÉ tant que le rapprochement n'est pas effectué (paiement ${pay.reference}).`,
      );
    }

    // Plafond PAIEMENT : encaissés + réservations (aucun cumul au-delà).
    const reserved = await tx.refund.aggregate({
      where: { cardPaymentId: pay.id, status: RefundStatus.PENDING },
      _sum: { amountCents: true },
    });
    const payUsed =
      pay.refundedCents +
      Math.max(pay.pendingRefundCents ?? 0, reserved._sum.amountCents ?? 0);
    if (refundCapExceeded(pay.amountCents, payUsed, input.amountCents)) {
      throw new ConflictException(
        `Plafond de remboursement dépassé sur le paiement ${pay.reference} : encaissé ${pay.amountCents} cents, déjà engagé ${payUsed} cents, demandé ${input.amountCents} cents.`,
      );
    }

    const refund = await tx.refund.create({
      data: {
        orderId,
        cardPaymentId: pay.id,
        invoiceId,
        kind: RefundKind.EXTERNAL_CARD,
        status: RefundStatus.PENDING,
        amountCents: input.amountCents,
        currency: order.currency,
        reason,
        issueCreditNote: false,
        idempotencyKey: key,
        createdByUserId: actor.sub,
        createdByEmail: actor.email ?? null,
      },
    });

    // Réservation dénormalisée (libérée à l'issue du règlement prestataire).
    await tx.cardPayment.update({
      where: { id: pay.id },
      data: { pendingRefundCents: { increment: input.amountCents } },
    });

    await this.audit.record(
      {
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'refund.order.create',
        resourceType: 'refund',
        resourceId: refund.id,
        details: {
          orderId,
          cardPaymentId: pay.id,
          paymentReference: pay.reference,
          amountCents: input.amountCents,
          currency: order.currency,
          kind: input.kind,
          orderUsedAfter: args.orderUsed + input.amountCents,
          paymentUsedAfter: payUsed + input.amountCents,
          provider: 'card_origin',
          handling: 'rattaché_origine_sans_mouvement_wallet',
        },
      },
      tx,
    );

    return this.toView(refund, false);
  }

  async listForOrder(orderId: string): Promise<RefundView[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    const rows = await this.prisma.refund.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r, false));
  }

  async getRefund(id: string): Promise<RefundView> {
    const row = await this.prisma.refund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Remboursement introuvable.');
    return this.toView(row, false);
  }

  /**
   * Contrat explicite du prestataire (GO item 9) : aujourd'hui l'adaptateur
   * carte n'est PAS configuré, donc AUCUNE confirmation externe n'est acceptée —
   * le refus est tracé (audit) et le remboursement reste PENDING. Le choix du
   * prestataire ne bloque que SON adaptateur, jamais les opérations internes
   * (WALLET_CREDIT ci-dessus).
   */
  async refuseProviderConfirmation(
    id: string,
    actor: JwtPayload,
  ): Promise<never> {
    const row = await this.prisma.refund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Remboursement introuvable.');
    if (row.kind !== RefundKind.EXTERNAL_CARD) {
      throw new ConflictException(
        'Opération interne : aucune confirmation prestataire requise.',
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'refund.provider_confirmation_refused',
      resourceType: 'refund',
      resourceId: row.id,
      details: {
        orderId: row.orderId,
        status: row.status,
        reason: 'provider_adapter_not_configured',
      },
    });
    throw new ConflictException(
      'Adaptateur prestataire non configuré : un remboursement externe ne peut être déclaré réussi sans confirmation RÉELLE du prestataire.',
    );
  }

  /**
   * Machine à états d'une confirmation prestataire RÉELLE (webhook signé du
   * futur adaptateur — jamais appelée par l'API admin aujourd'hui). CAS
   * PENDING → SUCCEEDED : un rejeu/confirmation double = 409, aucun effet.
   * Utilisée UNIQUEMENT en simulation dans les specs unitaires (preuve de
   * simulation, clairement distincte d'une validation prestataire réelle).
   */
  async applyExternalConfirmation(
    tx: Prisma.TransactionClient,
    refundId: string,
    providerRef: string,
  ): Promise<void> {
    const res = await tx.refund.updateMany({
      where: { id: refundId, status: RefundStatus.PENDING },
      data: {
        status: RefundStatus.SUCCEEDED,
        providerRef,
        processedAt: new Date(),
      },
    });
    if (res.count === 0) {
      throw new ConflictException(
        'Confirmation prestataire déjà appliquée ou remboursement non en attente.',
      );
    }
  }

  private toView(
    r: {
      id: string;
      orderId: string | null;
      cardPaymentId?: string | null;
      invoiceId: string | null;
      kind: RefundKind;
      status: RefundStatus;
      amountCents: number;
      currency: string;
      reason: string | null;
      issueCreditNote: boolean;
      idempotencyKey: string;
      walletTransactionId: string | null;
      creditNoteInvoiceId: string | null;
      providerRef: string | null;
      createdByEmail: string | null;
      processedAt: Date | null;
      createdAt: Date;
    },
    replayed: boolean,
  ): RefundView {
    return { ...r, cardPaymentId: r.cardPaymentId ?? null, replayed };
  }
}
