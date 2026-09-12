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
  // Publie un SPA buildé (nixpacks) en statique : `publishDirectory` ("/dist")
  // + `isStatic` → Coolify sert la sortie de build (ex. via nginx) au lieu de
  // lancer un serveur node. Sans ça, un repo Vite qui a `express` en dépendance
  // ferait choisir à nixpacks un serveur node au lieu de la statique.
  publishDirectory?: string;
  isStatic?: boolean;
  // Phase 16 — build « file-based » (codediali.toml) : config de build liée au
  // dépôt (base directory monorepo, commande de build, commande d'installation)
  // poussée à Coolify pour un build déterministe. Best-effort côté service : un
  // champ non supporté n'annule pas la création de l'app.
  baseDirectory?: string;
  buildCommand?: string;
  installCommand?: string;
}

export interface CoolifyGitAppResult {
  uuid: string; // UUID de l'application côté Coolify
}

/** Limites Docker d'une application Coolify (Phase 12) — champs opt. :
 *  `cpus` = limits_cpus (ex "0.5", "1"), `memory` = limits_memory (ex "512m",
 *  "1g"). Appliquées en une seule PATCH /applications/:uuid (champs natifs).
 *  NB : le quota disque (Plan.storage_limit) est ENREGISTRÉ sur le pack mais
 *  PAS ENCORE ACTIF — aucun `--storage-opt`/`custom_docker_run_options` n'est
 *  poussé pour l'instant (système de quota prévu après la mise en prod). */
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

// Phase 13 (ADR Module A/B) — projets Coolify (module A = projet partagé).
export interface CoolifyProject {
  uuid: string;
  name: string;
  description?: string | null;
}

export interface CoolifyCreateProjectInput {
  name: string;
  description?: string | null;
  /** uuid du serveur Coolify (Environment.host). Requis par la v4.1 — fallback "0". */
  serverUuid?: string;
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
  /** Applique des variables d'environnement de BUILD à l'app (Phase 16,
   *  best-effort — un échec n'annule pas le déploiement). */
  abstract setAppEnvironment(
    target: PanelTarget,
    uuid: string,
    env: Record<string, string>,
  ): Promise<void>;
  abstract deploymentStatus(
    target: PanelTarget,
    uuid: string,
  ): Promise<CoolifyDeploymentStatusResult>;
  /** Supprime une application Coolify (COOLIFY uniquement) — libère le quota
   *  quand le client supprime son app (Phase 13). Best-effort côté service :
   *  l'échec réseau n'empêche pas la suppression locale. */
  abstract deleteApplication(target: PanelTarget, uuid: string): Promise<void>;

  // Phase 13 — projets Coolify (COOLIFY uniquement).
  abstract listProjects(target: PanelTarget): Promise<CoolifyProject[]>;
  abstract createProject(
    target: PanelTarget,
    input: CoolifyCreateProjectInput,
  ): Promise<{ uuid: string; name: string }>;

  // Store — provision d'un domaine custom sur une app Coolify (Bloc D). Pose
  // le fqdn livré au client comme domaine de l'app ; best-effort côté service.
  abstract setAppDomain(
    target: PanelTarget,
    uuid: string,
    domain: string,
  ): Promise<void>;
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
        // Publie un SPA buildé en statique (nixpacks → dist servi par nginx).
        // Omis si non fourni pour garder le comportement par défaut du build pack.
        ...(input.publishDirectory ? { publish_directory: input.publishDirectory } : {}),
        ...(input.isStatic !== undefined ? { is_static: input.isStatic } : {}),
        // Phase 16 — build file-based : base directory (monorepo), commandes
        // de build/install (Coolify 4.x les accepte à la création).
        ...(input.baseDirectory ? { base_directory: input.baseDirectory } : {}),
        ...(input.buildCommand ? { build_command: input.buildCommand } : {}),
        ...(input.installCommand ? { install_command: input.installCommand } : {}),
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
   * Applique les limites Docker (RAM/CPU) à une app Coolify (Phase 12)
   * via `PATCH /applications/:uuid` (verbe update Coolify v4) avec
   * `limits_cpus` / `limits_memory`. Seuls les champs fournis sont envoyés.
   * NB : best-effort côté service — l'échec ne doit pas bloquer le déploiement.
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

