import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PanelTransportFactory } from '../servers/panel-transport.factory';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { GithubService } from './github.service';

// Phase 10bis (M+N) : déploiement GitHub → Coolify côté client. PanelTransportFactory
// est FOURNIE ici directement (classe sans état, même pattern que ServersModule) —
// pas besoin d'importer ServersModule, on évite un couplage de module inutile.
@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService, GithubService, PanelTransportFactory],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
