import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
import { ClientPaymentsController } from './controllers/client-payments.controller';
import { PaymentWebhookController } from './controllers/payment-webhook.controller';
import { SimulatedPaymentController } from './controllers/simulated-payment.controller';
import { CardPaymentsService } from './card-payments.service';
import { CardRefundsService } from './card-refunds.service';
import { PaymentProviderService } from './payment-provider.service';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * GO Stripe (lot carte) — paiement par carte en mode TEST (Code Diali).
 *
 *  - connecteur ABSTRAIT (`PaymentConnector`) : Stripe aujourd'hui,
 *    PaymentCloud plus tard par un connecteur distinct (aucune implémentation
 *    fictive, aucun bouton non fonctionnel) ;
 *  - configuration chiffrée + live refusé (`PaymentProviderService`) ;
 *  - confirmation unique par webhook signé / relecture serveur
 *    (`PaymentWebhookService` + `CardPaymentsService`) ;
 *  - remboursement recharge → carte avec plafond, idempotence et compensation
 *    (`CardRefundsService`) ;
 *  - simulateur local réservé à la recette (drapeau explicite, jamais en prod).
 * PrismaModule/AuditModule sont globaux ; AuthModule fournit le JWT des gardes.
 */
@Module({
  imports: [AuthModule, WalletModule, CryptoModule],
  controllers: [
    PaymentWebhookController,
    ClientPaymentsController,
    AdminPaymentsController,
    SimulatedPaymentController,
  ],
  providers: [
    PaymentProviderService,
    CardPaymentsService,
    PaymentWebhookService,
    CardRefundsService,
  ],
  exports: [CardPaymentsService, PaymentWebhookService],
})
export class PaymentsModule {}
