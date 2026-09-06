import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { CloudflareController } from './cloudflare.controller';
import { CloudflareService } from './cloudflare.service';
import { CloudflareTransportFactory } from './cloudflare.transport';

// Phase 3 — contrôle DNS & Cloudflare (admin) + allocation de sous-domaines au
// déploiement. PrismaService/AuditService sont @Global ; AuthModule (fournit
// JwtModule/JwtService pour le guard @Roles ADMIN) et CryptoModule sont importés
// explicitement (ni l'un ni l'autre n'est global). CloudflareService est EXPORTÉ :
// DeploymentsModule l'utilise pour allouer le sous-domaine à la création d'une app.
@Module({
  imports: [AuthModule, CryptoModule],
  controllers: [CloudflareController],
  providers: [CloudflareService, CloudflareTransportFactory],
  exports: [CloudflareService],
})
export class CloudflareModule {}