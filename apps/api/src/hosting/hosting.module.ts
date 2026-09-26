import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HostingServicesService } from './hosting-services.service';

/**
 * 17B.4F — module métier hébergement (service `HostingServicesService`).
 *
 * NON BRANCHÉ dans `AppModule` (17B.4F-C1) : aucun endpoint, aucun appelant,
 * aucun parcours live ne traverse ce module — les tests l'importent/le
 * construisent directement. Le branchement interviendra séparément, après
 * revue (C2+), avec la reprise provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [HostingServicesService],
  exports: [HostingServicesService],
})
export class HostingModule {}
