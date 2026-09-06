// Phase 3 — transport HTTP RÉEL vers l'API Cloudflare v4 (contrôle DNS live).
// L'API Cloudflare a une enveloppe JSON différente de Coolify : { success, result,
// errors }. On la valide systématiquement : un `success:false` (token invalide,
// règle DNS violée…) devient une erreur lisible. Base par défaut :
// https://api.cloudflare.com/client/v4 ; surchargeable (baseUrl) pour les tests
// loopback (aucun réseau externe jamais touché en test).
//
// La clé d'accès est passée DÉCHIFFRÉE à l'appel (CloudflareService décrypte
// apiTokenEnc à la volée — jamais transmise ni loguée).
import { Injectable } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';

export interface CloudflareTarget {
  token: string;
  baseUrl?: string; // défaut API Cloudflare v4 ; overridé en test loopback
  strictTls?: boolean;
}

export interface CfZone {
  id: string;
  name: string;
  status: string; // active / pending / moved / deleted
  paused: boolean;
}

export interface CfDnsRecord {
  id: string;
  type: string; // A | CNAME | MX | TXT | AAAA | …
  name: string; // fqdn (ex monapp.arumdigital.com) ou relatif
  content: string;
  proxied?: boolean;
  ttl?: number;
}

export interface CfCreateRecordInput {
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number; // 1 = Auto (requis quand proxied)
}

/** HTTP minimal (même veine que PanelTransportFactory) : status + body. */
function httpRequest(
  method: string,
  href: string,
  headers: http.OutgoingHttpHeaders,
  strictTls: boolean,
  timeoutMs: number,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(href);
    const isHttps = urlObj.protocol === 'https:';
    const reqLib = (isHttps ? https : http) as typeof http;
    const opts: https.RequestOptions = {
      method,
      hostname: urlObj.hostname,
      port: Number(urlObj.port) || (isHttps ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      rejectUnauthorized: !!strictTls,
      headers: { 'User-Agent': 'iCodePanel/1.0', ...headers },
    };
    let settled = false;
    const settleOk = (status: number, out: string) => {
      if (settled) return;
      settled = true;
      resolve({ status, body: out });
    };
    const req = reqLib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        settleOk(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'));
      });
    });
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* noop */
      }
      const err = new Error(`timeout-${timeoutMs}`) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

// Messages d'échec réseau dans la veine de la sonde (Phase 8).
function networkDetail(err: NodeJS.ErrnoException, timeoutMs: number): string {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') return 'Connexion refusée';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Hôte introuvable';
  if (code === 'ETIMEDOUT') return `Délai dépassé (${timeoutMs} ms)`;
  const msg = String(err.message ?? code);
  if (msg.toLowerCase().includes('certificate') || msg.includes('UNABLE_TO_VERIFY') || msg.includes('CERT_HAS_EXPIRED')) {
    return `Erreur TLS : ${msg}`;
  }
  return msg;
}

/** Erreur domaine Cloudflare avec un message SEO (errors + status). */
function envelopeError(status: number, errors: unknown): string {
  const joined = Array.isArray(errors)
    ? (errors as Array<{ message?: string; code?: number }>)
        .filter((e) => e && typeof e.message === 'string')
        .map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`)
        .join(' ; ')
    : '';
  return `Cloudflare API : ${joined || `HTTP ${status}`}`;
}

export class CloudflareTransport {
  constructor(private readonly timeoutMs = 10_000) {}

  private base(baseUrl?: string): string {
    return (baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  }

  /**
   * Requête Cloudflare : Bearer + enveloppe { success, result, errors }.
   * Résout vers `result` (typé) quand success===true ; jette une erreur lisible
   * sinon (y compris 401 token invalide → « Jeton API rejeté (401) »).
   */
  private async call<T>(
    target: CloudflareTarget,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const href = `${this.base(target.baseUrl)}${path}`;
    let raw: { status: number; body: string };
    try {
      raw = await httpRequest(
        method,
        href,
        { Authorization: `Bearer ${target.token}` },
        target.strictTls ?? true,
        this.timeoutMs,
        body === undefined ? undefined : JSON.stringify(body),
      );
    } catch (err) {
      const m = networkDetail(err as NodeJS.ErrnoException, this.timeoutMs);
      throw new Error(`Cloudflare API : ${m}`);
    }
    let parsed: { success?: boolean; result?: T; errors?: unknown };
    try {
      parsed = JSON.parse(raw.body || '{}');
    } catch {
      if (raw.status === 401) throw new Error('Jeton API rejeté (401)');
      throw new Error(`Cloudflare API : réponse inattendue (HTTP ${raw.status})`);
    }
    if (!parsed.success) {
      const detail = envelopeError(raw.status, parsed.errors);
      if (raw.status === 401) throw new Error('Jeton API Cloudflare rejeté (401)');
      throw new Error(detail);
    }
    return parsed.result as T;
  }

  /** Zones du compte (source des racines importables). */
  listZones(target: CloudflareTarget): Promise<CfZone[]> {
    return this.call<CfZone[]>(target, 'GET', '/zones?per_page=100');
  }

  /** Enregistrements DNS d'une zone (table live). */
  listRecords(target: CloudflareTarget, zoneId: string): Promise<CfDnsRecord[]> {
    return this.call<CfDnsRecord[]>(
      target,
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100`,
    );
  }

  /** Vérification dispo : un enregistrement existe-t-il exactement sous `name` ? */
  async findRecordByName(
    target: CloudflareTarget,
    zoneId: string,
    name: string,
  ): Promise<CfDnsRecord | null> {
    const result = await this.call<CfDnsRecord[]>(
      target,
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`,
    );
    return result[0] ?? null;
  }

  /** Crée un enregistrement DNS ; renvoie son id Cloudflare. */
  async createRecord(
    target: CloudflareTarget,
    zoneId: string,
    input: CfCreateRecordInput,
  ): Promise<string> {
    const result = await this.call<{ id: string }>(
      target,
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      input,
    );
    return result.id;
  }

  /** Supprime un enregistrement DNS d'une zone. */
  async deleteRecord(target: CloudflareTarget, zoneId: string, recordId: string): Promise<void> {
    await this.call<unknown>(
      target,
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
  }
}

/** Fabrique injectable (overridable en e2e), même rôle que PanelTransportFactory. */
@Injectable()
export class CloudflareTransportFactory {
  create(timeoutMs = 10_000): CloudflareTransport {
    return new CloudflareTransport(timeoutMs);
  }
}