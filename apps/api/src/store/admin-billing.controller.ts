import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BillingSetting, Prisma, Role } from '@prisma/client';
import type { Response } from 'express';
import * as fs from 'node:fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { RenewalService } from './renewal.service';
import { UpdateBillingSettingsDto } from './dto/billing-settings.dto';
import {
  CustomerListQueryDto,
  InvoiceListQueryDto,
} from './dto/store-lists.dto';

/**
 * Socle commercial (GO P4 / lot B1 - visibilité) — listes admin paginées des
 * factures et des clients. Lecture strictement ADMIN (RolesGuard) : côté
 * client, les mêmes données passent par `ClientStoreController` filtré par
 * propriétaire. Le chemin PDF disque n'est jamais exposé brut (`hasPdf`).
 * P7 (lot D1) : téléchargement du PDF + paramètres d'édition (mentions
 * légales figées à l'émission, échéance `invoiceDueDays`).
 */
@ApiTags('store/admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin')
export class AdminBillingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: InvoicePdfService,
    private readonly audit: AuditService,
    private readonly renewal: RenewalService,
  ) {}

  /** Singleton des paramètres de facturation (création sûre sous concurrence). */
  private async ensureSettings(): Promise<BillingSetting> {
    const existing = await this.prisma.billingSetting.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    try {
      return await this.prisma.billingSetting.create({
        data: { id: 'billing-settings', currency: 'USD', companyName: 'Code Diali' },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return await this.prisma.billingSetting.findFirstOrThrow({
          orderBy: { createdAt: 'asc' },
        });
      }
      throw e;
    }
  }

  private shape(row: BillingSetting) {
    const { legalMentions, ...rest } = row;
    return {
      ...rest,
      legalMentions: Array.isArray(legalMentions) ? (legalMentions as string[]) : null,
    };
  }

  /** Paramètres d'édition de facture (mentions, échéance, identité émetteur). */
  @Get('billing-settings')
  @ApiOperation({ summary: 'Paramètres de facturation (ADMIN)' })
  async getSettings() {
    return this.shape(await this.ensureSettings());
  }

  @Patch('billing-settings')
  @ApiOperation({ summary: 'Modifier les paramètres de facturation (ADMIN)' })
  async updateSettings(
    @Body() dto: UpdateBillingSettingsDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const current = await this.ensureSettings();
    const data: Prisma.BillingSettingUpdateInput = {};
    if (dto.companyName !== undefined) data.companyName = dto.companyName.trim();
    if (dto.companyAddress !== undefined)
      data.companyAddress = dto.companyAddress.trim() || null;
    if (dto.companyTaxId !== undefined)
      data.companyTaxId = dto.companyTaxId.trim() || null;
    if (dto.companyEmail !== undefined)
      data.companyEmail = dto.companyEmail.trim() || null;
    if (dto.legalMentions !== undefined) {
      const lines = dto.legalMentions.map((m) => m.trim()).filter(Boolean);
      data.legalMentions = lines.length
        ? (lines as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
    }
    if (dto.invoiceDueDays !== undefined) data.invoiceDueDays = dto.invoiceDueDays;

    const updated = await this.prisma.billingSetting.update({
      where: { id: current.id },
      data,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'billing.settings.update',
      resourceType: 'billingSetting',
      resourceId: updated.id,
      details: { fields: Object.keys(data) },
    });
    return this.shape(updated);
  }

  /** PDF d'une facture (ADMIN, flux) — rendu figé à l'émission. */
  @Get('invoices/:id/pdf')
  @ApiOperation({ summary: 'Télécharger le PDF d’une facture (ADMIN)' })
  async invoicePdf(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { id: true, number: true },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');
    const { absPath, fileName } = await this.pdf.ensurePdf(invoice.id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(fs.createReadStream(absPath));
  }

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

  /**
   * P8 (lot D2) — déclenche un passage du scheduler de renouvellement /
   * dunning / suspension (idempotent, anti-chevauchement local). En prod le
   * timer (`RENEWAL_SWEEP_ENABLED`, défaut actif) enchaîne ces passages ; cette
   * route permet l'horloge accélérée des recettes et la relance manuelle.
   */
  @Post('renewal/sweep')
  @ApiOperation({ summary: 'Déclenche un passage renouvellement/dunning (P8)' })
  async renewalSweep() {
    return this.renewal.sweep();
  }
}
