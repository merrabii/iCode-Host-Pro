import { generateSecret, generateURI, verifySync } from 'otplib';

// Phase 10 (ADR-027): thin adapter over otplib v13's functional API exposing the
// classic `authenticator` surface (generateSecret / check / keyuri) used by
// MfaService. TOTP policy is fixed here: step 30s, digits 6, base32 secrets,
// and an RFC-friendly window of [1, 0] (current step + one step before, never
// future codes). The v13 package has no singleton; options are passed per call.

const STEP = 30; // seconds
const DIGITS = 6;
/** Window [1, 0] ⇒ accept the current step and the previous one only. */
const TOLERANCE: [number, number] = [STEP, 0];

export const totp = {
  generateSecret(): string {
    return generateSecret();
  },

  /** Check a 6-digit code against a base32 secret (timing-safe inside otplib). */
  check(token: string, secret: string): boolean {
    const result = verifySync({
      secret,
      token,
      period: STEP,
      digits: DIGITS,
      epochTolerance: TOLERANCE,
    });
    return result.valid;
  },

  /** otpauth:// URI for the authenticator app QR code. */
  keyuri(label: string, issuer: string, secret: string): string {
    return generateURI({ strategy: 'totp', issuer, label, secret, period: STEP, digits: DIGITS });
  },
};
