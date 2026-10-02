import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  CustomerListQueryDto,
  InvoiceListQueryDto,
} from './dto/store-lists.dto';

/**
 * Socle commercial (GO P4 / lot B1 - visibilité) — listes admin paginées des
 * factures et des clients. Lecture strictement ADMIN (RolesGuard) : côté
 * client, les mêmes données passent par `ClientStoreController` filtré par
 * propriétaire. Le chemin PDF disque n'est jamais exposé brut (`hasPdf`).
 */
@ApiTags('store/admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin')
export class AdminBillingController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liste globale des factures (paginée, filtre statut + recherche numéro/email). */
  @Get('invoices')
  @ApiOperation({ summary: 'Liste des factures (ADMIN, paginée)' })
  async listInvoices(@Query() query: InvoiceListQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where: Prisma.InvoiceWhereInput = {};
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { number: { contains: q, mode: 'insensitive' } },
        { customer: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
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
          customer: { select: { id: true, email: true, name: true, userId: true } },
          order: { select: { id: true, productName: true, status: true } },
        },
      }),
    ]);

    const items = rows.map(({ pdfPath, ...rest }) => ({
      ...rest,
      hasPdf: pdfPath !== null,
    }));
    return { items, total, page, perPage };
  }

  /** Détail global d'une facture (ADMIN) : lignes + adresse de facturation. */
  @Get('invoices/:id')
  @ApiOperation({ summary: 'Détail d’une facture (ADMIN)' })
  async invoiceDetail(@Param('id') id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        amountHtCents: true,
        taxAmountCents: true,
        amountTtcCents: true,
        taxRatePercent: true,
        issuedAt: true,
        dueDate: true,
        paidAt: true,
        pdfPath: true,
        orderId: true,
        billingAddress: true,
        customer: { select: { id: true, email: true, name: true, userId: true } },
        order: { select: { id: true, productName: true, status: true } },
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
    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }
    const { pdfPath, ...rest } = invoice;
    return { ...rest, hasPdf: pdfPath !== null };
  }

  /** Liste globale des clients (paginée, recherche email/nom + compteurs). */
  @Get('customers')
  @ApiOperation({ summary: 'Liste des clients (ADMIN, paginée)' })
  async listCustomers(@Query() query: CustomerListQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where: Prisma.CustomerWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          accountType: true,
          userId: true,
          walletBalanceCents: true,
          createdAt: true,
          _count: { select: { orders: true, invoices: true } },
        },
      }),
    ]);
    return { items, total, page, perPage };
  }
}
