import {
  DEFAULT_TOLERANCE_SECONDS,
  buildSignedPayload,
  computeStripeSignature,
  parseSignatureHeader,
  signStripeWebhook,
  verifyStripeSignature,
} from './stripe-signature';

// GO Stripe §4 — signature webhook testée SANS réseau : construction du
// payload signé, HMAC, tolérance temporelle, corps modifié, entête absent.
describe('stripe-signature (GO §4 — vérification webhook)', () => {
  const secret = 'whsec_test_unitaire_0123456789';
  const rawBody = JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1' } },
  });
  const now = 1_700_000_000;

  it('construit le payload signé `${t}.${corps}`', () => {
    expect(buildSignedPayload(now, rawBody)).toBe(`${now}.${rawBody}`);
    expect(buildSignedPayload(now, Buffer.from(rawBody))).toBe(`${now}.${rawBody}`);
  });

  it('accepte une signature valide (HMAC-SHA256 hexadécimal)', () => {
    const header = signStripeWebhook({ rawBody, secret, nowSec: now });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyStripeSignature({ rawBody, header, secret, nowSec: now }),
    ).toEqual({ ok: true });
  });

  it('refuse un corps modifié même avec le bon horodatage', () => {
    const header = signStripeWebhook({ rawBody, secret, nowSec: now });
    const tampered = rawBody.replace('cs_1', 'cs_pirate');
    expect(verifyStripeSignature({ rawBody: tampered, header, secret, nowSec: now })).toEqual({
      ok: false,
      reason: 'signature_invalide',
    });
  });

  it('refuse un secret erroné', () => {
    const header = signStripeWebhook({ rawBody, secret, nowSec: now });
    expect(
      verifyStripeSignature({
        rawBody,
        header,
        secret: 'whsec_autre',
        nowSec: now,
      }),
    ).toEqual({ ok: false, reason: 'signature_invalide' });
  });

  it('refuse un horodatage hors tolérance (rejeu ancien)', () => {
    const header = signStripeWebhook({ rawBody, secret, nowSec: now });
    const late = now + DEFAULT_TOLERANCE_SECONDS + 1;
    expect(verifyStripeSignature({ rawBody, header, secret, nowSec: late })).toEqual({
      ok: false,
      reason: 'hors_tolérance',
    });
    // …mais accepte à l'intérieur de la fenêtre.
    expect(
      verifyStripeSignature({
        rawBody,
        header,
        secret,
        nowSec: now + DEFAULT_TOLERANCE_SECONDS - 1,
      }),
    ).toEqual({ ok: true });
  });

  it('refuse un entête absent ou malformé (jamais de « default OK »)', () => {
    expect(verifyStripeSignature({ rawBody, header: undefined, secret, nowSec: now })).toEqual(
      { ok: false, reason: 'header_absent' },
    );
    expect(verifyStripeSignature({ rawBody, header: '', secret, nowSec: now })).toEqual({
      ok: false,
      reason: 'header_absent',
    });
    expect(verifyStripeSignature({ rawBody, header: 'v1=abc', secret, nowSec: now })).toEqual({
      ok: false,
      reason: 'header_malforme',
    });
    expect(
      verifyStripeSignature({ rawBody, header: `t=notanumber,v1=x`, secret, nowSec: now }),
    ).toEqual({ ok: false, reason: 'header_malforme' });
    expect(
      verifyStripeSignature({ rawBody, header: `t=${now},v1=`, secret, nowSec: now }),
    ).toEqual({ ok: false, reason: 'signature_invalide' });
  });

  it('refuse un secret non configuré', () => {
    const header = signStripeWebhook({ rawBody, secret, nowSec: now });
    expect(verifyStripeSignature({ rawBody, header, secret: '', nowSec: now })).toEqual({
      ok: false,
      reason: 'secret_non_configure',
    });
  });

  it('accepte un entête contenant plusieurs signatures v1 (ré-signature)', () => {
    const first = signStripeWebhook({ rawBody, secret, nowSec: now - 10 });
    const second = signStripeWebhook({ rawBody, secret, nowSec: now });
    const combined = `${first},${second.split(',')[1]}`;
    expect(
      verifyStripeSignature({ rawBody, header: combined, secret, nowSec: now }),
    ).toEqual({ ok: true });
  });

  it('parse un entête en tolérant les espaces et champs inconnus', () => {
    const parsed = parseSignatureHeader(` t=${now} , v1=aa , scheme=HTTP,v1=bb `);
    expect(parsed.timestamp).toBe(now);
    expect(parsed.signatures).toEqual(['aa', 'bb']);
    expect(computeStripeSignature(secret, 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
