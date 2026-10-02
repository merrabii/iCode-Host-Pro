import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceListQueryDto, OrderListQueryDto } from './dto/store-lists.dto';

/**
 * Socle commercial (GO P4 / lot B1 - visibilité) — vues « mes commandes » et
 * « mes factures » de l'espace client.
 *
 * ISOLATION (critère d'acceptation du lot) : toutefiltre est appliqué côté
 * serveur sur le propriétaire du dossier client (`customer.userId` lié au
 * compte, avec repli sur l'email du JWT pour les clients invités créés avant
 * liaison) : un détail qui n'appartient pas au token courant répond 404 (jamais
 * 403 — pas de révélation d'existence). Aucune clé d' idempotence ni de trace
 * de paiement interne n'est exposée : select explicite.
 */
@ApiTags('client/store')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class ClientStoreController {
  constructor(private readonly prisma: PrismaService) {}

  /** Propriétaire du dossier : compte lié (userId) OU client au même email. */
  private ownedBy(user: JwtPayload): Prisma.CustomerWhereInput {
    return { OR: [{ userId: user.sub }, { email: user.email }] };
  }

  private clamp(query: { page?: number; perPage?: number }) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    return { page, perPage, skip: (page - 1) * perPage };
  }

  /** Commandes du client connecté, paginées, triées du plus récent au plus ancien. */
  @Get('orders')
  @ApiOperation({ summary: 'Mes commandes (client, paginé)' })
  async listMyOrders(
    @CurrentUser() user: JwtPayload,
    @Query() query: OrderListQueryDto,
  ) {
    const { page, perPage, skip } = this.clamp(query);
    const where: Prisma.OrderWhereInput = {
      customer: this.ownedBy(user),
    };
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) where.productName = { contains: q, mode: 'insensitive' };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
        select: ORDER_LIST_SELECT,
      }),
    ]);
    return { items, total, page, perPage };
  }

  /** Détail d'une commande — 404 si la commande n'appartient pas au compte. */
  @Get('orders/:id')
  @ApiOperation({ summary: 'Détail de ma commande' })
  async getMyOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: {
        ...ORDER_LIST_SELECT,
        domainType: true,
        domainValue: true,
        requestedSubdomain: true,
        optionsSnapshot: true,
        addonsSnapshot: true,
        renewsOrderId: true,
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
    if (!order) throw new NotFoundException('Commande introuvable.');
    return order;
  }

  /** Factures du client connecté, paginées, triées de la plus récente. */
  @Get('invoices')
  @ApiOperation({ summary: 'Mes factures (client, paginé)' })
  async listMyInvoices(
    @CurrentUser() user: JwtPayload,
    @Query() query: InvoiceListQueryDto,
  ) {
    const { page, perPage, skip } = this.clamp(query);
    const where: Prisma.InvoiceWhereInput = {
      customer: this.ownedBy(user),
    };
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) where.number = { contains: q, mode: 'insensitive' };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip,
        take: perPage,
        select: INVOICE_LIST_SELECT,
      }),
    ]);
    return { items: rows.map(withHasPdf), total, page, perPage };
  }

  /** Détail d'une facture — 404 si elle n'appartient pas au compte. */
  @Get('invoices/:id')
  @ApiOperation({ summary: 'Détail de ma facture' })
  async getMyInvoice(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: {
        ...INVOICE_LIST_SELECT,
        billingAddress: true,
        customer: { select: { name: true, email: true } },
        lines: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            kind: true,
            label: true,
            qty: true,
            unitPriceHtCents: true,
            taxRatePercent: true,
            taxAmountCents: true,
            totalTtcCents: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');
    const { pdfPath, ...rest } = invoice;
    return { ...rest, hasPdf: pdfPath !== null };
  }
}

/** Champs « liste commande » — select explicite, jamais de secret interne. */
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
  product: { select: { slug: true } },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.OrderSelect;

/** Champs « liste facture » — le chemin PDF disque n'est jamais exposé brut. */
const INVOICE_LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  currency: true,
  amountHtCents: true,
  taxAmountCents: true,
  amountTtcCents: true,
  issuedAt: true,
  dueDate: true,
  paidAt: true,
  pdfPath: true,
  orderId: true,
  order: { select: { id: true, productName: true, status: true } },
} satisfies Prisma.InvoiceSelect;

function withHasPdf<T extends { pdfPath: string | null }>({
  pdfPath,
  ...rest
}: T): Omit<T, 'pdfPath'> & { hasPdf: boolean } {
  return { ...rest, hasPdf: pdfPath !== null };
}
