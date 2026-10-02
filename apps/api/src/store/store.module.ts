import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { HttpAvailabilityService } from '../common/http-availability.service';
import { CryptoModule } from '../crypto/crypto.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { HostingModule } from '../hosting/hosting.module';
import { MailModule } from '../mail/mail.module';
import { ProductsModule } from '../products/products.module';
import { PanelTransportFactory } from '../servers/panel-transport.factory';
import { BillingPaymentAdminController } from './billing-payment.admin.controller';
import { AdminBillingController } from './admin-billing.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { ClientStoreController } from './client-store.controller';
import { DEPLOYMENT_EVIDENCE_CONNECTORS } from './deployment-evidence';
import { DeploymentEvidenceService } from './deployment-evidence.service';
import { OrderCancelService } from './order-cancel.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { PaymentMethodsController } from './payment-methods.controller';
import { ProvisioningService } from './provisioning.service';
import { ReconcileRunnerService } from './reconcile.runner.service';
import { ReconcileService } from './reconcile.service';
import { ReconcileSettingAdminController } from './reconcile-setting.admin.controller';
import { ReconcileSettingsService } from './reconcile-settings.service';
import { CoolifyEvidenceConnector } from './evidence-connectors/coolify-evidence.connector';
import { StoreProvisioningAdminController } from './store-provisioning.admin.controller';
import { StoreSubdomainController } from './store-subdomain.controller';

/**
 * Bloc C/D — module store (tunnel d'achat sans compte, paiement simulé, provisioning).
 * Réutilise AuthModule (SaRateLimiter), MailModule, ProductsModule, CloudflareModule
 * et PanelTransportFactory (pose du domaine Coolify).
 * 17B.4B — ajoute le moteur de réconciliation asynchrone (ReconcileService, pas
 * de boucle : scanOnce est appelé explicitement, le timer 17B.4C viendra après),
 * la couche évidence et le connecteur Coolify enregistré dans le registre DI.
 * 17B.4F-C3 — importe `HostingModule` (réservation store C1 + capability
 * C3) : sans cycle (HostingModule n'importe que PrismaModule).
 */
@Module({
  imports: [AuthModule, CloudflareModule, CryptoModule, DeploymentsModule, HostingModule, MailModule, ProductsModule],
  controllers: [
    PaymentMethodsController,
    BillingPaymentAdminController,
    AdminOrdersController,
    AdminBillingController,
    ClientStoreController,
    CheckoutController,
    StoreProvisioningAdminController,
    StoreSubdomainController,
    ReconcileSettingAdminController,
  ],
  providers: [
    CheckoutService,
    ProvisioningService,
    OrderCancelService,
    OrderLifecycleService,
    PanelTransportFactory,
    HttpAvailabilityService,
    ReconcileSettingsService,
    CoolifyEvidenceConnector,
    DeploymentEvidenceService,
    {
      provide: DEPLOYMENT_EVIDENCE_CONNECTORS,
      useFactory: (coolify: CoolifyEvidenceConnector) => [coolify],
      inject: [CoolifyEvidenceConnector],
    },
    ReconcileService,
    ReconcileRunnerService,
  ],
  exports: [
    ProvisioningService,
    OrderCancelService,
    HttpAvailabilityService,
    ReconcileSettingsService,
    DeploymentEvidenceService,
    ReconcileService,
  ],
})
export class StoreModule {}