  /**
   * Applique des variables d'environnement de BUILD à une app (Phase 16).
   * Endpoint best-effort (`POST /applications/:uuid/env`) : un échec (endpoint
   * absent sur cette version, 4xx) est remonté mais le service le tape en warn
   * et ne bloque JAMAIS le déploiement — les env non-essentiels ne doivent pas
   * empêcher une app de partir.
   */
  async setAppEnvironment(
    target: PanelTarget,
    uuid: string,
    env: Record<string, string>,
  ): Promise<void> {
    if (!env || Object.keys(env).length === 0) return;
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const entries = Object.entries(env).map(([key, value]) => ({
      key,
      value,
      is_build_time: true,
      is_preview: false,
    }));
    const { status, body } = await httpJson(
      'POST',
      `${base}/applications/${encodeURIComponent(uuid)}/env`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify(entries),
    );
    if (status !== 200 && status !== 201 && status !== 204) {
      throw new Error(
        `Coolify API : variables d'environnement refusées (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
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

  /**
   * Supprime une application Coolify (`DELETE /applications/:uuid`, vérifié
   * live 4.1.2 — renvoie 200 + corps `{"status":"success"}`). La suppression
   * d'une app libère le quota d'apps du pack côté plateforme (maxApps).
   */
  async deleteApplication(target: PanelTarget, uuid: string): Promise<void> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpRequest(
      'DELETE',
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (status !== 200 && status !== 204) {
      throw new Error(
        `Coolify API : suppression de l'application refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
  }

  /**
   * Phase 13 (Module A/B) — liste les projets Coolify (`GET /projects`).
   * NB : Coolify v4 renvoie un TABLEAU NU (`[...]`), pas l'enveloppe `success`.
   * On accepte les deux formes (tableau nu, ou `{ data: [...] }` / `{ projects:
   * [...] }`) pour rester robuste. Chaque item expose `uuid`/`name` — c'est
   * depuis cette liste live que l'admin choisit le projet partagé d'un module A
   * sur la page Packs.
   */
  async listProjects(target: PanelTarget): Promise<CoolifyProject[]> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpGet(
      `${base}/projects`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (status !== 200) {
      throw new Error(
        `Coolify API : liste des projets refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Coolify API : réponse sans liste de projets.');
    }
    // Un tableau JSON nu (containers v4, même vide) est une réponse valide ; une
    // enveloppe objet SANS tableau `data`/`projects` est malformée → rejeter au
    // lieu de renvoyer une liste vide trompeuse.
    let list: unknown[] | null = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.data)) list = obj.data;
      else if (Array.isArray(obj.projects)) list = obj.projects;
    }
    if (list === null) {
      throw new Error('Coolify API : réponse sans liste de projets.');
    }
    return list
      .map((item) => {
        const p = item as { uuid?: unknown; name?: unknown; description?: unknown };
        return {
          uuid: typeof p.uuid === 'string' ? p.uuid : '',
          name: typeof p.name === 'string' ? p.name : '',
          description: typeof p.description === 'string' ? p.description : undefined,
        };
      })
      .filter((p) => p.uuid && p.name);
  }

  /**
   * Phase 13 (Module B) — crée un projet Coolify (`POST /projects`). NB : ce
   * Coolify (v4) n'accepte QUE `name` + `description` — le champ `server_uuid`
   * est REJETÉ (« This field is not allowed. ») et la description tolère peu de
   * ponctuation (pas d'accents), on garde un libellé propre. Un jeton API ROOT
   * est requis ; un jeton lecture seule répond 403.
   */
  async createProject(
    target: PanelTarget,
    input: CoolifyCreateProjectInput,
  ): Promise<{ uuid: string; name: string }> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    // Ne PAS envoyer server_uuid : Coolify v4 le refuse. Description assainie
    // (lettres/chiffres/espaces/punctuation basique uniquement).
    const cleanDescription = (input.description ?? '')
      .replace(/[^A-Za-z0-9 .,_!?'"()+-/@&]/g, ' ')
      .trim()
      .slice(0, 120);
    const { status, body } = await httpJson(
      'POST',
      `${base}/projects`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({
        name: input.name,
        ...(cleanDescription ? { description: cleanDescription } : {}),
      }),
    );
    if (status !== 200 && status !== 201) {
      throw new Error(
        `Coolify API : création du projet refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Coolify API : réponse sans uuid de projet.');
    }
    // Accepte `{ data: { uuid } }`, `{ data: "<uuid>" }` ou `{ uuid }` (v4).
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const inner = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : obj;
    const raw = typeof obj.data === 'string' ? obj.data : inner.uuid;
    const uuid = typeof raw === 'string' ? raw : '';
    if (!uuid) {
      throw new Error('Coolify API : réponse sans uuid de projet.');
    }
    return { uuid, name: input.name };
  }

  /**
   * Store — pose le domaine public de l'app (Bloc D). Coolify v4 :
   * `PATCH /applications/:uuid` body `{ domains: "<fqdn>" }`. Le hostname
   * Coolify (interne) n'est JAMAIS exposé au client — seul le sous-domaine
   * gratuit livré par email est communiqué.
   *
   * NB (vérifié live 4.1.2) : Coolify REJETTE un domaine sans schéma
   * (`422 Invalid URL: <fqdn>`). Il exige `https://<fqdn>` — on normalise ici
   * pour que l'appelant (store) puisse passer le fqdn brut et rester correct.
   */
  async setAppDomain(target: PanelTarget, uuid: string, domain: string): Promise<void> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const clean = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const withScheme = `https://${clean}`;
    const { status, body } = await httpJson(
      'PATCH',
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({ domains: withScheme }),
    );
    if (status !== 200 && status !== 204) {
      throw new Error(
        `Coolify API : affectation du domaine refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
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
