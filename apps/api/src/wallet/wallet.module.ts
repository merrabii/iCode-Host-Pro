import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminWalletController } from './admin-wallet.controller';
import { ClientWalletController } from './client-wallet.controller';
import { WalletService } from './wallet.service';

/**
 * GO P6 (lot C2 - portefeuille + C3a - recharge par virement).
 * Module dédié : le service wallet est le SEUL point d'écriture de
 * `Customer.walletBalanceCents` (R-WAL-01) — PrismaModule/AuditModule sont
 * globaux, AuthModule fournit le contexte JWT des gardes.
 */
@Module({
  imports: [AuthModule],
  controllers: [ClientWalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
