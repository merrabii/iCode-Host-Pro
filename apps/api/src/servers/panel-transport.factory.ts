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

/** Info minimale d'un serveur Coolify pour auto-détection du serveur cible. */
export interface CoolifyServerInfo {
  uuid: string;
  name: string;
  ip?: string | null;
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
  /** Réconciliation du port runtime d'un backend servé (COOLIFY) : pose le port
   *  RÉSOLU exposé/routé par le provider (Traefik/Coolify) ET la variable runtime
   *  `PORT` à la MÊME valeur, pour que le process écoute exactement là où le proxy
   *  route. Générique — s'applique à tout backend Node, indépendant du dépôt/build
   *  pack. La valeur `port` DOIT être résolue en amont (source de vérité provider
   *  puis contrat build-pack) : cette méthode ne devine jamais un port. */
  abstract applyNodePort(
    target: PanelTarget,
    uuid: string,
    port: number,
  ): Promise<void>;
  /** Résolution du port EFFECTIVEMENT exposé/routé par le provider pour une app.
   *  Retourne un entier positif si le provider peut le déterminer, sinon `null` —
   *  JAMAIS une valeur inventée. La connaissance de sa propre config reste au
   *  provider/transport : les futurs providers implémentent leur mécanisme.
   *  Coolify 4.1.2 : lit `ports_exposes` (souvent `null` tant que l'image n'a pas
   *  été analysée) ; un multi-port non identifiable → `null` (pas de choix muet). */
  abstract resolveExposedPort(target: PanelTarget, uuid: string): Promise<number | null>;
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
  /** Liste les serveurs Coolify (uuid + nom). Utilisée pour AUTO-DÉTECTER le
   *  serveur cible quand `server.coolifyServerUuid` est vide — au lieu du
   *  fallback « 0 » (serveur localhost par défaut) qui provoquait un 404
   *  « Server not found » sur le panneau réel. Best-effort : un panneau sans
   *  endpoint /servers fiable ou un échec ne bloque jamais le déploiement. */
  abstract listServers(target: PanelTarget): Promise<CoolifyServerInfo[]>;
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

  /**
   * Réconciliation du port runtime (fix GAP PORT, générique — Phase 2026-09-15).
   * Rend un backend servé cohérent sur TOUTE la chaîne en posant la MÊME valeur
   * (le port `port` RÉSOLU — source provider ou contrat build-pack) :
   *   1. le port exposé/routé par le provider (`ports_exposes`, PATCH app) ;
   *   2. la variable RUNTIME `PORT` (convention universelle Node/12-factor).
   * Ainsi le process écoute là où Traefik route — là où Nixpacks pouvait choisir
   * un port « libre » (ex. 5006) divergent de l'exposition réellement servie (8080),
   * causant un 503 « no available server » sur container pourtant running.
   * Endpoints vérifiés contre le serveur réel (Coolify 4.1.2) : PATCH
   * `/applications/:uuid` (ports_exposes) et POST `/applications/:uuid/envs`
   * (is_runtime). IMPORTANT : `port` est TOUJOURS un port résolu en amont — JAMAIS
   * une constante arbitraire (l'Approche A « canonique 3000 » a été rejetée après
   * preuve réelle : ports_exposes=3000 + process 3000 + restart ⇒ 502, car seul le
   * port EXPOSÉ par l'image est routable). Aucun dépôt particulier n'est référencé.
   */
  async applyNodePort(
    target: PanelTarget,
    uuid: string,
    port: number,
  ): Promise<void> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const p = String(port);
    // 1) Port exposé/routé par le provider.
    const patch = await httpJson(
      'PATCH',
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({ ports_exposes: p }),
    );
    if (patch.status !== 200 && patch.status !== 204) {
      throw new Error(
        `Coolify API : port exposé refusé (HTTP ${patch.status})${patch.body ? ` — ${patch.body.slice(0, 200)}` : ''}`,
      );
    }
    // 1bis) Déduplication (idempotence) : supprimer TOUTE variable PORT existante
    //       avant d'en poser UNE seule — jamais de doublon, résultat déterministe.
    const listRes = await httpJson(
      'GET',
      `${base}/applications/${encodeURIComponent(uuid)}/envs`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (listRes.status === 200) {
      let envs: { key?: unknown; uuid?: unknown }[] = [];
      try {
        envs = JSON.parse(listRes.body) as { key?: unknown; uuid?: unknown }[];
      } catch {
        envs = [];
      }
      for (const e of Array.isArray(envs) ? envs : []) {
        if (e && /^PORT$/i.test(String(e.key ?? '')) && typeof e.uuid === 'string') {
          await httpJson(
            'DELETE',
            `${base}/applications/${encodeURIComponent(uuid)}/envs/${encodeURIComponent(e.uuid)}`,
            { Authorization: `Bearer ${target.token}` },
            target.strictTls,
            this.timeoutMs,
          );
        }
      }
    }
    // 2) Variable d'environnement RUNTIME `PORT` (pas build-time) — c'est celle
    //    que lit réellement `process.env.PORT` dans le container.
    const env = await httpJson(
      'POST',
      `${base}/applications/${encodeURIComponent(uuid)}/envs`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
      JSON.stringify({
        key: 'PORT',
        value: p,
        is_preview: false,
        is_buildtime: false,
        is_runtime: true,
        is_literal: true,
      }),
    );
    if (env.status !== 200 && env.status !== 201 && env.status !== 204) {
      throw new Error(
        `Coolify API : variable runtime PORT refusée (HTTP ${env.status})${env.body ? ` — ${env.body.slice(0, 200)}` : ''}`,
      );
    }
  }

