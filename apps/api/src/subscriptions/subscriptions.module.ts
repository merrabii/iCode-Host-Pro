import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsService } from './subscriptions.service';
import { ClientController } from './client.controller';
import { AdminSubscriptionsController } from './admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [ClientController, AdminSubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
