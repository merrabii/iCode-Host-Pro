import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MailSettingsController } from './mail-settings.controller';
import { MailSettingsService } from './mail-settings.service';
import { MailService } from './mail.service';
import { MailTransportFactory } from './mail-transport.factory';

// Phase 6 (ADR-022): AuthModule gives the ADMIN guards; CryptoModule the
// AES-256-GCM service. Exports MailService + MailSettingsService so the
// invitations module can send automatic invitation emails. forwardRef on
// AuthModule: the import chain Mail → Auth → Invitations → Mail is circular
// at the module-file level (same pattern as AuthModule ↔ InvitationsModule).
@Module({
  imports: [forwardRef(() => AuthModule), CryptoModule],
  controllers: [MailSettingsController],
  providers: [MailSettingsService, MailService, MailTransportFactory],
  exports: [MailSettingsService, MailService, MailTransportFactory],
})
export class MailModule {}
