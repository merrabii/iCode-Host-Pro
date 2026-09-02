import { SaRateLimiter, rateKey, RATE } from './rate-limiter';

describe('SaRateLimiter (in-memory sliding window, ADR-027)', () => {
  let limiter: SaRateLimiter;

  beforeEach(() => {
    limiter = new SaRateLimiter();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows requests under the limit and denies past it', () => {
    expect(limiter.consume('k', 3, 1000).allowed).toBe(true);
    expect(limiter.consume('k', 3, 1000).allowed).toBe(true);
    expect(limiter.consume('k', 3, 1000).allowed).toBe(true);
    const denied = limiter.consume('k', 3, 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('sliding window: old timestamps drop out of the window', () => {
    expect(limiter.consume('k', 2, 1000).allowed).toBe(true);
    expect(limiter.consume('k', 2, 1000).allowed).toBe(true);
    expect(limiter.consume('k', 2, 1000).allowed).toBe(false);
    jest.advanceTimersByTime(1001);
    expect(limiter.consume('k', 2, 1000).allowed).toBe(true);
  });

  it('buckets are per-caller (IP + route)', () => {
    expect(limiter.consume('login:1.2.3.4', 1, 1000).allowed).toBe(true);
    expect(limiter.consume('login:1.2.3.4', 1, 1000).allowed).toBe(false);
    expect(limiter.consume('login:9.9.9.9', 1, 1000).allowed).toBe(true);
  });

  it('a limit of 0 or less denies everything', () => {
    expect(limiter.consume('k', 0, 1000).allowed).toBe(false);
  });

  it('reset clears every bucket', () => {
    limiter.consume('k', 1, 1000);
    expect(limiter.consume('k', 1, 1000).allowed).toBe(false);
    limiter.reset();
    expect(limiter.consume('k', 1, 1000).allowed).toBe(true);
  });

  it('rateKey builds stable bucket names', () => {
    expect(rateKey('1.2.3.4', 'login')).toBe('login:1.2.3.4');
    expect(rateKey(undefined, 'login')).toBe('login:unknown');
  });

  it('exposes a preset for every Phase 10 endpoint', () => {
    expect(RATE.login.limit).toBeGreaterThan(0);
    expect(RATE.mfaVerify.limit).toBeGreaterThan(0);
    expect(RATE.mfaEmailSend.limit).toBeGreaterThan(0);
    expect(RATE.supportRedeem.limit).toBeGreaterThan(0);
    expect(RATE.register.limit).toBeGreaterThan(0);
    expect(RATE.checkoutIntent.limit).toBeGreaterThan(0);
  });
});
