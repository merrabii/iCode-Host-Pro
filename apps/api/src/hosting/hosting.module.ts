import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HostingServicesService } from './hosting-services.service';

/**
 * 17B.4F — module métier hébergement (service `HostingServicesService`).
 *
 * BRANCHÉ depuis `DeploymentsModule` (17B.4F-C2), mais strictement CONDITIONNÉ
 * côté service : `HostingServicesService` n'est appelé que lorsque la garde
 * `HOSTING_C2_ENABLED === 'true'` (lu à l'appel). Garde OFF (valeur par
 * défaut) ⇒ aucun appel, aucun accès aux colonnes C1 non migrées, contrat HTTP
 * historique préservé. Aucun endpoint n'est exposé par CE module.
 */
@Module({
  imports: [PrismaModule],
  providers: [HostingServicesService],
  exports: [HostingServicesService],
})
export class HostingModule {}
