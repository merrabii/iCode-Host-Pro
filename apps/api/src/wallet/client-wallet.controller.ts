import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { CreateRechargeDto, WalletPageQueryDto } from './dto/wallet.dto';

const PROOF_MAX_BYTES = 5 * 1024 * 1024; // 5 Mo (image ou PDF)

/** Sélecteur « historique » côté client — jamais de chemin disque ni d'acteur interne. */
const TX_SELECT = {
  id: true,
  type: true,
  amountCents: true,
  status: true,
  reference: true,
  note: true,
  methodName: true,
  proofFileName: true,
  orderId: true,
  invoiceId: true,
  createdAt: true,
  processedAt: true,
} satisfies Prisma.WalletTransactionSelect;

/**
 * GO P6 (lot C2 + C3a) — vues « mon portefeuille » de l'espace client.
 *
 * ISOLATION : tout est filtré sur le dossier du JWT via
 * `WalletService.ensureOwnedCustomer` (dossier lié au compte, ou lié au
 * passage si invité avec le même email ; dossier d'un AUTRE compte = conflit).
 * Une recharge dépose un justificatif (image/PDF ≤ 5 Mo) et reste `PENDING`
 * sans effet solde jusqu'à la validation admin (C3a).
 */
@ApiTags('client/wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client/wallet')
export class ClientWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Solde de mon portefeuille (client)' })
  async getBalance(@CurrentUser() user: JwtPayload) {
    const customer = await this.wallet.ensureOwnedCustomer(user);
    return {
      customerEmail: customer.email,
      balanceCents: customer.walletBalanceCents,
      currency: 'USD',
    };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Historique de mes mouvements (client, paginé)' })
  async listTransactions(
    @CurrentUser() user: JwtPayload,
    @Query() query: WalletPageQueryDto,
  ) {
    const customer = await this.wallet.ensureOwnedCustomer(user);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    const where = { customerId: customer.id };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: TX_SELECT,
      }),
    ]);
    return { items, total, page, perPage };
  }

  @Post('recharges')
  @UseInterceptors(
    FileInterceptor('proof', {
      limits: { fileSize: PROOF_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok =
          /^(image\/png|image\/jpeg|image\/webp|application\/pdf)$/.test(
            file.mimetype,
          );
        cb(
          ok
            ? null
            : new BadRequestException(
                'Type de justificatif refusé (PNG, JPEG, WebP ou PDF).',
              ),
          ok,
        );
      },
    }),
  )
  @ApiOperation({
    summary:
      'Déposer une recharge par virement + justificatif (PENDING, sans crédit)',
  })
  async createRecharge(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateRechargeDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Justificatif requis (image ou PDF).');
    }
    const customer = await this.wallet.ensureOwnedCustomer(user);
    let proof: { fileName: string; path: string; mime: string } | null = null;
    try {
      proof = this.wallet.persistProof(file);
      const created = await this.wallet.createRecharge(customer.id, {
        amountCents: dto.amountCents,
        note: dto.note ?? null,
        proof,
      });
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'wallet.recharge.create',
        resourceType: 'walletTransaction',
        resourceId: created.id,
        details: {
          amountCents: created.amountCents,
          reference: created.reference,
        },
      });
      return created;
    } catch (err) {
      if (proof) this.wallet.removeProof(proof.path);
      throw err;
    }
  }
}
