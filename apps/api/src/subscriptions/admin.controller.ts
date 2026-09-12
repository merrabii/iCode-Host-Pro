import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { SubscriptionsService } from './subscriptions.service';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';

// Phase 5 (ADR-021): admin overlay over the client workspace. The ADMIN
// approves/suspends/activates subscriptions. Client never reaches these routes
// (403) nor the /api/servers API. (Bloc 4 : services supprimés — tout passe par
// la procédure de commande store.)
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'List all subscriptions (ADMIN)' })
  listAllSubscriptions() {
    return this.subscriptions.listAllSubscriptions();
  }

  @Patch('subscriptions/:id')
  @ApiOperation({ summary: 'Approve/reject/suspend/activate a subscription (ADMIN)' })
  updateSubscription(
    @Param('id') id: string,
    @Body() dto: UpdateSubscriptionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.subscriptions.updateSubscription(id, dto, actor);
  }

  @Post('subscriptions/:id/resync-limits')
  @ApiOperation({
    summary:
      'Ré-synchroniser les limites RAM/CPU du pack sur les apps déployées de l’abonné (ADMIN)',
  })
  resyncLimits(@Param('id') id: string) {
    return this.subscriptions.syncSubscriptionLimits(id);
  }
}
