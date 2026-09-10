import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';

interface AdminActor {
  sub: string;
  email: string;
}

/**
 * ADMIN — gestion des moyens de paiement (Bloc C). Vue complète (isActive,
 * ordre, config d'affichage, frais) mais JAMAIS `configEnc` (secrets carte,
 * §7) : seul `hasConfigEnc` est exposé. Chaque mutation trace `payment.method.*`.
 */
@ApiTags('store/payment-methods (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/payment-methods')
export class BillingPaymentAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste les moyens de paiement (admin, sans secrets)' })
  async list() {
    const methods = await this.prisma.paymentMethod.findMany({
      orderBy: { displayOrder: 'asc' },
    });
    return methods.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      isActive: m.isActive,
      displayOrder: m.displayOrder,
      config: m.config,
      hasConfigEnc: !!m.configEnc,
      feeType: m.feeType,
      feePercent: m.feePercent?.toString() ?? null,
      feeFixedCents: m.feeFixedCents,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier un moyen de paiement (activer/désactiver, config, frais)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentMethodDto,
    @CurrentUser() actor: AdminActor,
  ) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Moyen de paiement introuvable.');

    const data: Record<string, unknown> = {};
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.config !== undefined) data.config = dto.config;
    if (dto.feeType !== undefined) data.feeType = dto.feeType;
    if (dto.feePercent !== undefined) data.feePercent = dto.feePercent;
    if (dto.feeFixedCents !== undefined) data.feeFixedCents = dto.feeFixedCents;

    const updated = await this.prisma.paymentMethod.update({ where: { id }, data });

    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'payment.method.update',
      resourceType: 'paymentMethod',
      resourceId: id,
      details: {
        name: updated.name,
        isActive: updated.isActive,
        displayOrder: updated.displayOrder,
        feeType: updated.feeType,
        hasConfigEnc: !!updated.configEnc,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      isActive: updated.isActive,
      displayOrder: updated.displayOrder,
      config: updated.config,
      hasConfigEnc: !!updated.configEnc,
      feeType: updated.feeType,
      feePercent: updated.feePercent?.toString() ?? null,
      feeFixedCents: updated.feeFixedCents,
    };
  }
}
