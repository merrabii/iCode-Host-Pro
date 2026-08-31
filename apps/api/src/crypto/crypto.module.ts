import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

// Application-level encryption (Phase 6 narrow ADR-008 slice). Not @Global:
// only the mail module needs it today; other consumers import it explicitly.
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
