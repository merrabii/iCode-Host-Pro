/**
 * Jest-only stub for otplib v13 (ADR-027), wired via moduleNameMapper.
 *
 * The real package's CJS entry transitively imports @otplib/plugin-base32-scure
 * → @scure/base, which ships ESM-only files that Jest's CommonJS runtime cannot
 * `require`. No unit spec ever exercises real TOTP math — mfa.service.spec mocks
 * `./totp` outright and the other specs only need the module to LOAD — so this
 * functional fake with the same surface (`generateSecret` / `verifySync` /
 * `generateURI`) is enough to keep the suite green. The production app builds
 * and runs against the real otplib (Nest/webpack handles ESM fine).
 */
export function generateSecret(): string {
  // A valid base32 secret (all-zero 160-bit key).
  return 'AAAAAAAAAAAAAAAA';
}

export function verifySync(): { valid: boolean; delta: number } {
  return { valid: true, delta: 0 };
}

export function generateURI(opts: {
  strategy: string;
  issuer: string;
  label: string;
  secret: string;
  period: number;
  digits: number;
}): string {
  return `otpauth://${opts.strategy}/${encodeURIComponent(opts.issuer)}:${encodeURIComponent(
    opts.label,
  )}?secret=${opts.secret}&period=${opts.period}&digits=${opts.digits}`;
}
