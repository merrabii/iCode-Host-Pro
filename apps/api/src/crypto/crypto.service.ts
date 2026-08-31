import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/** Thrown when ENCRYPTION_KEY is missing — surfaced as a clear 400. */
export class MailCryptoError extends Error {}

// Phase 6 (ADR-022): narrow application-level encryption slice — the SMTP
// password is stored AES-256-GCM encrypted at rest. The master key comes from
// ENCRYPTION_KEY (any length; sha256-derived to a 32-byte key). The payload
// format is base64(iv || gcmTag || ciphertext), so a wrong key or a tampered
// payload fails loudly on decrypt (auth tag mismatch). Full ADR-008 (secret
// management, persisted config architecture) stays PROPOSED.
@Injectable()
export class CryptoService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const secret = this.config.get<string>('encryptionKey');
    if (!secret) {
      throw new MailCryptoError(
        'Clé de chiffrement manquante (ENCRYPTION_KEY) dans apps/api/.env — ' +
          'impossible de chiffrer le mot de passe SMTP.',
      );
    }
    return createHash('sha256').update(secret).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]).toString('base64');
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }
}
