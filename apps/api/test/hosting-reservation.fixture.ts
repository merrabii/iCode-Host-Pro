import { randomUUID } from 'crypto';
import { ReservationPayload } from '../src/hosting/hosting-fingerprint';

/**
 * 17B.4F-C1 — fixtures des e2e de réservation.
 *
 * - clé d'empreinte SYNTHÉTIQUE (32 octets constants de test, jamais un
 *   secret réel) installée dans `HOSTING_FP_KEYS` le temps des tests ;
 * - payload d'exemple strict (champs métier + valeurs d'environnement) ;
 * - `clientRequestId` = UUID v4 réel (contrat du moteur).
 */

export const TEST_FP_KEY_V1 = Buffer.alloc(32, 11).toString('base64');

export function installFingerprintEnv(): void {
  process.env.HOSTING_FP_KEYS = JSON.stringify({ v1: TEST_FP_KEY_V1 });
}

export function removeFingerprintEnv(): void {
  delete process.env.HOSTING_FP_KEYS;
}

export function newClientRequestId(): string {
  return randomUUID();
}

export function samplePayload(
  overrides: {
    business?: Record<string, string | number | boolean | null>;
    environment?: Record<string, string | number | boolean | null>;
  } = {},
): ReservationPayload {
  return {
    business: { productId: 'prod-sample', ramMb: 1024, ...overrides.business },
    environment: { host: 'app.sample.invalid', image: 'node:22', ...overrides.environment },
  };
}
