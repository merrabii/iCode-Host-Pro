// Phase 9 (ADR-010) — couture de test pour les adaptateurs de panneau serveur
// (Hestia / Coolify via panelProvider + credentials + vérification d'API).
//
// Le transport réel touche le réseau (HTTP/HTTPS vers l'API du panneau). Pour
// isoler les tests, ServersService dépend de PanelTransportFactory (injectable,
// overridée en e2e comme ProbeTransportFactory/MailTransportFactory) — aucun
// test ne touche jamais le réseau d'un vrai panneau.
import { Injectable } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';

// ── Contrats ──────────────────────────────────────────────────────────

export type PanelKind = 'HESTIA' | 'COOLIFY';

export interface PanelTarget {
  provider: PanelKind;
  baseUrl: string;
  // Jeton/clé d'accès DÉCHIFFRÉ (ServersService décrypte apiTokenEnc au moment
  // de la vérification — jamais transmis, jamais logué).
  token: string;
  // Utilisateur API (Hestia : « api » par défaut ; Coolify : non renseigné).
  user?: string | null;
  strictTls: boolean;
}

export interface PanelVerifyResult {
  ok: boolean;
  // Message clair à afficher dans l'UI (et dans panelDetail côté Server).
  // Exemples : "Coolify API : version 4.0.0-beta (OK, 213 ms)",
  //            "Hestia API : joignable + authentifié (98 ms)",
  //            "Jeton API rejeté (401)", "Connexion refusée", "Délai dépassé (8 000 ms)".
  detail: string;
  latencyMs?: number;
  version?: string;
  // Métriques auto-détectées par le panneau (Phase 9bis), best-effort :
  // Hestia `sysinfo` les expose ; Coolify n'a PAS d'endpoint de métriques fiable
  // => null (l'admin les saisira manuellement sur la carte serveur).
  metrics?: PanelMetrics | null;
}

// Métriques annoncées — toutes optionnelles ; une métrique null/absente n'est
// jamais appliquée par-dessus une valeur saisie manuellement (voir ServersService).
export interface PanelMetrics {
  ramMb?: number; // RAM totale (Mo)
  cpuCores?: number; // nombre de cœurs CPU
  diskGb?: number; // disque total (Go)
}

// ── Phase 10bis (GitHub → Coolify) — opérations de déploiement ───────────────

/** Entrée de création d'une application Coolify depuis un dépôt Git (public).
 *  Phase 10bis.5 : `buildPack` et `appName` sont optionnels — en mode URL collée
 *  le client peut corriger le build pack suggéré (détection) et le nom de l'app ;
 *  en mode GitHub lié les défauts s'appliquent (nixpacks + nom du Service). */
export interface CoolifyGitAppInput {
  repoUrl: string; // ex. https://github.com/owner/repo.git
  branch: string;
  serviceName: string; // nom lisible de l'application (le Service du client)
  buildPack?: string; // nixpacks | dockerfile | dockercompose | static — défaut nixpacks
  appName?: string; // nom de l'application côté Coolify — défaut serviceName
  projectUuid?: string; // projet Coolify cible (uuid) — défaut "0" (projet par défaut)
  serverUuid?: string; // serveur Coolify cible (uuid) — défaut "0" (serveur par défaut)
}

export interface CoolifyGitAppResult {
  uuid: string; // UUID de l'application côté Coolify
}

/** Limites Docker d'une application Coolify (Phase 12) — champs opt. :
 *  `cpus` = limits_cpus (ex "0.5", "1"), `memory` = limits_memory (ex "512m",
 *  "1g"). Appliquées via PATCH /applications/:uuid. */
export interface CoolifyAppLimits {
  cpus?: string;
  memory?: string;
}

