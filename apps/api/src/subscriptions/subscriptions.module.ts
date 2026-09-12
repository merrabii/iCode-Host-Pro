import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoreModule } from '../store/store.module';
import { SubscriptionsService } from './subscriptions.service';
import { ClientController } from './client.controller';
import { AdminSubscriptionsController } from './admin.controller';

@Module({
  // StoreModule exporte ProvisioningService (utilisé par syncSubscriptionLimits,
  // action admin « Ré-synchroniser les ressources » — Bloc 2/3/5).
  imports: [AuthModule, StoreModule],
  controllers: [ClientController, AdminSubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
