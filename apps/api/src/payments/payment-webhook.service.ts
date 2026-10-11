import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { CardPaymentStatus, Prisma, PaymentWebhookStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardPaymentsService } from './card-payments.service';
import { CardRefundsService } from './card-refunds.service';
import { PaymentProviderService, WebhookAuthContext } from './payment-provider.service';
import { verifyStripeSignature } from './stripe-signature';

interface ProviderEvent {
  id: string;
  type: string;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

/** GO P1 — identité de la SOURCE (fournisseur authentifié + compte vérifié). */
interface DispatchContext {
  providerCode: string;
  merchantAccount: string;
}

/** GO §2 — cible + identité d'ORIGINE conservée de la ligne (compte/environnement). */
interface TargetRow {
  id: string;
  providerCode?: string | null;
  merchantAccount?: string | null;
  environment?: string | null;
}

interface DispatchOutcome {
  status: 'processed' | 'ignored';
  note?: string;
  cardPaymentId?: string | null;
  reference?: string;
  /**
   * GO P3 — événement géré dont la CIBLE n'existe pas encore côté plateforme
   * (persiste des références en cours) : n'est JAMAIS classé « ignoré », il
   * reste `RECEIVED` avec une échéance `reconcileAt` reprise par le sweep.
   */
  needsReconcile?: boolean;
}

/** Retard de rapprochement (backoff simple, borné). */
const RECONCILE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RECONCILE_MAX_ATTEMPTS = 8;

export interface WebhookResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** `payment_intent` sous forme string ou objet. */
function pi(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Référence interne portée par `metadata.reference` (secours à `client_reference_id`). */
function metaReference(obj: Record<string, unknown>): string | null {
  const meta = obj.metadata as { reference?: unknown } | undefined;
  return meta && typeof meta.reference === 'string' && meta.reference
    ? meta.reference
    : null;
}

const REFUND_STATUSES = [
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
] as const;

/** GO P6 — statut prestataire porté par un événement `refund.*`. */
function refundStatusFor(
  event: ProviderEvent,
  obj: Record<string, unknown>,
): 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' {
  if (event.type === 'refund.failed') return 'failed';
  if (event.type === 'refund.canceled') return 'canceled';
  const raw = str(obj.status);
  if (raw && (REFUND_STATUSES as readonly string[]).includes(raw)) {
    return raw as (typeof REFUND_STATUSES)[number];
  }
  return 'pending';
}

/**
 * Types que `dispatch` sait TRAITER (et qui peuvent donc avoir un effet).
 * `false` = acquittement neutre `IGNORED` possible sans identité marchande ;
 * `true` = un traitement exige l'identité de la source (GO P1), sinon 503.
 */
function isHandledEventType(type: string): boolean {
  return (
    type === 'checkout.session.completed' ||
    type === 'checkout.session.async_payment_succeeded' ||
    type === 'checkout.session.async_payment_failed' ||
    type === 'checkout.session.expired' ||
    type === 'payment_intent.succeeded' ||
    type === 'payment_intent.payment_failed' ||
    type === 'payment_intent.canceled' ||
    type === 'charge.refunded' ||
    type === 'charge.dispute.created' ||
    type === 'charge.dispute.closed' ||
    type === 'refund.created' ||
    type === 'refund.updated' ||
    type === 'refund.failed' ||
    type === 'refund.canceled'
  );
}

/**
 * GO Stripe — réception WEBHOOK idempotente et durcie.
 *
 * Chaîne : signature HMAC vérifiée sur le corps BRUT → déduplication par
 * `@@unique([providerCode, eventId])` → machine à états CAS métier (crédit
 * unique) → acquittement. Événements gérés :
 *  - `checkout.session.completed` / `async_payment_succeeded` /
 *    `payment_intent.succeeded` → CONFIRMATION (seul chemin de crédit) ;
 *  - `checkout.session.expired` / `payment_intent.canceled` → annulation
 *    (aucun crédit) ;
 *  - `checkout.session.async_payment_failed` / `payment_intent.payment_failed`
 *    → échec (aucun crédit) ;
 *  - `charge.refunded` / `charge.dispute.*` → remboursement/litige constaté
 *    côté prestataire → drapeaux + audit, JAMAIS de modification silencieuse du
 *    solde ;
 *  - tout autre type → IGNORÉ (200, sans effet).
 * Erreur de traitement → 500 pour rejeu prestataire (jamais de crédit à
 * moitié appliqué : tout se joue dans une transaction).
 */
@Injectable()
export class PaymentWebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentWebhookService.name);
  /** GO P3 + §4 — sweep durable des événements non rattachés (ON par défaut). */
  private timer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProviderService,
    private readonly cards: CardPaymentsService,
    private readonly refunds: CardRefundsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    const interval = this.provider.reconcileIntervalMs();
    if (interval <= 0) {
      // Désactivation EXPLICITE (`PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS=0`) :
      // les échéances restent persistées et reprises à chaque envoi webhooks.
      this.logger.log(
        'Sweep des webhooks non rattachés DÉSACTIVÉ (PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS=0)',
      );
      return;
    }
    // §4 — sweep INITIAL au démarrage : les échéances persistées avant le
    // redémarrage sont reprises sans attendre le premier envoi entrant.
    this.bootTimer = setTimeout(() => {
      void this.reconcileDue().catch((err: unknown) => {
        this.logger.error(`Sweep initial indisponible : ${String(err)}`);
      });
    }, 15_000);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => {
      void this.reconcileDue().catch((err: unknown) => {
        this.logger.error(`Sweep webhook indisponible : ${String(err)}`);
      });
    }, interval);
    this.timer.unref?.();
    this.logger.log(
      `Sweep des webhooks non rattachés toutes les ${interval} ms (+ sweep initial à 15 s)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }

  async handleSignedPayload(opts: {
    providerCode: string;
    rawBody: string | Buffer;
    header: string | undefined;
  }): Promise<WebhookResult> {
    // GO V3 §3 — UNE SEULE lecture de configuration : le secret (signature)
    // ET l'identité source (compte + ligne + version) proviennent du même
    // snapshot — jamais deux lectures interverties par une rotation.
    let auth: WebhookAuthContext;
    try {
      auth = await this.provider.webhookAuthContext(opts.providerCode);
    } catch (err) {
      // Non configuré (ou simulateur désactivé / production — GO P1) :
      // refus net AVANT toute écriture, 503 = rejeu prestataire après config.
      this.logger.warn(`Webhook refusé (${opts.providerCode}) : ${err instanceof Error ? err.message : String(err)}`);
      return {
        httpStatus: 503,
        body: { received: false, reason: 'webhook_secret_not_configured' },
      };
    }

    const check = verifyStripeSignature({
      rawBody: opts.rawBody,
      header: opts.header,
      secret: auth.secret,
    });
    if (!check.ok) {
      throw new UnauthorizedException(
        `Signature webhook invalide (${check.reason ?? 'inconnue'}).`,
      );
    }

    let event: ProviderEvent;
    try {
      event = JSON.parse(
        Buffer.isBuffer(opts.rawBody) ? opts.rawBody.toString('utf8') : opts.rawBody,
      ) as ProviderEvent;
    } catch {
      throw new BadRequestException('Corps webhook JSON illisible.');
    }
    if (!event?.id || !event?.type) {
      throw new BadRequestException('Événement webhook incomplet (id/type).');
    }

    // GO V5 §2 — l'inscription de l'événement ET de son identité source est
    // ATOMIQUE (même `create`) : aucun événement n'est accepté (ni acquitté,
    // ni dispatché) sans sa preuve d'origine durable. Si la persistance
    // échoue, l'exception remonte → 500 = rejeu prestataire, zéro effet.
    const eventRow = await this.dedupe(opts.providerCode, event, auth.identity);
    if (eventRow.duplicate) {
      return {
        httpStatus: 200,
        body: { received: true, duplicate: true, eventId: event.id },
      };
    }

    // GO V6 §1 — identité retenue pour le DISPATCH : EXCLUSIVEMENT l'identité
    // DURABLE de la ligne (persistée à l'inscription atomique, ou complétée et
    // relue lors d'un rejeu authentifié). JAMAIS de repli vers la configuration
    // courante : une complétion non justifiée est refusée en amont (dedupe),
    // et un événement SANS identité dure est refusé ci-dessous (503/IGNORED).
    const identity = eventRow.sourceIdentity;

    // GO V3 §3 — la signature est vérifiée (secret du même snapshot) ; un type
    // traitable exige une identité source (courante OU d'origine persistée).
    if (!identity) {
      const message = auth.identityError ?? 'identité source indisponible';
      // Un type HORS PÉRIMÈTRE n'a aucun effet métier : il est acquitté en
      // IGNORED (aucune écriture) sans exiger d'identité marchande. Tout type
      // traitable, lui, reste non acquittable tant que la source n'a pas
      // d'identité (503 = rejeu prestataire après rétablissement, AUCUN effet).
      if (!isHandledEventType(event.type)) {
        await this.settle(eventRow.id, event, {
          status: 'ignored',
          note: `type non géré: ${event.type} (identité ${message})`,
        });
        return {
          httpStatus: 200,
          body: { received: true, eventId: event.id, result: 'ignored' },
        };
      }
      await this.prisma.paymentWebhookEvent
        .update({
          where: { id: eventRow.id },
          data: { status: PaymentWebhookStatus.FAILED, error: message.slice(0, 500) },
        })
        .catch(() => undefined);
      this.logger.warn(`Webhook ${event.type} refusé : ${message}`);
      return {
        httpStatus: 503,
        body: { received: false, retry: true, reason: 'provider_identity_unavailable' },
      };
    }

    try {
      const outcome = await this.dispatch(event, {
        providerCode: opts.providerCode,
        merchantAccount: identity.merchantAccount,
      });
      await this.settle(eventRow.id, event, outcome);
      if (outcome.note) {
        this.logger.log(`Webhook ${event.type} → ${outcome.note}`);
      }
      // GO P3 — rapprochement EAGER : un événement tombé sur une cible absente
      // est repris dès le prochain envoi (les références viennent d'être
      // persistées côté création).
      void this.reconcileDue(10).catch(() => undefined);
      return {
        httpStatus: 200,
        body: {
          received: true,
          eventId: event.id,
          result: outcome.status,
          ...(outcome.needsReconcile ? { reconcile: true } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.paymentWebhookEvent
        .update({
          where: { id: eventRow.id },
          data: {
            status: PaymentWebhookStatus.FAILED,
            error: message.slice(0, 500),
          },
        })
        .catch(() => undefined);
      this.logger.error(`Webhook ${event.type} en échec : ${message}`);
      // 500 → le prestataire rejoue ; le CAS métier garantit l'absence de
      // double crédit pendant les rejeux.
      return { httpStatus: 500, body: { received: true, retry: true } };
    }
  }

  /**
   * Écriture DURABLE du résultat (traité / à rapprocher / ignoré) + lien
   * événement ↔ paiement. Un événement géré non rattaché reste `RECEIVED` avec
   * une échéance : JAMAIS d'« ignoré » silencieux (GO P3).
   */
  private async settle(
    eventRowId: string,
    event: ProviderEvent,
    outcome: DispatchOutcome,
  ): Promise<void> {
    let cardPaymentId = outcome.cardPaymentId ?? null;
    if (!cardPaymentId && outcome.reference) {
      const pay = await this.prisma.cardPayment.findUnique({
        where: { reference: outcome.reference },
        select: { id: true },
      });
      cardPaymentId = pay?.id ?? null;
    }

    if (outcome.needsReconcile) {
      const row = await this.prisma.paymentWebhookEvent.findUnique({
        where: { id: eventRowId },
        select: { attempts: true },
      });
      const attempts = (row?.attempts ?? 0) + 1;
      if (attempts > RECONCILE_MAX_ATTEMPTS) {
        await this.prisma.paymentWebhookEvent.update({
          where: { id: eventRowId },
          data: {
            status: PaymentWebhookStatus.FAILED,
            attempts,
            reconcileAt: null,
            cardPaymentId,
            error: `rapprochement épuisé (${outcome.note ?? 'cible toujours absente'})`,
          },
        });
        return;
      }
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventRowId },
        data: {
          status: PaymentWebhookStatus.RECEIVED,
          attempts,
          cardPaymentId,
          reconcileAt: new Date(
            Date.now() + RECONCILE_BACKOFF_MS[Math.min(attempts - 1, RECONCILE_BACKOFF_MS.length - 1)],
          ),
          error: outcome.note ?? null,
        },
      });
      return;
    }

    await this.prisma.paymentWebhookEvent.update({
      where: { id: eventRowId },
      data: {
        status:
          outcome.status === 'ignored'
            ? PaymentWebhookStatus.IGNORED
            : PaymentWebhookStatus.PROCESSED,
        processedAt: new Date(),
        reconcileAt: null,
        cardPaymentId,
        error: outcome.note ?? null,
      },
    });
  }

  // ── rapprochement des événements non rattachés (GO P3) ──────────────────

  /**
   * Reprend les événements `RECEIVED` arrivés à échéance : la cible existe
   * peut-être désormais (persistance des références, rejeu prestataire).
   * Idempotent (le CAS métier absorbe les rejeux) et borné.
   *
   * GO revue §3a — un `RECEIVED` SANS échéance (crash entre l'inscription et
   * le classement) ne serait JAMAIS repris : la file le prend après une grâce
   * de 60 s (la première échéance ; un événement en cours de traitement n'est
   * pas un orphelin). JAMAIS de perte silencieuse. Les échecs épuisés
   * (FAILED) restent consultables au journal (`GET admin/webhook-events`).
   */
  async reconcileDue(limit = 20): Promise<{ replayed: number; attached: number }> {
    const now = new Date();
    const due = await this.prisma.paymentWebhookEvent.findMany({
      where: {
        status: PaymentWebhookStatus.RECEIVED,
        OR: [
          { reconcileAt: { lte: now } },
          {
            reconcileAt: null,
            receivedAt: { lte: new Date(now.getTime() - RECONCILE_BACKOFF_MS[0]) },
          },
        ],
      },
      orderBy: [{ reconcileAt: 'asc' }, { receivedAt: 'asc' }],
      take: limit,
    });
    let replayed = 0;
    let attached = 0;
    for (const row of due) {
      replayed += 1;
      try {
        const event = row.payload as unknown as ProviderEvent;
        if (!event?.id || !event?.type) throw new Error('payload illisible');
        // GO V3 §3 — le rejeu utilise l'identité SOURCE DURABLE capturée à la
        // réception (`merchantAccount` persisté), JAMAIS la configuration
        // courante : une rotation entre réception et rejeu n'attribue jamais
        // l'événement au mauvais compte. Un événement SANS identité persistée
        // (antérieur au lot V3) n'a pas de preuve d'origine : traitement
        // conservateur EXPLICITE et VISIBLE (FAILED + motif), jamais d'origine
        // inventée, jamais de perte silencieuse (consultable au journal
        // `GET admin/webhook-events`).
        if (!row.merchantAccount) {
          await this.prisma.paymentWebhookEvent
            .update({
              where: { id: row.id },
              data: {
                status: PaymentWebhookStatus.FAILED,
                reconcileAt: null,
                error:
                  'identité source absente (événement antérieur à la capture ' +
                  "d'identité durable) : réception non revérifiable, intervention requise",
              },
            })
            .catch(() => undefined);
          continue;
        }
        const outcome = await this.dispatch(event, {
          providerCode: row.providerCode,
          merchantAccount: row.merchantAccount,
        });
        await this.settle(row.id, event, outcome);
        if (!outcome.needsReconcile) attached += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.paymentWebhookEvent
          .update({
            where: { id: row.id },
            data: { status: PaymentWebhookStatus.FAILED, error: message.slice(0, 500) },
          })
          .catch(() => undefined);
      }
    }
    return { replayed, attached };
  }

  /** Inscription DURABLE + déduplication (P2002 = doublon). */
  /**
   * GO V5 §2 + V6 §1 — inscription ATOMIQUE : la ligne d'événement est créée
   * avec son identité source authentifiée (compte + ligne + version) dans LE
   * MÊME `create`. Aucune écriture d'identité en second temps sur un create
   * neuf. La déduplication est préservée : un doublon (P2002) retourne la
   * ligne d'ORIGINE avec son identité — jamais de réattribution.
   *
   * GO V6 §1 — rejeu d'une ligne déjà inscrite SANS identité : la complétion
   * est un CAS borné `merchantAccount: null` (jamais d'écrasement). AUCUNE
   * erreur de persistance ou de relecture n'est absorbée (exception → 500 =
   * rejeu prestataire, zéro effet). Le CAS est CONTRÔLÉ par une relecture de
   * l'identité EFFECTIVEMENT ENREGISTRÉE : le dispatch n'utilisera QUE cette
   * preuve (si un rejeu concurrent a gagné, c'est SON identité qui est relue).
   * Si la complétion ne peut pas être justifiée (relecture sans identité),
   * `sourceIdentity` est `null` → refus EXPLICITE en amont, événement
   * conservé pour intervention (FAILED + 503).
   */
  private async dedupe(
    providerCode: string,
    event: ProviderEvent,
    identity: {
      merchantAccount: string;
      settingId: string;
      configVersion: Date | null;
    } | null,
  ): Promise<{
    id: string;
    duplicate: boolean;
    sourceIdentity: {
      merchantAccount: string;
      settingId: string | null;
      configVersion: Date | null;
    } | null;
  }> {
    const sourceIdentityOf = (row: {
      merchantAccount: string | null;
      sourceSettingId: string | null;
      sourceConfigVersion: Date | null;
    }): {
      merchantAccount: string;
      settingId: string | null;
      configVersion: Date | null;
    } | null =>
      row.merchantAccount
        ? {
            merchantAccount: row.merchantAccount,
            settingId: row.sourceSettingId,
            configVersion: row.sourceConfigVersion,
          }
        : null;
    try {
      const row = await this.prisma.paymentWebhookEvent.create({
        data: {
          providerCode,
          eventId: event.id,
          type: event.type,
          livemode: typeof event.livemode === 'boolean' ? event.livemode : null,
          environment: event.livemode === true ? 'live' : 'test',
          status: PaymentWebhookStatus.RECEIVED,
          payload: (event as unknown as Prisma.InputJsonValue) ?? undefined,
          // Identité source AUTHENTIFIÉE persistée dans le même create.
          ...(identity
            ? {
                merchantAccount: identity.merchantAccount,
                sourceSettingId: identity.settingId,
                sourceConfigVersion: identity.configVersion,
              }
            : {}),
        },
      });
      return { id: row.id, duplicate: false, sourceIdentity: sourceIdentityOf(row) };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentWebhookEvent.findUnique({
          where: {
            providerCode_eventId: { providerCode, eventId: event.id },
          },
        });
        if (existing) {
          if (
            existing.status === PaymentWebhookStatus.RECEIVED ||
            existing.status === PaymentWebhookStatus.FAILED
          ) {
            // Rejeu d'un événement déjà inscrit : si la ligne est SANS
            // identité (événement antérieur au GO V3 ou échec sous config
            // non vérifiée), on complète l'identité du rejeu authentifié —
            // CAS sur `merchantAccount: null` : JAMAIS d'écrasement d'une
            // identité d'origine déjà persistée (aucune réattribution).
            let durable: {
              merchantAccount: string;
              settingId: string | null;
              configVersion: Date | null;
            } | null = sourceIdentityOf(existing);
            if (identity && !existing.merchantAccount) {
              // GO V6 §1 — complétion de l'identité : CAS + relecture SANS
              // absorption d'erreur. Le CAS est borné `merchantAccount: null`
              // : JAMAIS d'écrasement (aucune réattribution). Une exception
              // ici remonte (500 = rejeu prestataire), jamais de poursuite
              // sans preuve durable.
              await this.prisma.paymentWebhookEvent.updateMany({
                where: { id: existing.id, merchantAccount: null },
                data: {
                  merchantAccount: identity.merchantAccount,
                  sourceSettingId: identity.settingId,
                  sourceConfigVersion: identity.configVersion,
                },
              });
              // Relecture de l'identité ENREGISTRÉE (pas de repli sur
              // `existing`) : le dispatch n'utilisera QUE cette preuve — si
              // un rejeu concurrent a gagné le CAS, c'est SON identité qui
              // est relue (jamais la nôtre si elle n'a pas été persistée).
              const refreshed = await this.prisma.paymentWebhookEvent.findUnique({
                where: { id: existing.id },
              });
              durable = refreshed ? sourceIdentityOf(refreshed) : null;
            }
            await this.prisma.paymentWebhookEvent.updateMany({
              where: {
                id: existing.id,
                status: { in: [PaymentWebhookStatus.RECEIVED, PaymentWebhookStatus.FAILED] },
              },
              data: { attempts: { increment: 1 } },
            });
            return {
              id: existing.id,
              duplicate: false,
              // null = complétion non justifiée (relecture sans identité) :
              // handleSignedPayload refuse explicitement (FAILED + 503),
              // l'événement est conservé pour intervention.
              sourceIdentity: durable,
            };
          }
          return { id: existing.id, duplicate: true, sourceIdentity: sourceIdentityOf(existing) };
        }
      }
      throw err;
    }
  }

  /**
   * Cible de l'événement, LIMITÉE au fournisseur authentifié (GO P1), avec
   * l'identité d'ORIGINE conservée de la ligne (§2).
   * `null` = la ligne n'existe pas encore pour CE fournisseur → l'événement
   * géré n'est pas « ignoré » : il part en rapprochement (GO P3).
   */
  private async targetOf(
    ctx: DispatchContext,
    sessionRef: string | null,
    paymentRef: string | null,
  ): Promise<TargetRow | null> {
    if (!sessionRef && !paymentRef) return null;
    const or: Prisma.CardPaymentWhereInput[] = [];
    if (sessionRef) or.push({ providerSessionRef: sessionRef });
    if (paymentRef) or.push({ providerPaymentRef: paymentRef });
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerCode: ctx.providerCode, OR: or },
      select: {
        id: true,
        providerCode: true,
        merchantAccount: true,
        environment: true,
      },
    });
    return row ?? null;
  }

  /**
   * GO §2 — identité d'ORIGINE conservée contre l'identité courante de la
   * source : fournisseur + compte marchand + environnement. Une rotation de
   * configuration rend l'événement NON applicable à la ligne d'origine (et
   * un événement LIVE reste refusé en mode test) → refus explicite, jamais
   * d'effet. `null` = origine compatible.
   */
  private originRefusal(
    ctx: DispatchContext,
    row: TargetRow,
    event: ProviderEvent,
    obj: Record<string, unknown>,
  ): string | null {
    if (row.providerCode != null && row.providerCode !== ctx.providerCode) {
      return `fournisseur d’origine (${row.providerCode}) ≠ source (${ctx.providerCode})`;
    }
    if (row.merchantAccount != null && row.merchantAccount !== ctx.merchantAccount) {
      return `compte marchand d’origine (${row.merchantAccount}) ≠ identité courante (${ctx.merchantAccount})`;
    }
    const livemode =
      typeof event.livemode === 'boolean'
        ? event.livemode
        : typeof obj.livemode === 'boolean'
          ? obj.livemode
          : null;
    if (livemode === true) return 'événement LIVE refusé (mode test uniquement)';
    if (row.environment != null && row.environment !== 'test') {
      return `environnement d’origine « ${row.environment} » refusé (mode test uniquement)`;
    }
    return null;
  }

  /** Événement authentifié mais NON applicable à l'origine conservée (§2). */
  private refusedOrigin(targetId: string, reason: string): DispatchOutcome {
    return {
      status: 'ignored',
      cardPaymentId: targetId,
      note: `origine refusée : ${reason}`,
    };
  }

  private reconcilable(note: string): DispatchOutcome {
    return { status: 'ignored', needsReconcile: true, note };
  }

  private async dispatch(
    event: ProviderEvent,
    ctx: DispatchContext,
  ): Promise<DispatchOutcome> {
    const obj = (event.data?.object ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case 'checkout.session.completed': {
        const paymentStatus = str(obj.payment_status);
        if (paymentStatus === 'paid') {
          return this.confirmAndNote(event, obj, ctx);
        }
        if (paymentStatus === 'unpaid') {
          const target = await this.targetOf(
            ctx,
            str(obj.id),
            pi(obj.payment_intent),
          );
          if (!target) return this.reconcilable('cible absente (session non persistée)');
          const refusal = this.originRefusal(ctx, target, event, obj);
          if (refusal) return this.refusedOrigin(target.id, refusal);
          await this.cards.markProcessing(
            str(obj.id),
            pi(obj.payment_intent),
            ctx.providerCode,
          );
          return {
            status: 'processed',
            cardPaymentId: target.id,
            note: 'en attente de paiement asynchrone',
          };
        }
        return { status: 'ignored', note: `payment_status=${paymentStatus ?? 'inconnu'}` };
      }

      case 'checkout.session.async_payment_succeeded':
        return this.confirmAndNote(event, obj, ctx);

      case 'checkout.session.async_payment_failed': {
        const target = await this.targetOf(ctx, str(obj.id), null);
        if (!target) return this.reconcilable('cible absente (session non persistée)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        const id = await this.cards.markFailed({
          sessionRef: str(obj.id),
          providerCode: ctx.providerCode,
          status: CardPaymentStatus.FAILED,
          code: 'async_payment_failed',
          message: 'Paiement asynchrone échoué (côté prestataire).',
        });
        return { status: 'processed', cardPaymentId: id ?? target.id, note: 'échec asynchrone' };
      }

      case 'checkout.session.expired': {
        const target = await this.targetOf(ctx, str(obj.id) ?? '', null);
        if (!target) return this.reconcilable('cible absente (session non persistée)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        const changed = await this.cards.markExpired(
          str(obj.id) ?? '',
          ctx.providerCode,
        );
        return {
          status: 'processed',
          cardPaymentId: target.id,
          note: changed ? 'session expirée (aucun crédit)' : 'expiration sans effet',
        };
      }

      case 'payment_intent.succeeded': {
        const res = await this.cards.confirmPaid({
          paymentRef: str(obj.id),
          amountTotalCents: num(obj.amount),
          currency: str(obj.currency),
          livemode: typeof obj.livemode === 'boolean' ? obj.livemode : null,
          source: 'webhook',
          eventId: event.id,
          providerCode: ctx.providerCode,
          merchantAccount: ctx.merchantAccount,
          reference: metaReference(obj),
        });
        return this.noteFor(res);
      }

      case 'payment_intent.payment_failed': {
        const err = obj.last_payment_error as { message?: unknown } | undefined;
        const message =
          str(err?.message) ?? 'Paiement refusé (côté prestataire).';
        const paymentRef = str(obj.id);
        if (!paymentRef) return { status: 'ignored', note: 'payment_intent sans identifiant' };
        const target = await this.targetOf(ctx, null, paymentRef);
        if (!target) return this.reconcilable('cible absente (payment_intent non persisté)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        // GO P7 — le statut de l'intent départage : un échec n'est JAMAIS
        // déclaré terminal quand l'intent est encore vivant (sinon un succès
        // ultérieur serait bloqué) ni quand il est annulé (→ CANCELED).
        const intentStatus = str(obj.status);
        if (intentStatus === 'canceled') {
          const id = await this.cards.markFailed({
            paymentRef,
            providerCode: ctx.providerCode,
            status: CardPaymentStatus.CANCELED,
            code: 'canceled',
            message: `${message} (intent annulé).`,
          });
          return { status: 'processed', cardPaymentId: id ?? target.id, note: 'annulé après échec' };
        }
        if (intentStatus != null) {
          // Intent encore réutilisable : on NOTE l'erreur SANS verrouiller
          // l'état (aucun crédit, aucun blocage d'un futur succès).
          const id = await this.cards.markFailureNotice({
            paymentRef,
            providerCode: ctx.providerCode,
            code: 'payment_failed',
            message,
          });
          return { status: 'processed', cardPaymentId: id ?? target.id, note: 'échec transitoire noté' };
        }
        // Aucun statut (simulateur local) → échec tranché, aucun crédit.
        const id = await this.cards.markFailed({
          paymentRef,
          providerCode: ctx.providerCode,
          status: CardPaymentStatus.FAILED,
          code: 'payment_failed',
          message,
        });
        return { status: 'processed', cardPaymentId: id ?? target.id, note: 'paiement refusé' };
      }

      case 'payment_intent.canceled': {
        const paymentRef = str(obj.id);
        if (!paymentRef) return { status: 'ignored', note: 'payment_intent sans identifiant' };
        const target = await this.targetOf(ctx, null, paymentRef);
        if (!target) return this.reconcilable('cible absente (payment_intent non persisté)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        const id = await this.cards.markFailed({
          paymentRef,
          providerCode: ctx.providerCode,
          status: CardPaymentStatus.CANCELED,
          code: 'canceled',
          message: 'Paiement annulé.',
        });
        return { status: 'processed', cardPaymentId: id ?? target.id, note: 'annulé' };
      }

      case 'charge.refunded': {
        const paymentRef = pi(obj.payment_intent);
        const refundsList = (
          obj.refunds as { data?: { id?: unknown }[] } | undefined
        )?.data;
        const chargeRefundIds = Array.isArray(refundsList)
          ? (refundsList.map((r) => str(r?.id)).filter((v): v is string => !!v))
          : [];
        if (!paymentRef) return { status: 'ignored', note: 'charge sans payment_intent' };
        const target = await this.targetOf(ctx, null, paymentRef);
        if (!target) return this.reconcilable('cible absente (charge non rattachable)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        const id = await this.cards.applyChargeRefunded({
          paymentRef,
          amountRefundedCents: num(obj.amount_refunded) ?? 0,
          chargeRefundIds,
          providerCode: ctx.providerCode,
        });
        if (!id) return this.reconcilable('paiement introuvable au traitement');
        await this.audit
          .record({
            actorId: null,
            actorEmail: null,
            action: 'payment.provider_refund_observed',
            resourceType: 'cardPayment',
            resourceId: id,
            details: {
              eventId: event.id,
              amountRefundedCents: num(obj.amount_refunded),
              handling: 'intervention_admin_requise_si_hors_plateforme',
            },
          })
          .catch(() => undefined);
        return {
          status: 'processed',
          cardPaymentId: id,
          note: 'remboursement prestataire constaté',
        };
      }

      // GO P6 — événements REMBOURSEMENT : idempotents par `providerRef`.
      // Un remboursement CONNU est simplement acquitté (le statut vivant est
      // tenu par le service de remboursement, JAMAIS d'effet solde ici) ; un
      // remboursement INCONNU est constaté comme un remboursement hors
      // plateforme (intervention + audit, aucun crédit annulé automatiquement).
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
      case 'refund.canceled': {
        const providerRef = str(obj.id);
        if (!providerRef) return { status: 'ignored', note: 'remboursement sans référence' };
        const known = await this.prisma.refund.findFirst({
          where: { providerRef },
          select: {
            id: true,
            cardPaymentId: true,
            cardPayment: {
              select: {
                id: true,
                providerCode: true,
                merchantAccount: true,
                environment: true,
              },
            },
          },
        });
        if (known) {
          // GO §2 — même exigence que la cible directe : l'identité d'origine
          // conservée du paiement lie l'événement à la configuration qui a
          // créé le remboursement.
          const origin = known.cardPayment ?? null;
          if (origin) {
            const knownRefusal = this.originRefusal(ctx, origin, event, obj);
            if (knownRefusal) return this.refusedOrigin(origin.id, knownRefusal);
          }
          // Remboursement INTERNE : issue répercutée idempotemment (CAS par
          // `providerRef`) — JAMAIS d'effet solde hors ce chemin (GO P6).
          const applied = await this.refunds.applyProviderRefundStatus({
            providerRef,
            status: refundStatusFor(event, obj),
            providerCode: ctx.providerCode,
          });
          if (!applied) {
            return this.reconcilable('remboursement interne non rattachable (fournisseur/cible)');
          }
          if (applied.changed) {
            await this.audit
              .record({
                actorId: null,
                actorEmail: null,
                action: `payment.refund_provider_${applied.status.toLowerCase()}`,
                resourceType: 'refund',
                resourceId: applied.refundId,
                details: {
                  eventId: event.id,
                  providerRef,
                  cardPaymentId: applied.cardPaymentId,
                  handling: 'cas_idempotent_providerRef',
                },
              })
              .catch(() => undefined);
          }
          return {
            status: 'processed',
            cardPaymentId: applied.cardPaymentId,
            note: `remboursement interne ${providerRef} → ${applied.status}${applied.changed ? '' : ' (déjà constaté)'}`,
          };
        }
        const paymentRef = pi(obj.payment_intent);
        if (!paymentRef) return { status: 'ignored', note: 'remboursement sans payment_intent' };
        const target = await this.targetOf(ctx, null, paymentRef);
        if (!target) return this.reconcilable('cible absente (remboursement non rattachable)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        // GO §2 — un remboursement INCONNU non soldé n'entre JAMAIS dans le
        // compteur : seul un statut `succeeded` constitue une preuve
        // d'encaissement (pending/failed/canceled = zéro effet comptable).
        const unknownStatus = refundStatusFor(event, obj);
        if (unknownStatus !== 'succeeded') {
          await this.audit
            .record({
              actorId: null,
              actorEmail: null,
              action: 'payment.provider_refund_observed',
              resourceType: 'cardPayment',
              resourceId: target.id,
              details: {
                eventId: event.id,
                providerRef,
                refundStatus: unknownStatus,
                handling: 'non_comptabilise_non_solde',
              },
            })
            .catch(() => undefined);
          return {
            status: 'processed',
            cardPaymentId: target.id,
            note: `remboursement externe ${providerRef} « ${unknownStatus} » non comptabilisé (aucun encaissement)`,
          };
        }
        // GO revue §1 — l'identité du remboursement est OBSERVÉE (union des
        // identités), jamais comptabilisée comme un plancher cumulé : seul
        // `charge.amount_refunded` est cumulatif. Un montant absent laisse
        // l'incertitude explicite (rapprochement bloquant).
        const id = await this.cards.recordRefundObservation({
          paymentRef,
          providerRef,
          amountCents: num(obj.amount) ?? null,
          providerStatus: unknownStatus,
          providerCode: ctx.providerCode,
        });
        if (!id) return this.reconcilable('paiement introuvable au traitement');
        await this.audit
          .record({
            actorId: null,
            actorEmail: null,
            action: 'payment.provider_refund_observed',
            resourceType: 'cardPayment',
            resourceId: id,
            details: {
              eventId: event.id,
              providerRef,
              refundStatus: event.type.replace('refund.', ''),
              amountCents: num(obj.amount) ?? null,
              handling: 'observation_identite_union',
            },
          })
          .catch(() => undefined);
        return {
          status: 'processed',
          cardPaymentId: id,
          note: `remboursement externe ${providerRef} observé par identité (union)`,
        };
      }

      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const paymentRef = pi(obj.payment_intent);
        if (!paymentRef) return { status: 'ignored', note: 'litige sans payment_intent' };
        const target = await this.targetOf(ctx, null, paymentRef);
        if (!target) return this.reconcilable('cible absente (litige non rattachable)');
        const refusal = this.originRefusal(ctx, target, event, obj);
        if (refusal) return this.refusedOrigin(target.id, refusal);
        const id = await this.cards.applyDispute({
          paymentRef,
          disputeId: str(obj.id) ?? 'dispute_inconnu',
          reason: str(obj.reason),
          closed: event.type === 'charge.dispute.closed',
          providerCode: ctx.providerCode,
        });
        if (!id) return this.reconcilable('paiement introuvable au traitement');
        await this.audit
          .record({
            actorId: null,
            actorEmail: null,
            action:
              event.type === 'charge.dispute.created'
                ? 'payment.dispute.created'
                : 'payment.dispute.closed',
            resourceType: 'cardPayment',
            resourceId: id,
            details: {
              disputeId: str(obj.id),
              reason: str(obj.reason),
              eventId: event.id,
              handling: 'conservateur_solde_inchange',
            },
          })
          .catch(() => undefined);
        return {
          status: 'processed',
          cardPaymentId: id,
          note: 'litige signalé (intervention)',
        };
      }

      default:
        return { status: 'ignored', note: `type non géré: ${event.type}` };
    }
  }

  private async confirmAndNote(
    event: ProviderEvent,
    obj: Record<string, unknown>,
    ctx: DispatchContext,
  ): Promise<DispatchOutcome> {
    const res = await this.cards.confirmPaid({
      sessionRef: str(obj.id),
      paymentRef: pi(obj.payment_intent),
      amountTotalCents: num(obj.amount_total),
      currency: str(obj.currency),
      livemode: typeof obj.livemode === 'boolean' ? obj.livemode : null,
      source: 'webhook',
      eventId: event.id,
      providerCode: ctx.providerCode,
      merchantAccount: ctx.merchantAccount,
      reference: str(obj.client_reference_id) ?? metaReference(obj),
    });
    return this.noteFor(res);
  }

  private noteFor(res: Awaited<ReturnType<CardPaymentsService['confirmPaid']>>): DispatchOutcome {
    switch (res.outcome) {
      case 'credited':
        return {
          status: 'processed',
          note: `crédité ${res.reference} (${res.balanceCents})`,
          cardPaymentId: null,
          reference: res.reference,
        };
      case 'already':
        return {
          status: 'processed',
          note: `déjà crédité ${res.reference}`,
          reference: res.reference,
        };
      case 'needs_review':
        return {
          status: 'processed',
          note: `À REVOIR ${res.reference} : ${res.reason}`,
          reference: res.reference,
        };
      case 'ignored':
        return {
          status: 'ignored',
          note: `${res.reference} : ${res.reason}`,
          reference: res.reference,
        };
      case 'not_found':
        // GO P3 — cible inconnue au moment de la réception (références encore
        // en cours de persistance) : rapprochement durable, JAMAIS ignoré.
        return this.reconcilable('cible absente (confirmation non rattachable)');
      default:
        return { status: 'ignored', note: 'objet inconnu' };
    }
  }
}