/** Formate les cœurs CPU du pack en string Docker Coolify (décimal simple). */
export function cpusFromCores(cpuCores: number): string {
  const n = Math.round(cpuCores * 100) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Formate la RAM (Mo) du pack en string Coolify : "XYm" < 1024, sinon "X.Yg". */
export function memoryFromMb(ramMb: number): string {
  if (ramMb < 1024) return `${Math.round(ramMb)}m`;
  const n = ramMb / 1024;
  return `${Number.isInteger(n) ? n : Math.round(n * 100) / 100}g`;
}

/** Statut brut renvoyé par Coolify (le mapping → DeploymentStatus vit dans
 *  DeploymentsService, testable isolément). `detail` = message d'échec réseau
 *  quand Coolify est injoignable (best-effort, jamais bloquant). */
export interface CoolifyDeploymentStatusResult {
  rawStatus: string;
  detail?: string;
}

export abstract class PanelTransport {
  abstract verify(target: PanelTarget): Promise<PanelVerifyResult>;

  // Phase 10bis — déploiement (COOLIFY uniquement ; Hestia lève une erreur).
  abstract createGitApp(
    target: PanelTarget,
    input: CoolifyGitAppInput,
  ): Promise<CoolifyGitAppResult>;
  abstract deployApp(target: PanelTarget, uuid: string): Promise<void>;
  /** Applique les limites ressources (RAM/CPU) à une application (COOLIFY). */
  abstract applyAppLimits(
    target: PanelTarget,
    uuid: string,
    limits: CoolifyAppLimits,
  ): Promise<void>;
  abstract deploymentStatus(
    target: PanelTarget,
    uuid: string,
  ): Promise<CoolifyDeploymentStatusResult>;
}

// ── Runtime ───────────────────────────────────────────────────────────
export const PANEL_TIMEOUT_MS = 8_000;

// Requête HTTP unique avec timeout ; on collecte le corps texte. Méthode + corps
// JSON optionnels (Phase 10bis : POST des opérations de déploiement Coolify).
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
    const settleOk = (status: number, body: string) => {
      if (settled) return;
      settled = true;
      resolve({ status, body });
    };
    const req = reqLib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        settleOk(status, Buffer.concat(chunks).toString('utf8'));
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

// Requête GET unique avec timeout ; on collecte le corps (JSON pour la version).
function httpGet(
  href: string,
  headers: http.OutgoingHttpHeaders,
  strictTls: boolean,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return httpRequest('GET', href, headers, strictTls, timeoutMs);
}

// Requête avec corps JSON (POST des opérations de déploiement Coolify).
function httpJson(
  method: string,
  href: string,
  headers: http.OutgoingHttpHeaders,
  strictTls: boolean,
  timeoutMs: number,
  body?: string,
): Promise<{ status: number; body: string }> {
  return httpRequest(method, href, { 'Content-Type': 'application/json', ...headers }, strictTls, timeoutMs, body);
}

// Messages d'échec réseau dans la même veine que la sonde (Phase 8).
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

function coolifyVerify(target: PanelTarget, timeoutMs: number): Promise<PanelVerifyResult> {
  const started = Date.now();
  const base = target.baseUrl.replace(/\/+$/, '');
  const href = `${base}/version`;
  return httpGet(href, { Authorization: `Bearer ${target.token}` }, target.strictTls, timeoutMs).then(
    ({ status, body }) => {
      const ms = Date.now() - started;
      if (status === 200) {
        let version: string | undefined;
        try {
          const parsed = JSON.parse(body) as { version?: unknown };
          if (typeof parsed.version === 'string' && parsed.version) version = parsed.version;
        } catch {
          /* corps non JSON */
        }
        // Coolify renvoie parfois la version en texte brut (ex. "4.1.2").
        if (!version && body.trim()) version = body.trim();
        const ver = version ? ` (version ${version})` : '';
        return {
          ok: true,
          detail: `Coolify API : joignable + authentifié${ver} (${ms} ms)`,
          latencyMs: ms,
          version,
          // Coolify n'expose pas de métriques système via l'API publique => l'admin
          // renseigne RAM/CPU/Disque manuellement sur la carte serveur.
          metrics: null,
        };
      }
      if (status === 401 || status === 403) {
        return { ok: false, detail: `Jeton API rejeté (${status})` };
      }
      return { ok: false, detail: `Coolify API : HTTP ${status}` };
    },
    (err) => ({ ok: false, detail: `Coolify API : ${networkDetail(err as NodeJS.ErrnoException, timeoutMs)}` }),
  );
}

// Parse best-effort des métriques depuis la sortie `sysinfo` d'Hestia (Phase
// 9bis). La sortie n'est pas un format stable documenté : on cherche quelques
// patterns courants (/proc/meminfo, « Memory », « cpu cores », « Disk »…) et on
// renvoie null dès qu'aucun ne matche — l'admin saisira alors manuellement.
function parseHestiaMetrics(output: string): PanelMetrics | null {
  try {
    const m: PanelMetrics = {};
    const round = (n: number): number | undefined =>
      Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;

    // RAM : priorité à /proc/meminfo (kB) ; sinon « Memory: X GB ».
    const memKb = output.match(/MemTotal:\s*(\d+)\s*kB/i);
    if (memKb) {
      const mb = Math.round(Number(memKb[1]) / 1024);
      if (mb > 0) m.ramMb = mb;
    } else {
      const memGb = output.match(/Memory\s*(?:total)?[:\s]+([\d.]+)\s*GB/i);
      if (memGb) m.ramMb = round(Number(memGb[1]) * 1024);
    }

    // CPU : « cpu cores : N » (lscpu) ou « Processors : N ».
    const cores = output.match(/cpu cores\s*:?\s*(\d+)/i) ?? output.match(/Processors\s*:?\s*(\d+)/i);
    if (cores) m.cpuCores = Number(cores[1]);

    // Disque total : « Disk: X GB » (rappel : labels libres possibles).
    const diskGb = output.match(/Disk\s*(?:total)?[:\s]+([\d.]+)\s*GB/i);
    if (diskGb) m.diskGb = round(Number(diskGb[1]));

    return m.ramMb || m.cpuCores || m.diskGb ? m : null;
  } catch {
    return null;
  }
}

function hestiaVerify(target: PanelTarget, timeoutMs: number): Promise<PanelVerifyResult> {
  const started = Date.now();
  const base = target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`;
  const href = `${base}?cmd=sysinfo&format=json&returncode=yes`;
  const user = target.user || 'api';
  const basic = Buffer.from(`${user}:${target.token}`).toString('base64');
  return httpGet(href, { Authorization: `Basic ${basic}` }, target.strictTls, timeoutMs).then(
    ({ status, body }) => {
      const ms = Date.now() - started;
      // Hestia renvoie `returncode` dans le corps JSON (quand format=json) et en
      // en-tête Hestia-Api-Returncode. 2xx + JSON lisible = API joignable + token valide.
      if (status === 200 && body) {
        let returncode: string | number | null = null;
        try {
          const parsed = JSON.parse(body) as { returncode?: string | number };
          returncode = parsed.returncode ?? null;
        } catch {
          /* non JSON */
        }
        const fails = returncode !== null && returncode !== 0 && returncode !== '0';
        const metrics = parseHestiaMetrics(body);
        return {
          ok: !fails,
          detail: fails
            ? `Hestia API : commande rejetée (returncode ${returncode})`
            : `Hestia API : joignable + authentifié (${ms} ms)`,
          latencyMs: ms,
          metrics,
        };
      }
      if (status === 401 || status === 403) {
        return { ok: false, detail: `Jeton d'accès rejeté (${status})` };
      }
      return { ok: false, detail: `Hestia API : HTTP ${status}` };
    },
    (err) => ({ ok: false, detail: `Hestia API : ${networkDetail(err as NodeJS.ErrnoException, timeoutMs)}` }),
  );
}

