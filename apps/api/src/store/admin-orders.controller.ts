import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CheckoutService } from './checkout.service';

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
 * ADMIN — confirmation de règlement d'une commande (virement/transfert
 * rapproché manuellement). SEUL point, avec la règle commande gratuite et le
 * simulateur de recette, qui ouvre les droits d'une commande `PENDING_PAYMENT`
 * (cf. `CheckoutService.confirmOrderPaid`). Une méthode active n'est jamais une
 * preuve : c'est CET acte administrateur, tracé (référence + acteur + audit),
 * qui vaut confirmation. Idempotent : une double validation ne crédite ni ne
 * provisionne deux fois.
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
