import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CardPaymentStatus, Prisma, PaymentWebhookStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardPaymentsService } from './card-payments.service';
import { PaymentProviderService } from './payment-provider.service';
import { verifyStripeSignature } from './stripe-signature';

interface ProviderEvent {
  id: string;
  type: string;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

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
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProviderService,
    private readonly cards: CardPaymentsService,
    private readonly audit: AuditService,
  ) {}

  async handleSignedPayload(opts: {
    providerCode: string;
    rawBody: string | Buffer;
    header: string | undefined;
  }): Promise<WebhookResult> {
    let secret: string;
    try {
      secret = await this.provider.webhookSecretFor(opts.providerCode);
    } catch (err) {
      // Non configuré : refus net (503 = rejeu prestataire après config).
      this.logger.warn(`Webhook sans secret configuré (${opts.providerCode})`);
      return {
        httpStatus: 503,
        body: { received: false, reason: 'webhook_secret_not_configured' },
      };
    }

    const check = verifyStripeSignature({
      rawBody: opts.rawBody,
      header: opts.header,
      secret,
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

    const eventRow = await this.dedupe(opts.providerCode, event);
    if (eventRow.duplicate) {
      return {
        httpStatus: 200,
        body: { received: true, duplicate: true, eventId: event.id },
      };
    }

    try {
      const outcome = await this.dispatch(event);
      // Lien événement ↔ paiement quand le chemin métier expose la référence
      // (recherche admin « quel événement a touché ce paiement » — GO §7).
      let cardPaymentId = outcome.cardPaymentId ?? null;
      if (!cardPaymentId && outcome.reference) {
        const pay = await this.prisma.cardPayment.findUnique({
          where: { reference: outcome.reference },
          select: { id: true },
        });
        cardPaymentId = pay?.id ?? null;
      }
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventRow.id },
        data: {
          status:
            outcome.status === 'ignored'
              ? PaymentWebhookStatus.IGNORED
              : PaymentWebhookStatus.PROCESSED,
          processedAt: new Date(),
          cardPaymentId,
          error: outcome.note ?? null,
        },
      });
      if (outcome.note) {
        this.logger.log(`Webhook ${event.type} → ${outcome.note}`);
      }
      return {
        httpStatus: 200,
        body: { received: true, eventId: event.id, result: outcome.status },
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

  /** Inscription DURABLE + déduplication (P2002 = doublon). */
  private async dedupe(
    providerCode: string,
    event: ProviderEvent,
  ): Promise<{ id: string; duplicate: boolean }> {
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
        },
      });
      return { id: row.id, duplicate: false };
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
            await this.prisma.paymentWebhookEvent.updateMany({
              where: {
                id: existing.id,
                status: { in: [PaymentWebhookStatus.RECEIVED, PaymentWebhookStatus.FAILED] },
              },
              data: { attempts: { increment: 1 } },
            });
            return { id: existing.id, duplicate: false };
          }
          return { id: existing.id, duplicate: true };
        }
      }
      throw err;
    }
  }

  private async dispatch(
    event: ProviderEvent,
  ): Promise<{
    status: 'processed' | 'ignored';
    note?: string;
    cardPaymentId?: string | null;
    reference?: string;
  }> {
    const obj = (event.data?.object ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case 'checkout.session.completed': {
        const paymentStatus = str(obj.payment_status);
        if (paymentStatus === 'paid') {
          return this.confirmAndNote(event, obj);
        }
        if (paymentStatus === 'unpaid') {
          await this.cards.markProcessing(str(obj.id), pi(obj.payment_intent));
          return { status: 'processed', note: 'en attente de paiement asynchrone' };
        }
        return { status: 'ignored', note: `payment_status=${paymentStatus ?? 'inconnu'}` };
      }

      case 'checkout.session.async_payment_succeeded':
        return this.confirmAndNote(event, obj);

      case 'checkout.session.async_payment_failed': {
        const id = await this.cards.markFailed({
          sessionRef: str(obj.id),
          status: CardPaymentStatus.FAILED,
          code: 'async_payment_failed',
          message: 'Paiement asynchrone échoué (côté prestataire).',
        });
        return { status: 'processed', cardPaymentId: id, note: 'échec asynchrone' };
      }

      case 'checkout.session.expired': {
        const changed = await this.cards.markExpired(str(obj.id) ?? '');
        return {
          status: 'processed',
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
        });
        return this.noteFor(res);
      }

      case 'payment_intent.payment_failed': {
        const err = obj.last_payment_error as { message?: unknown } | undefined;
        const id = await this.cards.markFailed({
          paymentRef: str(obj.id),
          status: CardPaymentStatus.FAILED,
          code: 'payment_failed',
          message: str(err?.message) ?? 'Paiement refusé (côté prestataire).',
        });
        return { status: 'processed', cardPaymentId: id, note: 'paiement refusé' };
      }

      case 'payment_intent.canceled': {
        const id = await this.cards.markFailed({
          paymentRef: str(obj.id),
          status: CardPaymentStatus.CANCELED,
          code: 'canceled',
          message: 'Paiement annulé.',
        });
        return { status: 'processed', cardPaymentId: id, note: 'annulé' };
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
        const id = await this.cards.applyChargeRefunded({
          paymentRef,
          amountRefundedCents: num(obj.amount_refunded) ?? 0,
          chargeRefundIds,
        });
        if (id) {
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
        }
        return {
          status: id ? 'processed' : 'ignored',
          cardPaymentId: id,
          note: id ? 'remboursement prestataire constaté' : 'paiement inconnu',
        };
      }

      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const paymentRef = pi(obj.payment_intent);
        if (!paymentRef) return { status: 'ignored', note: 'litige sans payment_intent' };
        const id = await this.cards.applyDispute({
          paymentRef,
          disputeId: str(obj.id) ?? 'dispute_inconnu',
          reason: str(obj.reason),
          closed: event.type === 'charge.dispute.closed',
        });
        if (id) {
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
        }
        return {
          status: id ? 'processed' : 'ignored',
          cardPaymentId: id,
          note: id ? 'litige signalé (intervention)' : 'litige non rattachable',
        };
      }

      default:
        return { status: 'ignored', note: `type non géré: ${event.type}` };
    }
  }

  private async confirmAndNote(
    event: ProviderEvent,
    obj: Record<string, unknown>,
  ): Promise<{
    status: 'processed' | 'ignored';
    note?: string;
    cardPaymentId?: string | null;
    reference?: string;
  }> {
    const res = await this.cards.confirmPaid({
      sessionRef: str(obj.id),
      paymentRef: pi(obj.payment_intent),
      amountTotalCents: num(obj.amount_total),
      currency: str(obj.currency),
      livemode: typeof obj.livemode === 'boolean' ? obj.livemode : null,
      source: 'webhook',
      eventId: event.id,
    });
    return this.noteFor(res);
  }

  private noteFor(res: Awaited<ReturnType<CardPaymentsService['confirmPaid']>>): {
    status: 'processed' | 'ignored';
    note?: string;
    cardPaymentId?: string | null;
    reference?: string;
  } {
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
      default:
        return { status: 'ignored', note: 'objet inconnu' };
    }
  }
}
