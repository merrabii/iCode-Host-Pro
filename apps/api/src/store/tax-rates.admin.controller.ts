import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateTaxRateDto, UpdateTaxRateDto } from './dto/tax-rate.dto';

/**
 * GO P5 (lot B2) — administration des taux de taxe (décision §6-6 : page
 * dédiée `/manager/taxe`, entrée de nav « Taux de taxe »). La table existait
 * sans aucun CRUD : les taux n'étaient modifiables qu'en base.
 *
 * Règles : nom unique (409), `ratePercent` 0..100 (Decimal(5,2)), UN SEUL
 * `isDefault` (basculé en transaction), suppression refusée (409) tant que des
 * produits référencent le taux. Lecture/écriture ADMIN strictes. Le taux
 * s'applique d'office au prochain devis/commande (les prix sont recalculés
 * serveur à chaque appel — re-fetch B2).
 */
@ApiTags('store/admin/tax-rates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/tax-rates')
export class TaxRatesAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des taux de taxe (ADMIN)' })
  async list() {
    return this.prisma.taxRate.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        ratePercent: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { products: true } },
      },
    });
  }

  @Post()
  @ApiOperation({ summary: 'Créer un taux de taxe (ADMIN)' })
  async create(@Body() dto: CreateTaxRateDto, @CurrentUser() actor: JwtPayload) {
    const name = dto.name.trim();
    await this.assertNameFree(name);
    const rate = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.taxRate.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.taxRate.create({
        data: {
          name,
          ratePercent: dto.ratePercent,
          isDefault: dto.isDefault ?? false,
        },
      });
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'taxrate.create',
      resourceType: 'taxrate',
      resourceId: rate.id,
      details: { name, ratePercent: dto.ratePercent, isDefault: dto.isDefault ?? false },
    });
    return this.view(rate.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifier un taux de taxe (ADMIN)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTaxRateDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const existing = await this.prisma.taxRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Taux introuvable.');
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      await this.assertNameFree(name, id);
    }
    const name = dto.name?.trim() ?? existing.name;
    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.taxRate.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      await tx.taxRate.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name } : {}),
          ...(dto.ratePercent !== undefined ? { ratePercent: dto.ratePercent } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        },
      });
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'taxrate.update',
      resourceType: 'taxrate',
      resourceId: id,
      details: {
        name,
        ratePercent: dto.ratePercent ?? Number(existing.ratePercent),
        isDefault: dto.isDefault ?? existing.isDefault,
      },
    });
    return this.view(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un taux de taxe (ADMIN, refusé si référencé)' })
  async remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    const existing = await this.prisma.taxRate.findUnique({
      where: { id },
      select: { id: true, name: true, isDefault: true },
    });
    if (!existing) throw new NotFoundException('Taux introuvable.');
    const linked = await this.prisma.product.count({ where: { taxRateId: id } });
    if (linked > 0) {
      throw new ConflictException(
        `Ce taux est référencé par ${linked} produit(s) : retirez-le des produits avant de le supprimer.`,
      );
    }
    await this.prisma.taxRate.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'taxrate.delete',
      resourceType: 'taxrate',
      resourceId: id,
      details: { name: existing.name, isDefault: existing.isDefault },
    });
    return { deleted: true, id };
  }

  /** Vue de retour unique (select explicite, + compteur produits). */
  private async view(id: string) {
    const rate = await this.prisma.taxRate.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        ratePercent: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { products: true } },
      },
    });
    if (!rate) throw new NotFoundException('Taux introuvable.');
    return rate;
  }

  /** Nom unique (@unique en base) — 409 explicite avant la course. */
  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const found = await this.prisma.taxRate.findFirst({
      where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (found) {
      throw new ConflictException(`Un taux nommé « ${name} » existe déjà.`);
    }
  }
}
