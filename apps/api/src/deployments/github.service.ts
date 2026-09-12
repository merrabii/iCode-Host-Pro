import { BadRequestException, Injectable } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';

export interface GithubRepo {
  fullName: string; // "owner/repo" tel que vu sur GitHub
  defaultBranch: string;
  private: boolean;
  language: string | null;
}

export interface GithubUser {
  login: string;
}

/** Résultat de la détection automatique (Phase 10bis.5) — best-effort, ne
 *  lève JAMAIS : l'utilisateur peut toujours forcer un déploiement en mode URL.
 *  `repoFullName` est l'identité d'affichage (owner/repo sur GitHub, segment(s)
 *  dérivés ailleurs) ; `defaultBranch`/`suggestedBuildPack` préremplissent l'UI
 *  (modifiables par le client). */
export interface DetectResult {
  valid: boolean;
  repoUrl: string; // URL assainie (http/https, fragment retiré)
  repoFullName: string | null;
  defaultBranch: string;
  language: string | null;
  suggestedBuildPack: string;
  detail?: string;
}

/** Build packs que Coolify 4.x sait utiliser pour une app Git (menu web). */
export const BUILD_PACKS = ['nixpacks', 'dockerfile', 'dockercompose', 'static'] as const;

/** Config de build normalisée lue d'un fichier `codediali.toml` / `netlify.toml`
 *  (Phase 16). Pré-remplit la page de build du client et est appliquée à Coolify.
 *  `source` = fichier qui a servi (ou 'none' → la détection auto s'applique). */
export interface BuildConfig {
  pack?: string; // force un build pack (nixpacks|static|dockerfile|dockercompose)
  baseDirectory?: string; // monorepo : sous-dossier racine du build
  buildCommand?: string; // commande de build
  installCommand?: string; // commande d'installation de dépendances
  publishDirectory?: string; // dossier de publication (sortie / statique)
  functionsDirectory?: string; // dossier de fonctions (best-effort, info)
  isStatic?: boolean; // SPA/frontend Vite détecté → servir le build en statique (fix 503)
  environment: Record<string, string>; // variables d'environnement du BUILD
  source: 'codediali.toml' | 'netlify.toml' | 'none';
}

// Plages d'adresses privées/réservées à REFUSER dans une URL git (SSRF léger) :
// un clone d'app ne doit jamais viser l'infrastructure interne (127.x, RFC1918…).
function isPrivateOrReservedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  // IP littérale (IPv4 simple) — toujours refusée (impossible à justifier pour
  // un dépôt public ; le cas légitime interne est hors scope du mode URL).
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.exec(h);
  if (ipv4) {
    const oct = ipv4[0].split('.').map(Number);
    if (oct.some((o) => o > 255)) return true;
    if (oct[0] === 127) return true;
    if (oct[0] === 10) return true;
    if (oct[0] === 192 && oct[1] === 168) return true;
    if (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) return true;
    if (oct[0] === 169 && oct[1] === 254) return true;
    return true; // toute IP littérale est refusée (impossible de vérifier la cible)
  }
  // Hôtes qui commencent par un bloc privé (ex. « 10.0.0.1.nip.io » — edge).
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) {
    return true;
  }
  return false;
}

/**
 * Phase 10bis (M) — détection automatique des dépôts GitHub du client.
 * Le token GitHub est stocké CHIFFRÉ (User.githubTokenEnc, AES-256-GCM via
 * CryptoService) depuis la liaison OAuth (Phase 10) : déchiffré À LA VOLÉE ici,
 * jamais logué, jamais renvoyé. Fetch natif, zéro dépendance (même veine que
 * OAuthService). L'API GitHub ne reçoit que des requêtes authentifiées du token
 * du client — aucun secret de plateforme.
 */
@Injectable()
export class GithubService {
  constructor(private readonly crypto: CryptoService) {}

  /** Déchiffre le token GitHub stocké — 400 clair s'il est absent/illisible. */
  decryptToken(enc: string | null): string {
    if (!enc) {
      throw new BadRequestException(
        'Aucun compte GitHub lié — liez votre compte GitHub depuis votre profil.',
      );
    }
    try {
      return this.crypto.decrypt(enc);
    } catch {
      throw new BadRequestException(
        'Impossible de déchiffrer le jeton GitHub (ENCRYPTION_KEY ?).',
      );
    }
  }

  /** Profil du compte authentifié (best-effort ; login vide si illisible). */
  async fetchUser(token: string): Promise<GithubUser> {
    const data = (await this.get('/user', token)) as { login?: unknown };
    return { login: typeof data.login === 'string' ? data.login : '' };
  }

