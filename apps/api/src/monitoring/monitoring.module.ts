import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Module({
  // Phase 13 : le controller admin utilise JwtAuthGuard + RolesGuard (JwtService,
  // fourni & exporté par AuthModule).
  imports: [AuthModule],
  providers: [MonitoringService],
  controllers: [MonitoringController],
  exports: [MonitoringService],
})
export class MonitoringModule {}