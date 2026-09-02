import { Injectable } from '@nestjs/common';

export interface RateResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Narrow in-memory sliding-window rate limiter (Phase 10, ADR-027) — zero
 * dependencies, instance-local buckets. Buckets are keyed by the caller
 * (IP + route typically) and track sliding timestamps; when the count within
 * `windowMs` exceeds `limit` the call is denied with a retry-after hint.
 * Instance-local is acceptable (single API instance; a restart merely resets
 * the throttle — never a security hole).
 */
@Injectable()
export class SaRateLimiter {
  private buckets = new Map<string, number[]>();
  /** Survival-budget to keep memory bounded. */
  private readonly maxBuckets = 10_000;

  consume(key: string, limit: number, windowMs: number): RateResult {
    if (limit <= 0) return { allowed: false, retryAfterMs: 0 };
    if (this.buckets.size >= this.maxBuckets) this.buckets.clear();

    const now = Date.now();
    const current = (this.buckets.get(key) ?? []).filter(
      (t) => now - t < windowMs,
    );
    if (current.length >= limit) {
      const retryAfterMs = windowMs - (now - current[0]);
      this.buckets.set(key, current);
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }
    current.push(now);
    this.buckets.set(key, current);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Clear every bucket (used by tests). */
  reset(): void {
    this.buckets.clear();
  }
}

/** Shared rate-limit presets, tuned for the Phase 10 endpoints. */
export const RATE = {
  login: { limit: 10, windowMs: 60_000 },
  mfaVerify: { limit: 5, windowMs: 60_000 },
  mfaEmailSend: { limit: 5, windowMs: 60_000 },
  supportRedeem: { limit: 10, windowMs: 60_000 },
  register: { limit: 5, windowMs: 60_000 },
  checkoutIntent: { limit: 20, windowMs: 60_000 },
} as const;

/** Build a stable bucket key from a client IP + a logical route name. */
export function rateKey(ip: string | undefined, route: string): string {
  return `${route}:${ip ?? 'unknown'}`;
}