  /** Repos du compte (publics + privés accessibles au token), triés par activité. */
  async listRepos(token: string): Promise<GithubRepo[]> {
    const data = (await this.get('/user/repos?per_page=100&sort=updated', token)) as Array<{
      full_name?: unknown;
      default_branch?: unknown;
      private?: unknown;
      language?: unknown;
    }>;
    if (!Array.isArray(data)) return [];
    return data
      .map((r) => ({
        fullName: typeof r.full_name === 'string' ? r.full_name : '',
        defaultBranch:
          typeof r.default_branch === 'string' && r.default_branch
            ? r.default_branch
            : 'main',
        private: r.private === true,
        language: typeof r.language === 'string' ? r.language : null,
      }))
      .filter((r) => r.fullName !== '');
  }

  /**
   * Vérifie (best-effort) que le dépôt est bien accessible au compte : 404
   * (absent / transféré / retiré) ou erreur réseau ⇒ false ⇒ refus au déploiement.
   */
  async repoExists(token: string, fullName: string): Promise<boolean> {
    try {
      await this.get(`/repos/${encodeURIComponent(fullName)}`, token);
      return true;
    } catch {
      return false;
    }
  }

  // ── Phase 10bis.5 — mode « coller une URL » (détection auto) ──────────────

  /**
   * Extrait « owner/repo » d'une URL github.com (ou null). Gère le suffixe
   * `.git`, les fragments, et les chemins `/tree/…`, `/blob/…`. Réservé aux URL
   * HTTP(S) — les URL git@…/scp-like ne sont pas acceptées (mode URL = http(s)).
   */
  static parseGithubUrl(url: string): { owner: string; repo: string } | null {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      const segs = u.pathname.split('/').filter(Boolean).map((s) => s.replace(/\.git$/i, ''));
      // chemins acceptés : /owner/repo — /owner/repo/tree/... — /owner/repo/blob/...
      if (segs.length < 2) return null;
      const [owner, repo] = segs;
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
      return { owner, repo };
    } catch {
      return null;
    }
  }

  /**
   * Assainit une URL git collée par le client : trim, protocole http(s)
   * UNIQUEMENT, fragment retiré. Refuse les hôtes privés/réservés (SSRF léger).
   * Lève une 400 lisible si l'URL est invalide/inacceptable.
   */
  static sanitizeGitUrl(input: string): string {
    const raw = String(input ?? '').trim();
    if (!raw) throw new BadRequestException('URL de dépôt manquante.');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BadRequestException("URL de dépôt invalide (format attendu : https://…).");
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException('URL de dépôt invalide : protocole http(s) requis.');
    }
    if (isPrivateOrReservedHost(u.hostname)) {
      throw new BadRequestException(
        'URL de dépôt invalide : l’hôte est réservé/privé (adresse interne refusée).',
      );
    }
    // Fragment retiré, query conservée ? Les URLs git n'ont pas de query utile :
    // on la retire aussi pour un repoUrl propre envoyé à Coolify.
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  }

  /**
   * Détection automatique d'une URL collée (best-effort, ne lève JAMAIS) :
   *  - github.com → GET public SANS token /repos/{owner}/{repo} → default_branch
   *    + language + présence d'un Dockerfile (suggestion build pack) ;
   *  - autre hôte / 404 / erreur réseau → défauts (main / nixpacks).
   * La détection est authentifiée (JwtAuthGuard côté API) ; le quota GitHub
   * unauth (60/h par IP) ne concerne que ce chemin best-effort.
   */
  async detectRepo(url: string): Promise<DetectResult> {
    const repoUrl = GithubService.sanitizeGitUrl(url);
    const parsed = GithubService.parseGithubUrl(repoUrl);
    if (!parsed) {
      return {
        valid: true,
        repoUrl,
        repoFullName: this.deriveRepoFullName(repoUrl),
        defaultBranch: 'main',
        language: null,
        suggestedBuildPack: 'nixpacks',
        detail: 'Hôte non-GitHub : détection limitée — branche main et build pack nixpacks par défaut.',
      };
    }
    try {
      const repo = await this.getPublic<{
        default_branch?: unknown;
        language?: unknown;
      }>(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
      if (!repo) {
        return {
          valid: true,
          repoUrl,
          repoFullName: `${parsed.owner}/${parsed.repo}`,
          defaultBranch: 'main',
          language: null,
          suggestedBuildPack: 'nixpacks',
          detail: 'Dépôt introuvable ou inaccessible (privé ?) — déploiement forcé possible.',
        };
      }
      const language = typeof repo.language === 'string' && repo.language ? repo.language : null;
      const hasDockerfile = await this.hasDockerfile(parsed.owner, parsed.repo);
      return {
        valid: true,
        repoUrl,
        repoFullName: `${parsed.owner}/${parsed.repo}`,
        defaultBranch:
          typeof repo.default_branch === 'string' && repo.default_branch
            ? repo.default_branch
            : 'main',
        language,
        suggestedBuildPack: hasDockerfile ? 'dockerfile' : suggestBuildPack(language),
        detail: hasDockerfile
          ? 'Dockerfile détecté — build pack dockerfile suggéré.'
          : undefined,
      };
    } catch {
      // Erreur réseau / quota : on ne bloque jamais le déploiement.
      return {
        valid: true,
        repoUrl,
        repoFullName: `${parsed.owner}/${parsed.repo}`,
        defaultBranch: 'main',
        language: null,
        suggestedBuildPack: 'nixpacks',
        detail: 'Détection GitHub indisponible (réseau/quota) — défauts appliqués.',
      };
    }
  }

  /** GET public (SANS Authorization) — null sur toute erreur (best-effort). */
  private async getPublic<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'codediali',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** Best-effort : le dépôt contient-il un Dockerfile à la racine ? */
  private async hasDockerfile(owner: string, repo: string): Promise<boolean> {
    const entry = await this.getPublic<unknown>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/Dockerfile`,
    );
    return entry !== null;
  }

  /**
   * Identité d'affichage dérivée d'une URL non-GitHub : les deux derniers
   * segments du chemin (« foo/bar » pour https://gitlab.com/foo/bar), sinon le
   * dernier segment seul. `.git` et le slash final sont retirés.
   */
  deriveRepoFullName(url: string): string | null {
    try {
      const segs = new URL(url)
        .pathname.split('/')
        .filter(Boolean)
        .map((s) => s.replace(/\.git$/i, ''));
      if (segs.length === 0) return null;
      return segs.length >= 2 ? segs.slice(-2).join('/') : segs[0];
    } catch {
      return null;
    }
  }

  // ── Phase 16 — build « file-based » (codediali.toml / netlify.toml) ────────

  /**
   * Config de build normalisée lue d'un fichier de config (Ranking :
   * `codediali.toml` > `netlify.toml` > aucun). Pré-remplit la page de build
   * du client ET est appliquée à Coolify au déploiement pour un build fiable,
   * sans deviner le build pack. Valeurs sanitized (whitelist, bornées) — un
   * fichier n'exécute jamais de code côté serveur.
   */
  async readBuildConfig(
    fullName: string,
    branch: string,
    token?: string | null,
  ): Promise<BuildConfig> {
    const [owner, repo] = fullName.split('/');
    const codediali = await this.fetchRepoFile(owner, repo, 'codediali.toml', branch, token);
    if (codediali !== null) {
      return { ...this.parseBuildContent('codediali.toml', codediali), source: 'codediali.toml' };
    }
    const netlify = await this.fetchRepoFile(owner, repo, 'netlify.toml', branch, token);
    if (netlify !== null) {
      return { ...this.parseBuildContent('netlify.toml', netlify), source: 'netlify.toml' };
    }
    // Fix 503 « no available server » — repo sans fichier de config : détection
    // best-effort d'un SPA Vite (vite.config.* présent, aucun serveur applicatif
    // de production). Le build sort en `dist/` servi statiquement par Coolify
    // (Coolify exige `/dist` avec slash de tête — 422 sinon, cf. voie store).
    if (await this.detectViteSpa(owner, repo, branch, token)) {
      return { environment: {}, source: 'none', publishDirectory: '/dist', isStatic: true };
    }
    return { environment: {}, source: 'none' };
  }

  /**
   * Best-effort : le repo est-il un SPA Vite (frontend statique → `dist/`) ?
   * `true` si un `vite.config.ts|js|mts` existe à la racine ET que le BUILD est
   * un compile statique (`vite build`) sans runtime serveur Node comme point
   * d'entrée. On juge le SERVEUR RÉEL, pas la seule présence d'une dep :
   * un `express:^4` résiduel en `dependencies` (ex. dep d'un ancien server.js
   * supprimé, build = vite build) ne fait PAS un back-end ; en revanche un dépôt
   * au build applicatif (nest build / tsc + un `start` node/tsx) reste non-statique.
   * Ne lit que package.json + fichiers à la racine — aucun code exécuté
   * (JSON.parse d'un package.json, valeurs lues uniquement).
   */
  private async detectViteSpa(
    owner: string,
    repo: string,
    branch: string,
    token?: string | null,
  ): Promise<boolean> {
    const hasViteConfig =
      (await this.fetchRepoFile(owner, repo, 'vite.config.ts', branch, token)) !== null ||
      (await this.fetchRepoFile(owner, repo, 'vite.config.js', branch, token)) !== null ||
      (await this.fetchRepoFile(owner, repo, 'vite.config.mts', branch, token)) !== null;
    if (!hasViteConfig) return false;
    const pkg = await this.fetchRepoFile(owner, repo, 'package.json', branch, token);
    if (pkg === null) return false;
    try {
      const json = JSON.parse(pkg) as {
        dependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      // Un runtime serveur Node comme point d'entrée ⇒ repo applicatif, PAS statique.
      const runScript = [
        json.scripts?.start ?? '',
        json.scripts?.serve ?? '',
        json.scripts?.server ?? '',
        json.scripts?.prod ?? '',
      ]
        .join(' ')
        .trim();
      if (/(^|\s)(node|tsx|ts-node|nodemon|pm2|next|nest)\s/.test(runScript)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Récupère un fichier à la racine du repo (auth si token, sinon public) et
   *  le décode depuis base64. `null` si absent/inaccessible (best-effort). */
  private async fetchRepoFile(
    owner: string,
    repo: string,
    file: string,
    branch: string,
    token?: string | null,
  ): Promise<string | null> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`;
    try {
      const data = token
        ? ((await this.get(path, token)) as { content?: unknown })
        : ((await this.getPublic<{ content?: unknown }>(path)) ?? {});
      if (typeof data.content === 'string') {
        return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      }
      return null;
    } catch {
      return null; // absent, privé sans token, réseau — best-effort
    }
  }

  /** Parse un TOML minimal (sections + clés `key = "value"`) et extrait la
   *  config de build. Jamais de code exécuté — uniquement des chaînes texte. */
  private parseBuildContent(source: string, content: string): Omit<BuildConfig, 'source'> {
    const out: Omit<BuildConfig, 'source'> = { environment: {} };
    let section = '';
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
      if (sectionMatch) {
        section = sectionMatch[1].trim();
        continue;
      }
      const kv = /^([A-Za-z0-9_][\w.-]*)\s*=\s*"(.*)"\s*$/.exec(trimmed);
      if (!kv) continue;
      const key = kv[1];
      const value = kv[2].slice(0, 500); // borné
      if (section === 'build') this.applyBuildKey(out, key, value);
      else if (section === 'build.environment') out.environment![key] = value;
      else if (source === 'netlify.toml' && section === 'functions' && key === 'directory')
        out.functionsDirectory = value;
    }
    return out;
  }

  private applyBuildKey(
    out: Omit<BuildConfig, 'source'>,
    key: string,
    value: string,
  ): void {
    switch (key) {
      case 'pack':
        out.pack = value;
        break;
      case 'base':
        out.baseDirectory = value.replace(/\/+$/, '') || undefined;
        break;
      case 'command':
        out.buildCommand = value;
        break;
      case 'install':
        out.installCommand = value;
        break;
      case 'publish':
        out.publishDirectory = value;
        break;
      case 'functions':
        out.functionsDirectory = value;
        break;
      default:
        break;
    }
  }

  /**
   * Détection « dépôt vide » (Phase 16) : aucune entrée dans `contents/` à la
   * branche (ou réponse « Git Repository is empty »). Best-effort — un repo
   * inaccessible ou une erreur réseau renvoie `false` (on ne bloque pas à tort).
   */
  async isRepoEmpty(token: string, fullName: string, branch: string): Promise<boolean> {
    const [owner, repo] = fullName.split('/');
    try {
      const data = (await this.get(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents?ref=${encodeURIComponent(branch)}`,
        token,
      )) as Array<unknown> | { message?: unknown };
      return Array.isArray(data) && data.length === 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Git Repository is empty|404/i.test(msg)) return true;
      return false;
    }
  }

  private async get(path: string, token: string): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'codediali',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new BadRequestException(`GitHub API (HTTP ${res.status}) : ${text || 'erreur'}`);
    }
    return res.json();
  }
}

/** Langage GitHub → build pack Coolify suggéré (défaut nixpacks, couvre les
 *  langages compilés/interprétés ; un Dockerfile prime via detectRepo). */
export function suggestBuildPack(language: string | null): string {
  if (!language) return 'nixpacks';
  const l = language.toLowerCase();
  if (l === 'dockerfile') return 'dockerfile';
  if (['php', 'python', 'typescript', 'javascript', 'go', 'ruby', 'rust', 'java', 'c', 'c++', 'elixir', 'dart'].includes(l)) {
    return 'nixpacks';
  }
  return 'nixpacks';
}