  /**
   * Résolution du port exposé/routé par le provider (Coolify 4.1.2).
   * Lit `GET /applications/:uuid → ports_exposes`. Retourne `null` (jamais une
   * invention) si : non-2xx, champ absent/vide/null, invalide, ou multi-port non
   * identifiable (on ne choisit pas silencieusement le premier sans connaître le
   * port HTTP principal). Sur cette version, `ports_exposes` reste souvent `null`
   * tant que l'image n'a pas été analysée → le moteur retombe alors sur le contrat
   * build-pack. La connaissance du port reste la responsabilité du provider.
   */
  async resolveExposedPort(target: PanelTarget, uuid: string): Promise<number | null> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpJson(
      'GET',
      `${base}/applications/${encodeURIComponent(uuid)}`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (status !== 200) return null;
    let parsed: { ports_exposes?: unknown };
    try {
      parsed = JSON.parse(body) as { ports_exposes?: unknown };
    } catch {
      return null;
    }
    const raw = parsed?.ports_exposes;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Multi-port : sans port HTTP principal identifiable, pas de choix muet → null.
    if (parts.length !== 1) return null;
    const n = Number(parts[0]);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
    return n;
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
   * Liste les serveurs Coolify (`GET /servers`) pour AUTO-DÉTECTER le serveur
   * cible. Chaque item expose `uuid` (l'id du serveur), `name`, `ip` (hôtes,
   * vite). Une enveloppe objet `{ data: [...] }` est acceptée comme un tableau
   * nu. Difficile en best-effort : l'appelant (provisioning) se replie sur le
   * défaut « 0 » si la détection échoue — jamais bloquant.
   */
  async listServers(target: PanelTarget): Promise<CoolifyServerInfo[]> {
    this.assertCoolify(target);
    const base = target.baseUrl.replace(/\/+$/, '');
    const { status, body } = await httpGet(
      `${base}/servers`,
      { Authorization: `Bearer ${target.token}` },
      target.strictTls,
      this.timeoutMs,
    );
    if (status !== 200) {
      throw new Error(
        `Coolify API : liste des serveurs refusée (HTTP ${status})${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Coolify API : réponse sans liste de serveurs.');
    }
    let raw = parsed;
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.data)) raw = obj.data;
      else if (Array.isArray(obj.servers)) raw = obj.servers;
    }
    if (!Array.isArray(raw)) {
      throw new Error('Coolify API : réponse sans liste de serveurs.');
    }
    return (raw as unknown[])
      .map((item) => {
        const s = item as { uuid?: unknown; name?: unknown; ip?: unknown };
        return {
          uuid: typeof s.uuid === 'string' ? s.uuid : '',
          name: typeof s.name === 'string' ? s.name : '',
          ip: typeof s.ip === 'string' ? s.ip : null,
        };
      })
      .filter((s) => s.uuid && s.name);
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
