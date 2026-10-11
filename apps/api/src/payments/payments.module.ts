import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { StoreModule } from '../store/store.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
import { AdminRefundsController } from './controllers/admin-refunds.controller';
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
 *
 * Lot « paiement direct des commandes » — ce module IMPORT StoreModule (et
 * jamais l'inverse : aucun cycle) pour :
 *  - confirmer la commande (`CheckoutService`) dans la MÊME transaction que la
 *    confirmation du paiement carte (CAS `PENDING_PAYMENT → PAID`) ;
 *  - appliquer les gates `PaymentSettingsService` AVANT toute création.
 * Les remboursements de commande réglée par carte passent par
 * `CardRefundsService` (rattachement `orderId` + `cardPaymentId`) ; c'est pour
 * cela que `AdminRefundsController` est ENREGISTRÉ ICI (création par
 * `RefundService` exporté du store + émission carte) : le sens d'importation
 * reste PAIEMENTS → STORE, donc aucun cycle.
 * PrismaModule/AuditModule sont globaux ; AuthModule fournit le JWT des gardes.
 */
@Module({
  imports: [AuthModule, WalletModule, CryptoModule, StoreModule],
  controllers: [
    PaymentWebhookController,
    ClientPaymentsController,
    AdminPaymentsController,
    AdminRefundsController,
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
