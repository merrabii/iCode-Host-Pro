import {
  FingerprintConfigError,
  FingerprintPayloadError,
  canonicalizePayload,
  computeFingerprint,
  directIdempotencyKey,
  loadKeyring,
  normalizeClientRequestId,
  verifyFingerprint,
} from './hosting-fingerprint';

/**
 * 17B.4F-C1 — empreinte de réservation : canonicité, HMAC versionné, keyring
 * de rotation, refus explicites (jamais de repli) et dérivation de clé.
 * AUCUN secret réel : uniquement des clés synthétiques de test.
 */
describe('hosting-fingerprint (17B.4F-C1)', () => {
  const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
  const KEY_V1_ROTATED = Buffer.alloc(32, 2).toString('base64');
  const KEY_V2 = Buffer.alloc(32, 3).toString('base64');

  const payload = (
    business: Record<string, string | number | boolean | null> = { productId: 'p1', ramMb: 1024 },
    environment: Record<string, string | number | boolean | null> = { host: 'app.test', image: 'node:22' },
  ) => ({ business, environment });

  const withEnv = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...({} as NodeJS.ProcessEnv),
    ...overrides,
  });

  // ── canonicalisation ─────────────────────────────────────────────────────

  it('1. canonique déterministe : ordre des clés indifférent, mêmes valeurs → même empreinte', () => {
    const keyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const a = { business: { productId: 'p1', ramMb: 1024 }, environment: { host: 'h', image: 'i' } };
    const b = { business: { ramMb: 1024, productId: 'p1' }, environment: { image: 'i', host: 'h' } };
    expect(canonicalizePayload(a)).toBe(canonicalizePayload(b));
    expect(computeFingerprint(a, keyring)).toBe(computeFingerprint(b, keyring));
  });

  it('2. toute divergence (métier OU environnement) change l’empreinte', () => {
    const keyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const base = computeFingerprint(payload(), keyring);
    expect(computeFingerprint(payload({ productId: 'p1', ramMb: 2048 }), keyring)).not.toBe(base);
    expect(computeFingerprint(payload(undefined, { host: 'other.test', image: 'node:22' }), keyring)).not.toBe(base);
    expect(computeFingerprint(payload(undefined, { host: 'app.test', image: 'node:24' }), keyring)).not.toBe(base);
    expect(computeFingerprint(payload({ productId: 'p1' }, undefined), keyring)).not.toBe(base);
  });

  it('3. canonique : valeurs non finies, types interdits et profondeur libre refusés', () => {
    expect(() => canonicalizePayload(payload({ cpu: Number.NaN }))).toThrow(FingerprintPayloadError);
    expect(() => canonicalizePayload(payload({ cpu: Number.POSITIVE_INFINITY }))).toThrow(FingerprintPayloadError);
    expect(() =>
      canonicalizePayload({ business: { fn: (() => 1) as never }, environment: {} }),
    ).toThrow(FingerprintPayloadError);
    expect(() =>
      canonicalizePayload({ business: { nested: { deep: { x: 1 } } as never }, environment: {} }),
    ).not.toThrow(); // objets imbriqués primitives autorisés et triés récursivement
    expect(canonicalizePayload({ business: { nested: { a: 1, b: 2 } }, environment: {} })).toBe(
      canonicalizePayload({ business: { nested: { b: 2, a: 1 } }, environment: {} }),
    );
  });

  // ── format, rotation, refus explicites ───────────────────────────────────

  it('4. empreinte au format fp:v1:<hex> et vérification à débit constant', () => {
    const keyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const stored = computeFingerprint(payload(), keyring);
    expect(stored).toMatch(/^fp:v1:[0-9a-f]{64}$/);
    expect(verifyFingerprint(stored, payload(), keyring)).toBe(true);
    expect(verifyFingerprint(stored, payload(undefined, { host: 'evil.test', image: 'node:22' }), keyring)).toBe(false);
    expect(verifyFingerprint(null, payload(), keyring)).toBe(false);
    expect(verifyFingerprint('format-invalide', payload(), keyring)).toBe(false);
  });

  it('5. rotation : la clé active crée, l’ancienne version reste VÉRIFIABLE', () => {
    const oldKeyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const stored = computeFingerprint(payload(), oldKeyring);

    const rotated = loadKeyring(
      withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1, v2: KEY_V2 }), HOSTING_FP_ACTIVE: 'v2' }),
    );
    expect(rotated.active).toBe('v2');
    // ancienne empreinte TOUTE VERIFIABLE (rejeu d'allocation historique)
    expect(verifyFingerprint(stored, payload(), rotated)).toBe(true);
    // nouvelles empreintes sous la version active
    expect(computeFingerprint(payload(), rotated)).toMatch(/^fp:v2:/);
    // clé v1 retirée du keyring → refus EXPLICITE (jamais de repli)
    const withoutV1 = loadKeyring(
      withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v2: KEY_V2 }), HOSTING_FP_ACTIVE: 'v2' }),
    );
    expect(() => verifyFingerprint(stored, payload(), withoutV1)).toThrow(FingerprintConfigError);
  });

  it('6. version d’empreinte stockée inconnue → refus explicite, aucun repli', () => {
    const keyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const future = 'fp:v99:' + 'a'.repeat(64);
    expect(() => verifyFingerprint(future, payload(), keyring)).toThrow(FingerprintConfigError);
  });

  it('7. configuration absente → FingerprintConfigError (réservation refusée au call)', () => {
    expect(() => loadKeyring(withEnv({}))).toThrow(FingerprintConfigError);
    expect(() => loadKeyring(withEnv({ HOSTING_FP_KEYS: '' }))).toThrow(FingerprintConfigError);
    expect(() => loadKeyring(withEnv({ HOSTING_FP_KEYS: 'pas-du-json' }))).toThrow(FingerprintConfigError);
    expect(() => loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }), HOSTING_FP_ACTIVE: 'v7' }))).toThrow(
      FingerprintConfigError,
    );
    expect(() => loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: Buffer.alloc(8, 1).toString('base64') }) }))).toThrow(
      FingerprintConfigError,
    );
    expect(() => loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ cle: KEY_V1 }) }))).toThrow(
      FingerprintConfigError,
    );
  });

  it('8. fallback v1 depuis ENCRYPTION_KEY (même contrat que CryptoService)', () => {
    const env = withEnv({ ENCRYPTION_KEY: 'cle-synthetique-de-test-uniquement' });
    const keyring = loadKeyring(env);
    expect(keyring.active).toBe('v1');
    const stored = computeFingerprint(payload(), keyring);
    expect(verifyFingerprint(stored, payload(), loadKeyring(env))).toBe(true);
    // le keyring explicite PREND LE PAS sur le fallback
    const explicit = loadKeyring(
      withEnv({ ENCRYPTION_KEY: 'autre', HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1_ROTATED }) }),
    );
    expect(computeFingerprint(payload(), explicit)).not.toBe(stored);
  });

  // ── clé directe et clientRequestId ───────────────────────────────────────

  it('9. clientRequestId : UUID v4 strict, tout autre format refusé', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(normalizeClientRequestId(uuid)).toBe(uuid);
    expect(normalizeClientRequestId(uuid.toUpperCase())).toBe(uuid);
    expect(() => normalizeClientRequestId('key-1')).toThrow(TypeError);
    expect(() => normalizeClientRequestId('123e4567-e89b-12d3-a456-426614174000')).toThrow(TypeError); // v1
    expect(() => normalizeClientRequestId('')).toThrow(TypeError);
    expect(() => normalizeClientRequestId('')).toThrow(/UUID v4/);
  });

  it('10. clé directe : dérivée serveur, distincte par (user, service, demande)', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(directIdempotencyKey('user1', 'hs1', uuid)).toBe(`direct:v1:user1:hs1:${uuid}`);
    expect(directIdempotencyKey('user1', 'hs1', uuid)).not.toBe(directIdempotencyKey('user2', 'hs1', uuid));
    expect(directIdempotencyKey('user1', 'hs1', uuid)).not.toBe(directIdempotencyKey('user1', 'hs2', uuid));
    expect(directIdempotencyKey('user1', 'hs1', uuid)).not.toBe(
      directIdempotencyKey('user1', 'hs1', '123e4567-e89b-42d3-a456-426614174001'),
    );
    // jamais de secret ni de payload dans la clé
    expect(directIdempotencyKey('user1', 'hs1', uuid)).not.toMatch(/password|secret|token/i);
  });

  it('11. aucune valeur de payload, clé ou canonique n’apparaît dans le format stocké', () => {
    const keyring = loadKeyring(withEnv({ HOSTING_FP_KEYS: JSON.stringify({ v1: KEY_V1 }) }));
    const stored = computeFingerprint(payload({ productId: 'p1-secret-value' }, { host: 'secret.host' }), keyring);
    expect(stored).not.toContain('p1-secret-value');
    expect(stored).not.toContain('secret.host');
    expect(stored).not.toContain(KEY_V1);
    expect(stored).not.toContain(Buffer.from(KEY_V1, 'base64').toString('hex'));
  });
});
