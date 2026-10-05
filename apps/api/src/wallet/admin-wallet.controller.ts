import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role, WalletTransactionType } from '@prisma/client';
import type { Response } from 'express';
import * as fs from 'node:fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import {
  AdminRechargeQueryDto,
  RejectRechargeDto,
  ValidateRechargeDto,
} from './dto/wallet.dto';

const RECHARGE_SELECT = {
  id: true,
  type: true,
  amountCents: true,
  currency: true,
  status: true,
  reference: true,
  bankRef: true,
  methodName: true,
  proofFileName: true,
  note: true,
  adminActorId: true,
  adminActorEmail: true,
  createdAt: true,
  processedAt: true,
  customer: { select: { id: true, email: true, name: true, walletBalanceCents: true } },
} satisfies Prisma.WalletTransactionSelect;

/**
 * GO P6 (lot C3a) — validation admin des recharges par virement, SANS
 * prestataire : dépôt client (PENDING, 0 crédit) → `validate` crédite
 * EXACTEMENT une fois (CAS PENDING → SUCCEEDED sous verrou) ou `reject`
 * annule sans crédit (motif conservé sur la ligne, preuve sur disque).
 */
@ApiTags('store/admin/wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/wallet')
export class AdminWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('recharges')
  @ApiOperation({ summary: 'Recharges par virement (ADMIN, paginé + filtres)' })
  async listRecharges(@Query() query: AdminRechargeQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where: Prisma.WalletTransactionWhereInput = {
      type: WalletTransactionType.CREDIT,
      // Les débits/remboursements ne sont pas des recharges en attente.
      ...(query.status
        ? { status: query.status }
        : { status: { in: ['PENDING', 'SUCCEEDED', 'CANCELED'] } }),
    };
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { note: { contains: q, mode: 'insensitive' } },
        { customer: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: RECHARGE_SELECT,
      }),
    ]);
    return { items, total, page, perPage };
  }

  @Get('recharges/:id')
  @ApiOperation({ summary: 'Détail d’une recharge (ADMIN)' })
  async getRecharge(@Param('id') id: string) {
    const row = await this.prisma.walletTransaction.findUnique({
      where: { id },
      select: RECHARGE_SELECT,
    });
    if (!row || row.type !== WalletTransactionType.CREDIT) {
      throw new NotFoundException('Recharge introuvable.');
    }
    return row;
  }

  @Get('recharges/:id/proof')
  @ApiOperation({ summary: 'Justificatif d’une recharge (ADMIN, flux)' })
  async getProof(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const row = await this.prisma.walletTransaction.findUnique({
      where: { id },
      select: { type: true, proofPath: true, proofMime: true },
    });
    if (!row || row.type !== WalletTransactionType.CREDIT || !row.proofPath) {
      throw new NotFoundException('Justificatif introuvable.');
    }
    const abs = this.wallet.proofAbsolutePath(row.proofPath);
    if (!fs.existsSync(abs)) {
      throw new NotFoundException('Justificatif introuvable.');
    }
    res.set({
      'Content-Type': row.proofMime ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename="${row.proofPath}"`,
    });
    return new StreamableFile(fs.createReadStream(abs));
  }

  @Post('recharges/:id/validate')
  @ApiOperation({
    summary:
      'Valider une recharge → crédit unique (ADMIN, C3a/Q8 : référence de rapprochement bancaire requise)',
  })
  async validate(
    @Param('id') id: string,
    @Body() dto: ValidateRechargeDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const result = await this.wallet.validateRecharge(
      id,
      { sub: actor.sub, email: actor.email },
      dto.bankRef,
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'wallet.recharge.validate',
      resourceType: 'walletTransaction',
      resourceId: id,
      details: {
        balanceCents: result.balanceCents,
        // GO Q8 — rapprochement bancaire : encaissement constaté (référence,
        // montant, devise) + acteur déjà porté sur la ligne.
        bankRef: result.bankRef,
        amountCents: result.amountCents,
        currency: result.currency,
      },
    });
    return { ok: true, ...result };
  }

  @Post('recharges/:id/reject')
  @ApiOperation({ summary: 'Rejeter une recharge → 0 crédit (ADMIN, C3a)' })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectRechargeDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const reason = dto.reason?.trim() || null;
    await this.wallet.rejectRecharge(
      id,
      { sub: actor.sub, email: actor.email },
      reason,
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'wallet.recharge.reject',
      resourceType: 'walletTransaction',
      resourceId: id,
      details: { reason },
    });
    return { ok: true };
  }
}
