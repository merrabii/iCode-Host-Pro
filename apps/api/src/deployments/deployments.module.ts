import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PanelTransportFactory } from '../servers/panel-transport.factory';
import { DeploymentModulesController } from './deployment-modules.controller';
import { DeploymentModulesService } from './deployment-modules.service';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { GithubService } from './github.service';

// Phase 10bis (M+N) : déploiement GitHub → Coolify côté client. PanelTransportFactory
// est FOURNIE ici directement (classe sans état, même pattern que ServersModule) —
// pas besoin d'importer ServersModule, on évite un couplage de module inutile.
// CloudflareModule est importé pour l'allocation du sous-domaine gratuit au
// déploiement (Phase 3). Phase 13 : controller/service des modules de déploiement
// (A/B) + projets Coolify live.
@Module({
  imports: [AuthModule, CryptoModule, CloudflareModule],
  controllers: [DeploymentsController, DeploymentModulesController],
  providers: [DeploymentsService, GithubService, PanelTransportFactory, DeploymentModulesService],
  exports: [DeploymentsService, DeploymentModulesService],
})
export class DeploymentsModule {}
