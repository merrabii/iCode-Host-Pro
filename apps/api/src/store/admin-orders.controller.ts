import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CheckoutService } from './checkout.service';
import { OrderListQueryDto } from './dto/store-lists.dto';

class ConfirmPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * ADMIN — commandes : listes paginées globales (GO P4 / lot B1 - visibilité,
 * avec agrégats KPI par statut) + détail, puis confirmation de règlement
 * (virement/transfert rapproché manuellement). SEUL point, avec la règle
 * commande gratuite et le simulateur de recette, qui ouvre les droits d'une
 * commande `PENDING_PAYMENT` (cf. `CheckoutService.confirmOrderPaid`). Une
 * méthode active n'est jamais une preuve : c'est CET acte administrateur, tracé
 * (référence + acteur + audit), qui vaut confirmation. Idempotent : une double
 * validation ne crédite ni ne provisionne deux fois.
 *
 * Lecture réservée ADMIN (RolesGuard) — l'isolation par propriétaire, elle, vit
 * sur les vues client (`ClientStoreController`).
 */
@ApiTags('store/admin/orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Liste globale des commandes (paginée, filtre statut + recherche email/nom/produit). */
  @Get()
  @ApiOperation({ summary: 'Liste des commandes (ADMIN, paginée, agrégats KPI)' })
  async list(@Query() query: OrderListQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where = buildOrderWhere(query);

    const [total, items, byStatus] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          ...ORDER_LIST_SELECT,
          customer: { select: { id: true, email: true, name: true, userId: true } },
        },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _count: { _all: true },
        _sum: { amountTtcCents: true },
      }),
    ]);

    const summary = {
      totalTtcCents: byStatus.reduce((s, r) => s + (r._sum?.amountTtcCents ?? 0), 0),
      statuses: byStatus.map((r) => ({
        status: r.status,
        count: countAllOf(r._count),
        amountTtcCents: r._sum?.amountTtcCents ?? 0,
      })),
    };
    return { items, total, page, perPage, summary };
  }

  /** Détail global d'une commande (ADMIN) : historique, client, abonnement. */
  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une commande (ADMIN)' })
  async detail(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        ...ORDER_LIST_SELECT,
        customer: { select: { id: true, email: true, name: true, userId: true } },
        paymentMethod: { select: { id: true, name: true, type: true } },
        optionsSnapshot: true,
        addonsSnapshot: true,
        domainType: true,
        domainValue: true,
        requestedSubdomain: true,
        subscription: {
          select: { id: true, status: true, product: { select: { slug: true } } },
        },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            note: true,
            actorEmail: true,
            createdAt: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Commande introuvable.');
    }
    return order;
  }

  @Post(':id/confirm-payment')
  @ApiOperation({ summary: 'Confirmer le règlement d’une commande (ADMIN, virement rapproché)' })
  async confirmPayment(
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException('Commande introuvable.');
    }
    const result = await this.checkout.confirmOrderPaid(id, {
      source: 'admin-transfer',
      actorId: actor.sub,
      actorEmail: actor.email,
      reference: dto?.reference?.trim() || null,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'payment.admin_confirm',
      resourceType: 'order',
      resourceId: id,
      details: {
        previousStatus: order.status,
        alreadyConfirmed: result.alreadyConfirmed,
        reference: dto?.reference ?? undefined,
        note: dto?.note ?? undefined,
      },
    });
    return {
      orderId: result.orderId,
      status: result.status,
      alreadyConfirmed: result.alreadyConfirmed,
      subscriptionAction: result.subscriptionAction ?? null,
    };
  }
}

/** `groupBy._count` : forme `true` ou `{ _all, … }` selon l'inférence Prisma. */
function countAllOf(count: unknown): number {
  if (typeof count === 'number') return count;
  if (count && typeof count === 'object' && '_all' in count) {
    return (count as { _all?: number })._all ?? 0;
  }
  return 0;
}

/** Filtres communs liste/détail admin : statut exact + recherche insensible. */
function buildOrderWhere(query: OrderListQueryDto): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (query.status) where.status = query.status;
  const q = query.q?.trim();
  if (q) {
    where.OR = [
      { customerEmail: { contains: q, mode: 'insensitive' } },
      { customerName: { contains: q, mode: 'insensitive' } },
      { productName: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

/** Champs « liste commande » côté admin — aucun secret interne (clés de tête…). */
const ORDER_LIST_SELECT = {
  id: true,
  status: true,
  productName: true,
  billingCycle: true,
  currency: true,
  amountHtCents: true,
  taxAmountCents: true,
  amountTtcCents: true,
  createdAt: true,
  paidAt: true,
  nextBillingDate: true,
  autoRenew: true,
  customerName: true,
  customerEmail: true,
  paymentMethodName: true,
  idempotencyKey: true,
  product: { select: { slug: true } },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.OrderSelect;
