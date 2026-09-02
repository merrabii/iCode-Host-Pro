import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';
import { ProbeTransportFactory } from './probe-transport.factory';
import { PanelTransportFactory } from './panel-transport.factory';
import { HostResolverFactory } from './host-resolver.factory';

@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [ServersController],
  providers: [ServersService, ProbeTransportFactory, PanelTransportFactory, HostResolverFactory],
  exports: [ServersService],
})
export class ServersModule {}
