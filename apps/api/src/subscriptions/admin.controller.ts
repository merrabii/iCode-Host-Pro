import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { UpdateServiceDto } from './dto/update-service.dto';

// Phase 5 (ADR-021): admin overlay over the client workspace. The ADMIN approves
// subscriptions and assigns hosting servers + advances service status. The
// client never reaches these routes (403) nor the /api/servers API.
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

  @Get('services')
  @ApiOperation({ summary: 'List all services with assigned server (ADMIN)' })
  listAllServices() {
    return this.subscriptions.listAllServices();
  }

  @Patch('services/:id')
  @ApiOperation({ summary: 'Assign a server / advance status (ADMIN)' })
  updateService(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.subscriptions.updateService(id, dto, actor);
  }
}
