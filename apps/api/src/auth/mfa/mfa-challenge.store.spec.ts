import { MfaChallengeStore } from './mfa-challenge.store';

describe('MfaChallengeStore (in-memory single-use, ADR-027)', () => {
  let store: MfaChallengeStore;

  beforeEach(() => {
    store = new MfaChallengeStore();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function create(ttlMs = 300_000): string {
    return store.create({
      sub: 'u1',
      method: 'totp',
      methods: ['totp', 'email'],
      ttlMs,
    });
  }

  it('creates a challenge and returns it while live', () => {
    const id = create();
    const c = store.get(id)!;
    expect(c.sub).toBe('u1');
    expect(c.methods).toEqual(['totp', 'email']);
    expect(c.attempts).toBe(0);
  });

  it('expired challenges are removed and report undefined', () => {
    const id = create(1000);
    jest.advanceTimersByTime(1001);
    expect(store.get(id)).toBeUndefined();
  });

  it('consume reads AND destroys (single-use / anti-replay)', () => {
    const id = create();
    expect(store.consume(id)).toBeDefined();
    expect(store.get(id)).toBeUndefined();
  });

  it('save persists in-place mutations (attempts, email OTP fields)', () => {
    const id = create();
    const c = store.get(id)!;
    c.attempts += 1;
    c.emailOtpHash = 'abc';
    store.save(c);
    const again = store.get(id)!;
    expect(again.attempts).toBe(1);
    expect(again.emailOtpHash).toBe('abc');
  });

  it('reset clears every challenge', () => {
    const id = create();
    store.reset();
    expect(store.get(id)).toBeUndefined();
  });
});
