import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HostingServicesService } from './hosting-services.service';
import { C3CapabilityService } from './c3-capability.service';

/**
 * 17B.4F — module métier hébergement (service `HostingServicesService`).
 *
 * BRANCHÉ depuis `DeploymentsModule` (17B.4F-C2) et `StoreModule`
 * (17B.4F-C3), mais strictement CONDITIONNÉ côté service : `HostingServicesService`
 * n'est appelé que lorsque la garde correspondante est ON (lu à l'appel) :
 *  - C2 : `HOSTING_C2_ENABLED === 'true'` (réservation sur déploiement direct) ;
 *  - C3 : `HOSTING_C3_ENABLED === 'true'` (provisioning des nouvelles commandes
 *    store, claim/lease sur `OrderProvisioningTracking`).
 * Garde OFF ⇒ aucun appel, aucun accès aux colonnes C1 non migrées, contrat
 * HTTP historique préservé. Aucun endpoint n'est exposé par CE module.
 * `C3CapabilityService` (probe live capability C1+C3) est exporté pour le
 * routage fail-closed du store.
 */
@Module({
  imports: [PrismaModule],
  providers: [HostingServicesService, C3CapabilityService],
  exports: [HostingServicesService, C3CapabilityService],
})
export class HostingModule {}
