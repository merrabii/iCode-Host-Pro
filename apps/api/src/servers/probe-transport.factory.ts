// Phase 8 (ADR-025) — couture de test pour la sonde de connectivité.
//
// Le transport réel touche le réseau (TCP/HTTP). Pour isoler les tests,
// ServersService dépend de ProbeTransportFactory (injectable, overridée en
// e2e comme MailTransportFactory) — aucun test ne touche jamais le réseau.
import { Injectable } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

// ── Contrats ──────────────────────────────────────────────────────────

export interface ProbeTarget {
  host: string;
  port: number;
  strictTls: boolean;
  // Override explicite du protocole. Défaut = dérivé du port
  // (80/443/8443 ⇒ HTTP, sinon TCP). Sert aux tests HTTP sur un port éphémère.
  probeMode?: 'tcp' | 'http';
}

export interface ProbeResult {
  ok: boolean;
  // Message clair à afficher dans l'UI (et dans lastProbeDetail côté Server).
  // Exemples : "TCP 22 : accessible (18 ms)", "HTTP 200 en 45 ms",
  //            "Connexion refusée", "Délai dépassé (5 000 ms)", "Erreur TLS : …"
  detail: string;
  latencyMs?: number;
  httpStatus?: number;
}

export abstract class ProbeTransport {
  abstract probe(target: ProbeTarget): Promise<ProbeResult>;
}

// ── Runtime ───────────────────────────────────────────────────────────
export const PROBE_TIMEOUT_MS = 5_000;

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      finish({ ok: false, detail: `Délai dépassé (${timeoutMs} ms)` });
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      finish({ ok: true, detail: `TCP ${port} : accessible (${ms} ms)`, latencyMs: ms });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = err.code ?? '';
      let detail: string;
      if (code === 'ECONNREFUSED') detail = 'Connexion refusée';
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') detail = 'Hôte introuvable';
      else if (code === 'EHOSTUNREACH') detail = 'Hôte injoignable';
      else if (code === 'ETIMEDOUT') detail = `Délai dépassé (${timeoutMs} ms)`;
      else detail = `TCP : ${err.message}`;
      finish({ ok: false, detail });
    });
    socket.connect({ host, port });
  });
}

function httpProbe(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const isHttps = target.port === 443 || target.port === 8443 || target.strictTls;
  const reqLib = (isHttps ? https : http) as typeof http;
  const href = `${isHttps ? 'https' : 'http'}://${target.host}:${target.port}/`;

  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* noop */
      }
      timer = null;
      finish({ ok: false, detail: `Délai dépassé (${timeoutMs} ms)` });
    }, timeoutMs);

    const urlObj = new URL(href);
    const opts: https.RequestOptions = {
      method: 'GET',
      hostname: urlObj.hostname,
      port: Number(urlObj.port) || (isHttps ? 443 : 80),
      path: '/',
      rejectUnauthorized: !!target.strictTls,
      headers: { 'User-Agent': 'iCodeProbe/1.0' },
    };
    const req = reqLib.request(opts, (res) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const ms = Date.now() - started;
      const status = res.statusCode ?? 0;
      // Toute réponse HTTP = joignable (même 5xx) — le code est la donnée.
      res.resume();
      // Drain puis clore.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        finish({ ok: true, detail: `HTTP ${status} en ${ms} ms`, latencyMs: ms, httpStatus: status });
      };
      res.on('end', settle);
      // Fallback si pas d'événement 'end'.
      setTimeout(settle, 300);
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (done) return;
      const msg = String(err.message ?? (err as { code?: string }).code ?? err);
      // TLS (strict) ⇒ détail TLS.
      if (
        msg.toLowerCase().includes('certificate') ||
        msg.includes('UNABLE_TO_VERIFY') ||
        msg.includes('CERT_HAS_EXPIRED')
      ) {
        finish({ ok: false, detail: `Erreur TLS : ${msg}` });
      } else if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        finish({ ok: false, detail: 'Connexion refusée' });
      } else if ((err as NodeJS.ErrnoException).code === 'ENOTFOUND' || (err as NodeJS.ErrnoException).code === 'EAI_AGAIN') {
        finish({ ok: false, detail: 'Hôte introuvable' });
      } else if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || msg.toLowerCase().includes('timed out')) {
        finish({ ok: false, detail: `Délai dépassé (${timeoutMs} ms)` });
      } else {
        finish({ ok: false, detail: msg });
      }
    });
    req.end();
  });
}

class NodeProbeTransport extends ProbeTransport {
  constructor(private readonly timeoutMs: number) {
    super();
  }

  async probe(target: ProbeTarget): Promise<ProbeResult> {
    // Port 80/443/8443 ⇒ sonde HTTP (la donnée attendue est "est-ce que la page répond ?").
    const isHttp =
      target.probeMode === 'http' ||
      (target.probeMode !== 'tcp' &&
        (target.port === 80 || target.port === 443 || target.port === 8443));
    if (isHttp) {
      return httpProbe(target, this.timeoutMs);
    }
    return tcpProbe(target.host, target.port, this.timeoutMs);
  }
}

@Injectable()
export class ProbeTransportFactory {
  // NOTE (Phase 8): pas de propriété injectée via le constructeur — un paramètre
  // primitif (Number) serait résolu par Nest comme un token DI introuvable et
  // ferait échouer AppModule en entier. Le timeout par défaut vit ici, le test
  // le surcharge précisément via create(timeoutMs).
  create(timeoutMs: number = PROBE_TIMEOUT_MS): ProbeTransport {
    return new NodeProbeTransport(timeoutMs);
  }
}
