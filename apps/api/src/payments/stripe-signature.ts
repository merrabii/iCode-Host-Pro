import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GO Stripe — signature webhook (HMAC-SHA256, format `t=…,v1=…`).
 *
 * PUR (aucune dépendance Nest) → testable unitairement :
 *  - payload signé = `${timestamp}.${corps_brut}` (corps BRUT, jamais re-serialisé) ;
 *  - chaque `v1` du header est recalculé et comparé en temps constant ;
 *  - un `timestamp` hors tolérance (300 s par défaut) = refus (rejeu ancien) ;
 *  - un header absent/malformé = refus, jamais de « default OK ».
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StripeSignatureResult {
  ok: boolean;
  reason?: string;
}

export function buildSignedPayload(timestamp: number, rawBody: string | Buffer): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return `${timestamp}.${body}`;
}

export function computeStripeSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Parsing defensif de `t=123,v1=abc,v1=def` (tous les `v1` acceptés). */
export function parseSignatureHeader(header: string): {
  timestamp: number | null;
  signatures: string[];
} {
  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      const n = Number.parseInt(value, 10);
      timestamp = Number.isFinite(n) ? n : null;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Vérification complète : présence, format, tolérance temporelle, HMAC.
 * `nowSec` est injectable pour les tests (pas de `Date.now()` caché).
 */
export function verifyStripeSignature(opts: {
  rawBody: string | Buffer;
  header: string | undefined;
  secret: string;
  nowSec?: number;
  toleranceSec?: number;
}): StripeSignatureResult {
  const { rawBody, header, secret } = opts;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SECONDS;

  if (!header || !header.trim()) {
    return { ok: false, reason: 'header_absent' };
  }
  if (!secret || !secret.trim()) {
    return { ok: false, reason: 'secret_non_configure' };
  }
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null || signatures.length === 0) {
    return { ok: false, reason: 'header_malforme' };
  }
  if (Math.abs(nowSec - timestamp) > tolerance) {
    return { ok: false, reason: 'hors_tolérance' };
  }
  const payload = buildSignedPayload(timestamp, rawBody);
  const expected = computeStripeSignature(secret, payload);
  for (const sig of signatures) {
    if (safeEqualHex(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature_invalide' };
}

/** Fabrication d'un header signé (simulateur + tests — jamais de clé réelle). */
export function signStripeWebhook(opts: {
  rawBody: string;
  secret: string;
  nowSec?: number;
}): string {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const sig = computeStripeSignature(opts.secret, buildSignedPayload(nowSec, opts.rawBody));
  return `t=${nowSec},v1=${sig}`;
}
