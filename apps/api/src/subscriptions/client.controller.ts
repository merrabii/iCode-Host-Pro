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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types';
import { SubscriptionsService } from './subscriptions.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { CreateServiceDto } from './dto/create-service.dto';

// Phase 5 (ADR-021): client workspace — any authenticated user, ownership
// enforced in the service layer (another user's resource id → 404). The client
// catalog is the existing GET /api/products; /api/servers stays ADMIN-only.
@ApiTags('client')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class ClientController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post('subscriptions')
  @ApiOperation({ summary: 'Subscribe to a product (USER)' })
  createSubscription(
    @Body() dto: CreateSubscriptionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.subscriptions.createSubscription(dto, actor);
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'List my subscriptions (USER)' })
  listMySubscriptions(@CurrentUser() actor: JwtPayload) {
    return this.subscriptions.listMySubscriptions(actor);
  }

  @Patch('subscriptions/:id/cancel')
  @ApiOperation({ summary: 'Cancel one of my subscriptions (USER)' })
  cancelMySubscription(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.subscriptions.cancelMySubscription(id, actor);
  }

  @Post('services')
  @ApiOperation({ summary: 'Request a service under an ACTIVE subscription (USER)' })
  createMyService(@Body() dto: CreateServiceDto, @CurrentUser() actor: JwtPayload) {
    return this.subscriptions.createMyService(dto, actor);
  }

  @Get('services')
  @ApiOperation({ summary: 'List my services, no infra details (USER)' })
  listMyServices(@CurrentUser() actor: JwtPayload) {
    return this.subscriptions.listMyServices(actor);
  }
}
