import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [AuthModule],
  controllers: [ServersController],
  providers: [ServersService],
})
export class ServersModule {}