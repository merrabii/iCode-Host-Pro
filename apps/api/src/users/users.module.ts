import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // Phase 13 : UsersService injecte DeploymentsService (création du projet
  // Coolify dédié du client, Module B). DeploymentsModule exporte ce service.
  imports: [AuthModule, DeploymentsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}