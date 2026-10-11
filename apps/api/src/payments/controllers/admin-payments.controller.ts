import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentWebhookStatus, Prisma, Role } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { JwtPayload } from '../../auth/types';
import { PrismaService } from '../../prisma/prisma.service';
import { CardPaymentsService } from '../card-payments.service';
import { CardRefundsService } from '../card-refunds.service';
import { PaymentProviderService } from '../payment-provider.service';
import {
  AdminCardPaymentQueryDto,
  CancelCardRefundDto,
  CreateCardRefundDto,
  ResolveInterventionDto,
  SaveProviderDto,
} from '../dto/payments.dto';

/**
 * GO Stripe §2/§6/§7 — administration : configuration connecteur (secrets
 * écrits-seuls, jamais relus), recherche de paiements (y compris par référence
 * prestataire), remboursements de recharge et signalements.
 *
 * Aucun secret n'est renvoyé : `hasSecretKey`/`hasWebhookSecret` seulement.
 */
@ApiTags('store/admin/payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly provider: PaymentProviderService,
    private readonly cards: CardPaymentsService,
    private readonly refunds: CardRefundsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── configuration prestataire ──────────────────────────────────────────

  @Get('provider')
  @ApiOperation({ summary: 'Configuration carte actuelle (secrets jamais renvoyés)' })
  async getProvider() {
    const [stripe, simulated] = await Promise.all([
      this.provider.getMaskedView('stripe'),
      this.provider.getMaskedView('simulated'),
    ]);
    return {
      stripe,
      simulated,
      resolved: null as string | null,
      endpointUrl: this.provider.webhookEndpointUrl(),
      note: 'Mode test uniquement : live refusé à l’écriture (GO Stripe).',
    };
  }

  @Put('provider')
  @ApiOperation({ summary: 'Enregistrer la configuration Stripe (mode test)' })
  async saveProvider(@Body() dto: SaveProviderDto, @CurrentUser() actor: JwtPayload) {
    const view = await this.provider.save(dto, { sub: actor.sub, email: actor.email });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'payment.provider.save',
      resourceType: 'paymentProviderSetting',
      resourceId: view.code,
      details: {
        isActive: view.isActive,
        environment: view.environment,
        merchantAccount: view.merchantAccount,
        hasSecretKey: view.hasSecretKey,
        hasWebhookSecret: view.hasWebhookSecret,
        allowedCurrencies: view.allowedCurrencies,
      },
    });
    return view;
  }

  @Post('provider/check')
  @ApiOperation({ summary: 'Vérifier la connexion prestataire (appel réel, mode test)' })
  async checkProvider(@CurrentUser() actor: JwtPayload) {
    const view = await this.provider.checkConnection({
      sub: actor.sub,
      email: actor.email,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'payment.provider.check',
      resourceType: 'paymentProviderSetting',
      resourceId: view.code,
      details: {
        ok: !view.lastCheckError,
        account: view.lastCheckAccount,
        error: view.lastCheckError,
      },
    });
    return view;
  }

  // ── recherche de paiements ─────────────────────────────────────────────

  @Get('card-payments')
  @ApiOperation({ summary: 'Paiements carte (admin : filtres + recherche)' })
  async list(@Query() query: AdminCardPaymentQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where: Prisma.CardPaymentWhereInput = {};
    if (query.status) where.status = query.status as never;
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { providerSessionRef: { contains: q, mode: 'insensitive' } },
        { providerPaymentRef: { contains: q, mode: 'insensitive' } },
        { customer: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.cardPayment.count({ where }),
      this.prisma.cardPayment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { customer: { select: { email: true } } },
      }),
    ]);
    return {
      items: items.map((row) => this.cards.toAdminView(row)),
      total,
      page,
      perPage,
    };
  }

  @Get('card-payments/:id')
  @ApiOperation({ summary: 'Détail paiement carte + remboursements + événements' })
  async detail(@Param('id') id: string) {
    const row = await this.prisma.cardPayment.findUnique({
      where: { id },
      include: { customer: { select: { email: true } } },
    });
    if (!row) throw new NotFoundException('Paiement introuvable.');
    const [refunds, events] = await Promise.all([
      this.refunds.listForPayment(row.id),
      this.prisma.paymentWebhookEvent.findMany({
        where: { cardPaymentId: row.id },
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          eventId: true,
          type: true,
          status: true,
          attempts: true,
          error: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
    ]);
    return { ...this.cards.toAdminView(row), refunds, events };
  }

  @Get('card-payments/:id/refunds')
  @ApiOperation({ summary: 'Remboursements d’un paiement carte' })
  async listRefunds(@Param('id') id: string) {
    return { items: await this.refunds.listForPayment(id) };
  }

  @Post('card-payments/:id/refunds')
  @ApiOperation({
    summary:
      'Rembourser une recharge vers la carte (plafond + idempotence + débit du crédit associé)',
  })
  async createRefund(
    @Param('id') id: string,
    @Body() dto: CreateCardRefundDto,
    @CurrentUser() actor: JwtPayload,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.refunds.createTopupRefund(
      {
        cardPaymentId: id,
        amountCents: dto.amountCents,
        reason: dto.reason ?? null,
        idempotencyKey,
      },
      actor,
    );
  }

  @Post('refunds/:id/retry')
  @ApiOperation({ summary: 'Reprendre l’appel prestataire d’un remboursement PENDING' })
  async retryRefund(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.refunds.retryProviderCall(id, actor);
  }

  @Post('refunds/:id/cancel')
  @ApiOperation({ summary: 'Annuler une intention de remboursement non conclue' })
  async cancelRefund(
    @Param('id') id: string,
    @Body() dto: CancelCardRefundDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.refunds.cancelRefund(id, actor, dto.reason);
  }

  @Post('card-payments/:id/intervention')
  @ApiOperation({ summary: 'Lever un signalement après vérification manuelle' })
  async resolveIntervention(
    @Param('id') id: string,
    @Body() dto: ResolveInterventionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.cards.resolveIntervention(id, dto.note, actor.email);
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'payment.intervention.resolved',
      resourceType: 'cardPayment',
      resourceId: id,
      details: { note: dto.note },
    });
    return { ok: true };
  }

  @Get('webhook-events')
  @ApiOperation({ summary: 'Événements webhook reçus (journal durable)' })
  async webhookEvents() {
    const [total, items] = await Promise.all([
      this.prisma.paymentWebhookEvent.count(),
      this.prisma.paymentWebhookEvent.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          providerCode: true,
          eventId: true,
          type: true,
          environment: true,
          status: true,
          attempts: true,
          error: true,
          receivedAt: true,
          processedAt: true,
          cardPaymentId: true,
        },
      }),
    ]);
    const failed = await this.prisma.paymentWebhookEvent.count({
      where: { status: PaymentWebhookStatus.FAILED },
    });
    return { items, total, failed };
  }
}
