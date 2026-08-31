import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ManagerController } from './manager.controller';
import { ManagerService } from './manager.service';

@Module({
  imports: [AuthModule],
  controllers: [ManagerController],
  providers: [ManagerService],
})
export class ManagerModule {}