class NodePanelTransport extends PanelTransport {
  constructor(private readonly timeoutMs: number) {
    super();
  }

  async verify(target: PanelTarget): Promise<PanelVerifyResult> {
    if (target.provider === 'COOLIFY') {
      return coolifyVerify(target, this.timeoutMs);
    }
    return hestiaVerify(target, this.timeoutMs);
  }

  // ── Phase 10bis — déploiement GitHub → Coolify ───────────────────────────

  /** Les opérations de déploiement n'existent que pour Coolify (ADR-010). */
  private assertCoolify(target: PanelTarget): void {
    if (target.provider !== 'COOLIFY') {
      throw new Error(
        'Opération de déploiement non disponible pour ce fournisseur de panneau (Coolify uniquement).',
      );
    }
  }

  /**
   * Crée l'application Coolify depuis un dépôt Git public. Endpoint CONFIRMÉ
   * contre le serveur réel (vérification live Phase 10bis, Coolify 4.1.2) :
   * `POST /applications/public` — `/applications/git` n'existe pas sur cette
   * version (404). Body : projet/serveur par défaut (« 0 »), environnement
   * production, build pack nixpacks. NB : Coolify exige un jeton API ROOT pour
   * créer une application — un jeton lecture seule répond 403 « not allowed ».
   */
  async createGitApp(
    target: PanelTarget,
    input: CoolifyGitAppInput,
  ): Promise<CoolifyGitAppResult> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpJson(
      'POST',
      `${base}/applications/public`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({
        project_uuid: input.projectUuid ?? '0', // projet par défaut Coolify sauf si configuré sur le serveur
        server_uuid: input.serverUuid ?? '0', // serveur géré par défaut (localhost) sauf si configuré
        environment_name: 'production',
        git_repository: input.repoUrl,
        git_branch: input.branch,
        name: input.appName ?? input.serviceName,
        build_pack: input.buildPack ?? 'nixpacks',
      }),
    );
    if (status !== 200 && status !== 201) {
      throw new Error(
        `Coolify API : création de l'application refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    let parsed: { uuid?: unknown } = {};
    try {
      parsed = JSON.parse(body) as { uuid?: unknown };
    } catch {
      /* corps non JSON */
    }
    if (typeof parsed.uuid !== 'string' || !parsed.uuid) {
      throw new Error('Coolify API : réponse sans uuid d’application.');
    }
    return { uuid: parsed.uuid };
  }

  /**
   * Applique les limites Docker (RAM/CPU) à une app Coolify (Phase 12) via
   * `PATCH /applications/:uuid` (verbe update Coolify v4) avec `limits_cpus` /
   * `limits_memory`. Seuls les champs fournis sont envoyés. NB : best-effort
   * côté service — l'échec ne doit pas bloquer le déploiement de l'app.
   */
  async applyAppLimits(
    target: PanelTarget,
    uuid: string,
    limits: CoolifyAppLimits,
  ): Promise<void> {
    this.assertCoolify(target);
    const body: Record<string, string> = {};
    if (limits.cpus !== undefined) body.limits_cpus = limits.cpus;
    if (limits.memory !== undefined) body.limits_memory = limits.memory;
    if (Object.keys(body).length === 0) return;
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body: resp } = await httpJson(
      'PATCH',
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify(body),
    );
    if (status !== 200 && status !== 204) {
      throw new Error(
        `Coolify API : application des limites refusée (HTTP ${status})${resp ? ` — ${resp.slice(0, 200)}` : ''}`,
      );
    }
  }

  /** Déclenche un déploiement de l'application Coolify (POST /deploy, vérifié live
   *  4.1.2 — /applications/:uuid/deploy renvoie 404 sur cette version). */
  async deployApp(target: PanelTarget, uuid: string): Promise<void> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpJson(
      'POST',
      `${base}/deploy`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({ uuid, force: true }),
    );
    if (status !== 200 && status !== 201) {
      throw new Error(
        `Coolify API : déclenchement du déploiement refusé (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
  }

  /**
   * État du déploiement (best-effort) : lit le statut de l'APPLICATION Coolify
   * (GET /applications/:uuid → `status`). Le mapping vers notre DeploymentStatus
   * (PENDING/DEPLOYING/ACTIVE/FAILED) est fait dans DeploymentsService. Une
   * erreur réseau ne REJETTE pas : on renvoie un statut « unknown » + détail, le
   * service garde alors l'état courant.
   */
  async deploymentStatus(
    target: PanelTarget,
    uuid: string,
  ): Promise<CoolifyDeploymentStatusResult> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpGet(
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (status !== 200) {
      return { rawStatus: 'unknown', detail: `Coolify API : HTTP ${status}` };
    }
    let parsed: { status?: unknown } = {};
    try {
      parsed = JSON.parse(body) as { status?: unknown };
    } catch {
      /* corps non JSON */
    }
    const raw = typeof parsed.status === 'string' && parsed.status ? parsed.status : 'unknown';
    return {
      rawStatus: raw,
      detail: raw === 'unknown' ? 'Statut Coolify illisible' : undefined,
    };
  }
}

@Injectable()
export class PanelTransportFactory {
  // NOTE (Phase 9): même règle que ProbeTransportFactory (Phase 8) — pas de
  // propriété injectée via le constructeur (un primitif Number serait résolu
  // par Nest comme un token DI introuvable). Le timeout par défaut vit ici.
  create(timeoutMs: number = PANEL_TIMEOUT_MS): PanelTransport {
    return new NodePanelTransport(timeoutMs);
  }
}
