import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';
import { ProbeTransportFactory } from './probe-transport.factory';

@Module({
  imports: [AuthModule],
  controllers: [ServersController],
  providers: [ServersService, ProbeTransportFactory],
})
export class ServersModule {}