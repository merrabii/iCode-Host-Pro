import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

export type MfaMethod = 'totp' | 'email';

/**
 * A pending two-step-login MFA challenge. Fields:
 * - `method`: the method the client is currently using (totp default).
 * - `methods`: the candidate methods offered to the client (totp always when
 *   enabled; email added when the SMTP mail channel is configured).
 * - `attempts`: wrong attempts (lockout at 5 — challenge destroyed).
 * - `emailOtpHash`/`emailOtpExpiresAt`: sha256 of the emailed 6-digit code.
 */
export interface MfaChallenge {
  id: string;
  sub: string; // user id
  method: MfaMethod;
  methods: MfaMethod[];
  createdAt: number;
  ttlMs: number;
  attempts: number;
  emailOtpHash?: string;
  emailOtpExpiresAt?: number;
}

/**
 * In-memory MFA challenge store (single API instance). Challenges are
 * short-lived, single-use and destroyed on success or lockout — a restart only
 * forces a fresh login (never a replay or a security hole).
 */
@Injectable()
export class MfaChallengeStore {
  private challenges = new Map<string, MfaChallenge>();

  create(input: {
    sub: string;
    method: MfaMethod;
    methods: MfaMethod[];
    ttlMs: number;
  }): string {
    const id = randomUUID();
    this.challenges.set(id, {
      id,
      sub: input.sub,
      method: input.method,
      methods: input.methods,
      createdAt: Date.now(),
      ttlMs: input.ttlMs,
      attempts: 0,
    });
    return id;
  }

  /** Return a live (non-expired) challenge, or undefined. */
  get(id: string): MfaChallenge | undefined {
    const c = this.challenges.get(id);
    if (!c) return undefined;
    if (Date.now() - c.createdAt >= c.ttlMs) {
      this.challenges.delete(id);
      return undefined;
    }
    return c;
  }

  /** Persist in-place changes made to a challenge object. */
  save(c: MfaChallenge): void {
    this.challenges.set(c.id, c);
  }

  /** Atomically read + destroy (single-use). Returns the challenge if live. */
  consume(id: string): MfaChallenge | undefined {
    const c = this.get(id);
    if (c) this.challenges.delete(id);
    return c;
  }

  reset(): void {
    this.challenges.clear();
  }
}