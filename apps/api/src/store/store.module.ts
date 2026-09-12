import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MailModule } from '../mail/mail.module';
import { ProductsModule } from '../products/products.module';
import { PanelTransportFactory } from '../servers/panel-transport.factory';
import { BillingPaymentAdminController } from './billing-payment.admin.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PaymentMethodsController } from './payment-methods.controller';
import { ProvisioningService } from './provisioning.service';
import { StoreProvisioningAdminController } from './store-provisioning.admin.controller';
import { StoreSubdomainController } from './store-subdomain.controller';

/**
 * Bloc C/D — module store (tunnel d'achat sans compte, paiement simulé, provisioning).
 * Réutilise AuthModule (SaRateLimiter), MailModule, ProductsModule, CloudflareModule
 * et PanelTransportFactory (pose du domaine Coolify).
 */
@Module({
  imports: [AuthModule, CloudflareModule, CryptoModule, MailModule, ProductsModule],
  controllers: [
    PaymentMethodsController,
    BillingPaymentAdminController,
    CheckoutController,
    StoreProvisioningAdminController,
    StoreSubdomainController,
  ],
  providers: [CheckoutService, ProvisioningService, PanelTransportFactory],
  exports: [ProvisioningService],
})
export class StoreModule {}
