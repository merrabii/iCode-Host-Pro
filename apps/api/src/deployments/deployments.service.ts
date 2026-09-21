import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Deployment,
  DeploymentModule,
  DeploymentModuleKind,
  DeploymentStatus,
  HostingPack,
  LimitsStatus,
  PackStatus,
  Prisma,
  Server,
  ServerPanelProvider,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SecuritySettingsService } from '../auth/security/security-settings.service';
import { Actor } from '../users/users.service';
import {
  CoolifyAppLimits,
  PanelKind,
  PanelTarget,
  PanelTransport,
  PanelTransportFactory,
  cpusFromCores,
  memoryFromMb,
} from '../servers/panel-transport.factory';
import { resolveEffectiveLimits } from './limits.util';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { BuildConfig, DetectResult, GithubRepo, GithubService } from './github.service';

/** Vue masquée d'un déploiement : jamais `coolifyUuid` (infra Coolify, ADR-021 —
 *  le client ne reçoit ni l'UUID d'application ni l'adresse du serveur). */
export type DeploymentView = Omit<Deployment, 'coolifyUuid'> & {
  server?: { id: string; name: string } | null;
};

/** Quota d'apps du pack exposé au client (Phase 13) — le compteur
 *  « N utilisées / M autorisées » du dashboard + les limites RAM/CPU par app.
 *  `maxApps = null` ⇒ illimité. `used` = apps non-FAILED du compte. */
export interface ClientDeployQuota {
  pack: {
    name: string;
    ramMb: number;
    cpuCores: number;
    storageLimit: number | null;
    maxApps: number | null;
  };
  used: number;
}

/** Réponse de listMine (Phase 13) : les déploiements + le quota du pack actif. */
export interface ClientDeploymentsPayload {
  deployments: DeploymentView[];
  quota: ClientDeployQuota | null;
}

type DeploymentWithRefs = Deployment & {
  server?: { id: string; name: string } | null;
};

/** Mapping best-effort du statut brut Coolify vers notre DeploymentStatus.
 *  Exporté pour réutilisation par ProvisioningService (preuve de mise en ligne
 *  avant confirmation d'une commande store). */
export function mapCoolifyStatus(raw: string): DeploymentStatus | null {
  // Phase 17A — mapping déterministe et sans faux ACTIVE. Ordre strict :
  // 1) FAILED d'abord : `crash` (ex « running:crash ») prime sur `running`
  //    et `failed/error/cancelled/canceled` → jamais de faux ACTIVE/FAILED ;
  // 2) ACTIVE : `running`* (avec ou sans suffixe santé) + terminaisons
  //    positives (« finished», « success», « successful», « deployed») ;
  // 3) DEPLOYING : transitions start/déploiement, y compris avec suffixe
  //    santé (« building:healthy », « starting:... ») ;
  // 4) `exited` (avec ou sans suffixe santé) N'EST PAS ACTIVE — un conteneur
  //    arrêté ne peut pas servir l'app (jamais de faux ACTIVE). Fallthrough
  //    → `null` : l'appelant conserve l'état courant (ni ACTIVE, ni FAILED
  //    prématuré pendant une transition Coolify `exited` → `running`).
  // Les espaces périphériques et la casse sont normalisés (déterministe).
  const s = raw.trim().toLowerCase();
  if (['failed', 'error', 'cancelled', 'canceled', 'crash'].some((x) => s.includes(x))) {
    return DeploymentStatus.FAILED;
  }
  if (s.startsWith('running') || ['finished', 'success', 'successful', 'deployed'].includes(s)) {
    return DeploymentStatus.ACTIVE;
  }
  if (['queued', 'in_progress', 'starting', 'building', 'deploying', 'processing', 'pending'].some((x) => s.startsWith(x))) {
    return DeploymentStatus.DEPLOYING;
  }
  return null; // statut inconnu (dont `exited*`) → on garde l'état courant
}

/**
 * Phase 10bis (N) — déploiement GitHub → Coolify, entièrement côté client.
 *
 * Le « serveur Coolify actuellement connecté » est celui que l'admin a affecté
 * au Service ACTIVE du client : `panelProvider=COOLIFY` + `panelOk=true`
 * (vérifié via POST /api/servers/:id/panel-verify). Le jeton API du panneau est
 * déchiffré À LA VOLÉE (jamais exposé) ; le token GitHub du client aussi. La
 * propriété est imposée partout (where userId ⇒ 404 pour autrui) ; l'impersonation
 * est bloquée par JwtAuthGuard sur tous les verbes mutants.
 */
@Injectable()
export class DeploymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SecuritySettingsService,
    private readonly crypto: CryptoService,
    private readonly github: GithubService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly cloudflare: CloudflareService,
  ) {}

  private async requireDeployEnabled(): Promise<void> {
    if (!(await this.settings.isDeployEnabled())) {
      throw new ForbiddenException('Les déploiements GitHub → Coolify sont désactivés.');
    }
  }

  private async requireGithubToken(actor: Actor): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.sub } });
    return this.github.decryptToken(user?.githubTokenEnc ?? null);
  }

  /** Token GitHub du compte, ou null (mode URL / compte non lié) — pour la
   *  lecture de codediali.toml et la détection repo vide. Best-effort. */
  private async tryGithubToken(actor: Actor): Promise<string | null> {
    try {
      return await this.requireGithubToken(actor);
    } catch {
      return null;
    }
  }

  /** Fusionne la config de build : les valeurs explicites du client (page de
   *  build) PRIMENT sur celles lues du fichier codediali.toml/netlify.toml. */
  private resolveBuildConnection(
    dto: CreateDeploymentDto,
    fromFile: BuildConfig | null,
  ): {
    baseDirectory?: string;
    buildCommand?: string;
    installCommand?: string;
    publishDirectory?: string;
    functionsDirectory?: string;
    isStatic?: boolean;
    environment: Record<string, string>;
  } {
    const t = (v: string | undefined): string | undefined =>
      v && v.trim() ? v.trim().slice(0, 1000) : undefined;
    const env: Record<string, string> = {};
    if (dto.environment) {
      for (const [k, v] of Object.entries(dto.environment)) {
        const key = k.trim().slice(0, 200);
        if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(v).slice(0, 4000);
      }
    } else if (fromFile) {
      Object.assign(env, fromFile.environment);
    }
    // Fix 503 « no available server » — SPA Vite détecté : on sert le build en
    // `dist/` statique (forcé, quel que soit le dossier demandé).
    const isStatic = fromFile?.isStatic === true;
    return {
      baseDirectory: t(dto.baseDirectory ?? fromFile?.baseDirectory),
      buildCommand: t(dto.buildCommand ?? fromFile?.buildCommand),
      installCommand: t(dto.installCommand ?? fromFile?.installCommand),
      publishDirectory: isStatic ? '/dist' : t(dto.publishDirectory ?? fromFile?.publishDirectory),
      functionsDirectory: t(dto.functionsDirectory ?? fromFile?.functionsDirectory),
      environment: env,
      isStatic: isStatic || undefined,
    };
  }

  /**
   * Phase 16 — prévisualisation de la config de build d'un dépôt GitHub (page
   * « Créer un nouveau Projet » du client) : lit codediali.toml/netlify.toml
   * (ou détection) et renvoie la config pré-remplie — jamais le contenu brut.
   */
  async previewBuildConfig(fullName: string, branch: string | undefined, actor: Actor): Promise<BuildConfig> {
    await this.requireDeployEnabled();
    const token = await this.tryGithubToken(actor);
    return this.github.readBuildConfig(fullName, branch ?? 'main', token);
  }

  /** Détection « dépôt vide » (message Netlify-style au client). */
  async checkRepoEmpty(fullName: string, branch: string | undefined, actor: Actor): Promise<{ empty: boolean }> {
    await this.requireDeployEnabled();
    const token = await this.requireGithubToken(actor);
    return { empty: await this.github.isRepoEmpty(token, fullName, branch ?? 'main') };
  }

  // ── Domaine gratuit au choix (racine des sous-domaines) ────────────────────

  /** Racines gratuites proposables au client : celles autorisées par la règle
   *  FreeSubdomainRule de son pack/produit ACTIF, sinon toutes les réactives. */
  async listFreeDomains(actor: Actor): Promise<Array<{ id: string; name: string }>> {
    const allowed = await this.memberFreeDomainIds(actor.sub);
    const domains = await this.cloudflare.findMemberFreeDomains(allowed);
    return domains.map((d) => ({ id: d.id, name: d.name }));
  }

  /** `allowedDomainIds` de la règle gratuite du produit ACTIF du membre, ou null. */
  private async memberFreeDomainIds(userId: string): Promise<string[] | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      select: { product: { select: { freeSubdomainRule: { select: { allowedDomainIds: true } } } } },
    });
    return subscription?.product?.freeSubdomainRule?.allowedDomainIds ?? null;
  }

  /** Un domaine choisi est-il offert au membre ? Vrai si aucune liste blanche
   *  n'est posée, sinon si la liste contient `chosen.id`. Best-effort : un
   *  domaine non éligible est ignoré et on revient à la racine par défaut. */
  private async allowClientDomain(userId: string, chosen: { id: string }): Promise<boolean> {
    const allowed = await this.memberFreeDomainIds(userId);
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(chosen.id);
  }

  private toView(d: DeploymentWithRefs): DeploymentView {
    const { coolifyUuid, ...rest } = d;
    return rest as DeploymentView;
  }

  // ── GitHub (M) ─────────────────────────────────────────────────────────────

  /** Repos du client (autodétectés via l'API GitHub de son compte lié). */
  async listRepos(actor: Actor): Promise<GithubRepo[]> {
    await this.requireDeployEnabled();
    const token = await this.requireGithubToken(actor);
    return this.github.listRepos(token);
  }

  /**
   * Détection automatique d'une URL de dépôt collée (Phase 10bis.5) — AUCUNE
   * liaison GitHub requise, aucun token. Best-effort (ne lève jamais sur la
   * détection) ; seul `deployEnabled` est vérifié.
   */
  async detect(actor: Actor, url: string): Promise<DetectResult> {
    await this.requireDeployEnabled();
    return this.github.detectRepo(url);
  }

  /** État de la liaison GitHub — renvoie aussi quand absente (jamais le token). */
  async linkStatus(actor: Actor): Promise<{ linked: boolean; login: string | null }> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.sub } });
    if (!user?.githubTokenEnc) return { linked: false, login: null };
    try {
      const token = this.crypto.decrypt(user.githubTokenEnc);
      const me = await this.github.fetchUser(token);
      return { linked: true, login: me.login || null };
    } catch {
      return { linked: true, login: null }; // token présent mais GitHub injoignable
    }
  }

  // ── Déploiement (N) ────────────────────────────────────────────────────────

  /**
   * Flow : deployEnabled ? + (mode GitHub lié : token + dépôt possédé | mode
   * URL collée : URL assainie + détection auto) + Service ACTIVE du client sur
   * un serveur Coolify connecté ⇒ crée l'app Coolify → déclenche le déploiement
   * → ligne Deployment (DEPLOYING). Toute erreur Coolify laisse une ligne FAILED
   * + audit, et remonte en 502 (message clair à l'UI).
   */
  async create(dto: CreateDeploymentDto, actor: Actor): Promise<DeploymentView> {
    await this.requireDeployEnabled();
    if (dto.repoUrl && dto.repoFullName) {
      throw new BadRequestException(
        'Choisissez un seul mode : dépôt GitHub lié (repoFullName) OU URL collée (repoUrl).',
      );
    }

    // ── Résolution du dépôt : mode GitHub lié (token + propriété) ou URL. ─────
    let repoUrl: string;
    let repoFullName: string;
    let suggestedBuildPack: string | undefined;
    let detectedBranch: string | undefined;
    if (dto.repoUrl) {
      // Mode URL (10bis.5) : AUCUN token GitHub requis — détection best-effort.
      const detected = await this.github.detectRepo(dto.repoUrl);
      repoUrl = detected.repoUrl;
      repoFullName = detected.repoFullName ?? this.github.deriveRepoFullName(repoUrl) ?? 'depot';
      detectedBranch = detected.defaultBranch;
      suggestedBuildPack = detected.suggestedBuildPack;
    } else {
      // Mode GitHub lié : token + propriété du dépôt re-vérifiée à la volée.
      const githubToken = await this.requireGithubToken(actor);
      repoFullName = dto.repoFullName!;
      if (!(await this.github.repoExists(githubToken, repoFullName))) {
        throw new BadRequestException('Dépôt GitHub inaccessible ou non possédé.');
      }
      repoUrl = `https://github.com/${repoFullName}.git`;
    }

    // Phase 13 — cible résolue depuis le pack ACTIF → module A/B quand aucun
    // Service n'est choisi ; un `serviceId` fourni honore le comportement
    // historique (serveur du Service + pack de son abonnement).
    const { server, pack, module, projectUuid, clientProjectId } =
      await this.resolveDeployTarget(actor.sub);
    // Phase 17 (3d) — quota PAR PACK (jamais fusionné entre packs d'un même
    // client). Compte et somme les ressources des apps du client rattachées à CE
    // pack précis, compare au budget dérivé du pack (limite par app × maxApps),
    // et refuse la création si elle dépasserait. Appliqué AVANT toute création
    // côté Coolify.
    await this.assertUnderPackQuota(actor.sub, pack, module);

    const branch = dto.branch?.trim() ? dto.branch.trim() : (detectedBranch ?? 'main');

    // Phase 16 — build « file-based » : on PRÉFÈRE les valeurs explicites du
    // client (page de build), sinon les valeurs lues de codediali.toml /
    // netlify.toml (best-effort), sinon la détection auto existante. Le serveur
    // re-sane et borne : un fichier malformé ne casse jamais le déploiement.
    const buildFromFile = await this.github
      .readBuildConfig(repoFullName, branch, dto.repoUrl ? null : await this.tryGithubToken(actor))
      .catch(() => null);
    const conn = this.resolveBuildConnection(dto, buildFromFile);
    // Fix 503 « no available server » — SPA Vite. On NE force PAS build_pack
    // "static" : le pack static de Coolify NE BUILDE pas (clone frais ⇒ dist
    // absent ⇒ sert la racine source ⇒ page vide). Recette validée voie store :
    // garder le build stack (nixpacks → produit dist/) et poser isStatic + /dist
    // pour que Coolify serve la sortie de build statiquement (port 80).
    const packed = dto.buildPack ?? buildFromFile?.pack ?? suggestedBuildPack ?? 'nixpacks';
    const appName = dto.appName?.trim()
      ? dto.appName.trim()
      : (repoFullName.split('/')[1] ?? 'mon-app');
    const target = this.buildTarget(server);
    const transport = this.panelFactory.create();

    const row = await this.prisma.deployment.create({
      data: {
        userId: actor.sub,
        serverId: server.id,
        repoFullName,
        repoUrl: dto.repoUrl ? repoUrl : null,
        buildPack: packed,
        appName,
        branch,
        status: DeploymentStatus.PENDING,
        // Phase 16 — build file-based persisté pour un re-déploiement déterministe.
        baseDirectory: conn.baseDirectory,
        buildCommand: conn.buildCommand,
        installCommand: conn.installCommand,
        publishDirectory: conn.publishDirectory,
        functionsDirectory: conn.functionsDirectory,
        environment: Object.keys(conn.environment).length ? conn.environment : Prisma.JsonNull,
        // Phase 13 — traçabilité du projet/module qui héberge l'app.
        coolifyProjectUuid: projectUuid,
        moduleId: module?.id ?? null,
        clientProjectId: clientProjectId ?? null,
        // Phase 17 (3c/3d) — pack à l'origine de la création (quota per-pack + tracking).
        packId: pack?.id ?? null,
      },
    });

    try {
      const app = await transport.createGitApp(target, {
        repoUrl,
        branch,
        serviceName: appName,
        buildPack: packed,
        appName,
        projectUuid: projectUuid ?? server.coolifyProjectUuid ?? undefined,
        serverUuid: await this.resolveCoolifyServerUuid(server, transport),
        // Phase 16 — build file-based (base directory, commandes).
        publishDirectory: conn.publishDirectory,
        baseDirectory: conn.baseDirectory,
        buildCommand: conn.buildCommand,
        installCommand: conn.installCommand,
        // Fix 503 — SPA Vite : transmet is_static:true à Coolify.
        isStatic: conn.isStatic,
      });
      // Phase 16 — variables d'environnement de BUILD (best-effort : un échec
      // est tracé en warn et n'annule jamais le déploiement).
      if (Object.keys(conn.environment).length) {
        try {
          await transport.setAppEnvironment(target, app.uuid, conn.environment);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.env.warn',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, message: m },
          });
        }
      }
      // Phase 12/13 — applique les limites RAM/CPU du pack (overrides du module
      // prioritaires) AVANT de lancer le déploiement. Phase 17 (décision #2, 3c) :
      // BEST-EFFORT — un échec d'applyAppLimits ne bloque JAMAIS le déploiement de
      // l'app cliente (l'app est déployée quand même), mais il n'est plus silencieux :
      // on trace limitsStatus=FAILED + message, visible au monitoring admin, et
      // re-applicable manuellement. Le quota disque reste enregistré, non appliqué.
      const eff = resolveEffectiveLimits(pack, module);
      let deployDetail = 'Déploiement déclenché sur Coolify.';
      if (eff) {
        const limits = eff.limits;
        let limitsStatus: LimitsStatus = LimitsStatus.APPLIED;
        let limitsLastError: string | null = null;
        try {
          await transport.applyAppLimits(target, app.uuid, limits);
          deployDetail = `Déploiement déclenché — limites appliquées (${limits.memory ?? ''} RAM${limits.cpus ? `, ${limits.cpus} CPU` : ''}).`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.limits',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, ...limits, packName: pack?.name },
          });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          limitsStatus = LimitsStatus.FAILED;
          limitsLastError = m;
          deployDetail = `Déploiement déclenché — AVERTISSEMENT : limites non appliquées (${m}).`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.limits.failed',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, ...limits, packName: pack?.name, message: m },
          });
        }
        // Suivi persistant (3c) — statut + valeurs effectives pour la re-application.
        await this.prisma.deployment.update({
          where: { id: row.id },
          data: {
            limitsStatus,
            limitsRamMb: eff.ramMb,
            limitsCpu: eff.cpuCores,
            limitsLastError,
          },
        });
      }
      // Phase 3 — sous-domaine gratuit (CNAME → hostname Coolify) via Cloudflare,
      // APRÈS les limites et AVANT le run. Best-effort comme les limites : un
      // échec (sous-domaine pris, DNS indisponible…) n'interrompt pas le déploiement.
      let dns: { subdomain?: string; fqdn?: string; domainId?: string } = {};
      // Racine gratuite du sous-domaine : par défaut celle configurée ; sinon le
      // domaine choisi par le client (s'il est ACTIVE et offert à son pack).
      let root = await this.cloudflare.findActiveRootDomain();
      if (dto.domainId) {
        const chosen = await this.cloudflare.findActiveRootById(dto.domainId);
        if (chosen && (await this.allowClientDomain(actor.sub, chosen))) root = chosen;
      }
      if (root) {
        try {
          const alloc = await this.cloudflare.allocateClientSubdomain({
            root,
            requested: dto.subdomain,
            seed: appName || 'app',
            fallbackHost: server.hostname,
            deploymentId: row.id,
          });
          dns = { subdomain: alloc.subdomain, fqdn: alloc.fqdn, domainId: root.id };
          deployDetail += ` App : https://${alloc.fqdn}.`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.domain',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, subdomain: alloc.subdomain, fqdn: alloc.fqdn, root: root.name },
          });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          deployDetail += ` (DNS : ${m})`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.domain.warn',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, requested: dto.subdomain, root: root.name, message: m },
          });
        }
      }
      // Phase 16 (validé en réel) — pose le fqdn alloué comme domaine de l'app
      // Coolify. Sans cela l'app ne répond que sur son sslip.io par défaut et le
      // sous-domaine public (CNAME Cloudflare) renvoie 503 « no available server ».
      // Best-effort, comme dans la voie store (provisioning.actionCreateApp).
      if (dns.fqdn) {
        try {
          await transport.setAppDomain(target, app.uuid, dns.fqdn);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          deployDetail += ` (domaine app : ${m})`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.domain.app.warn',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, fqdn: dns.fqdn, message: m },
          });
        }
      }
      await transport.deployApp(target, app.uuid);
      const updated = await this.prisma.deployment.update({
        where: { id: row.id },
        data: {
          coolifyUuid: app.uuid,
          status: DeploymentStatus.DEPLOYING,
          detail: deployDetail,
          ...dns,
        },
        include: {
          server: { select: { id: true, name: true } },
        },
      });
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'deploy.create',
        resourceType: 'deployment',
        resourceId: row.id,
        details: {
          repoFullName,
          branch,
          buildPack: packed,
          appName,
          mode: dto.repoUrl ? 'url' : 'github',
          serverId: server.id,
          coolifyUuid: app.uuid,
          moduleId: module?.id ?? null,
          projectUuid: projectUuid ?? null,
        },
      });
      return this.toView(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.prisma.deployment.update({
        where: { id: row.id },
        data: { status: DeploymentStatus.FAILED, detail: message },
      });
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'deploy.failed',
        resourceType: 'deployment',
        resourceId: row.id,
        details: { repoFullName, branch, buildPack: packed, appName, message },
      });
      throw new BadGatewayException(`Échec du déploiement : ${message}`);
    }
  }

  /** Les déploiements du client (service + nom de serveur inclus) + le quota
   *  d'apps du pack ACTIF (Phase 13) pour le compteur du dashboard. */
  async listMine(actor: Actor): Promise<ClientDeploymentsPayload> {
    const rows = await this.prisma.deployment.findMany({
      where: { userId: actor.sub },
      include: {
        server: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Réconcilie LIVE les apps encore « en cours » : une app créée via la voie
    // STORE reste posée en DEPLOYING dans la BD jusqu'à ce qu'on interroge
    // Coolify (le build prend plusieurs minutes). Même comportement que
    // findMine : on re-sonde l'état réel et on bascule ACTIVE/FAILED, pour que
    // la liste du dashboard reflète la réalité sans qu'il faille ouvrir chaque
    // app. Best-effort — Coolify injoignable ⇒ état courant conservé.
    const latest = await Promise.all(
      rows.map((r) =>
        r.status === DeploymentStatus.DEPLOYING && r.coolifyUuid && r.serverId
          ? this.refreshStatus(r, actor)
          : Promise.resolve(r),
      ),
    );
    const quota = await this.resolveQuota(actor.sub);
    return { deployments: latest.map((r) => this.toView(r)), quota };
  }

  /** Quota d'apps du pack ACTIF du compte : `{ pack, used }`, ou null si aucun
   *  pack/module n'est actif (pas de quota à afficher). `used` = apps non-FAILED,
   *  exactement le même décompte que l'enforcement `maxApps` de create(). */
  private async resolveQuota(userId: string): Promise<ClientDeployQuota | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      include: { product: { include: { pack: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const pack = subscription?.product?.pack ?? null;
    if (!pack || pack.status !== PackStatus.ACTIVE) return null;
    const used = await this.prisma.deployment.count({
      where: { userId, status: { not: DeploymentStatus.FAILED } },
    });
    return {
      pack: {
        name: pack.name,
        ramMb: pack.ramMb,
        cpuCores: pack.cpuCores,
        storageLimit: pack.storageLimit,
        maxApps: pack.maxApps,
      },
      used,
    };
  }

  /**
   * Un déploiement DU client (404 sinon), rafraîchi live : s'il est DEPLOYING,
   * on re-sonde l'état de l'application sur Coolify et on bascule ACTIVE/FAILED
   * si l'état a changé (audit `deploy.status`). Best-effort : Coolify injoignable
   * ⇒ on renvoie l'état courant.
   */
  async findMine(id: string, actor: Actor): Promise<DeploymentView> {
    const row = await this.prisma.deployment.findFirst({
      where: { id, userId: actor.sub },
      include: {
        server: { select: { id: true, name: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Déploiement introuvable.');
    }
    if (row.status === DeploymentStatus.DEPLOYING && row.coolifyUuid && row.serverId) {
      return this.toView(await this.refreshStatus(row, actor));
    }
    return this.toView(row);
  }

  /**
   * Supprime une app du client (Phase 13 — libère le quota maxApps pour en
   * recréer une autre) : best-effort sur Coolify (DELETE de l'application) et
   * sur Cloudflare (suppression du CNAME du sous-domaine), puis suppression
   * des rows ClientSubdomain + Deployment. Un échec réseau ne bloque JAMAIS
   * la suppression locale : l'app peut rester orpheline sur Coolify mais le
   * quota du compte est libéré immédiatement (audit `*.warn` pour le support).
   */
  async remove(id: string, actor: Actor): Promise<{ removed: true; appName: string | null }> {
    const row = await this.prisma.deployment.findFirst({
      where: { id, userId: actor.sub },
      include: { server: true, clientSubdomain: { include: { domain: true } } },
    });
    if (!row) {
      throw new NotFoundException('Déploiement introuvable.');
    }

    // 1. Coolify — suppression de l'application (best-effort).
    if (
      row.coolifyUuid &&
      row.server &&
      row.server.panelProvider === ServerPanelProvider.COOLIFY &&
      row.server.apiBaseUrl &&
      row.server.apiTokenEnc
    ) {
      try {
        await this.panelFactory
          .create()
          .deleteApplication(this.buildTarget(row.server), row.coolifyUuid);
        await this.audit.record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'deploy.delete.coolify',
          resourceType: 'deployment',
          resourceId: id,
          details: { coolifyUuid: row.coolifyUuid, appName: row.appName },
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        await this.audit.record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'deploy.delete.coolify.warn',
          resourceType: 'deployment',
          resourceId: id,
          details: { coolifyUuid: row.coolifyUuid, message: m },
        });
      }
    }

    // 2. Cloudflare — suppression de l'enregistrement DNS du sous-domaine
    //    (best-effort ; recordId peut manquer si la création DNS avait échoué).
    const cs = row.clientSubdomain;
    if (cs?.recordId && cs.domainId) {
      try {
        await this.cloudflare.deleteDnsRecord(cs.domainId, cs.recordId, actor);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        await this.audit.record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'deploy.delete.dns.warn',
          resourceType: 'deployment',
          resourceId: id,
          details: { fqdn: cs.fqdn, message: m },
        });
      }
    }

    // 3. Rows locales (ordre respectant les FK : sous-domaine → déploiement).
    await this.prisma.$transaction(async (tx) => {
      await tx.clientSubdomain.deleteMany({ where: { deploymentId: id } });
      await tx.deployment.delete({ where: { id } });
    });

    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'deploy.delete',
      resourceType: 'deployment',
      resourceId: id,
      details: {
        appName: row.appName,
        repoFullName: row.repoFullName,
        hadCoolifyApp: Boolean(row.coolifyUuid),
        hadSubdomain: Boolean(cs),
        freedQuota: true,
      },
    });
    return { removed: true, appName: row.appName };
  }

  // ── Internes ───────────────────────────────────────────────────────────────

  /**
   * Phase 13 (Bloc 4) — cible de déploiement : la table `Service` a été
   * supprimée, la cible est TOUJOURS résolue depuis le pack ACTIF du client
   * (abonnement ACTIVE → produit → pack) → module de déploiement A/B.
   * Le projet Coolify est ensuite déduit du module (A = projet partagé configuré ;
   * B = projet dédié du client, créé paresseusement à la première app).
   */
  private async resolveDeployTarget(
    userId: string,
  ): Promise<{
    server: Server;
    pack: HostingPack | null;
    module: DeploymentModule | null;
    projectUuid?: string;
    clientProjectId?: string;
  }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      include: {
        product: {
          include: { pack: { include: { deploymentModule: { include: { server: true } } } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const pack = subscription?.product?.pack ?? null;
    if (!pack || pack.status !== PackStatus.ACTIVE) {
      throw new ForbiddenException(
        "Aucun pack d'hébergement actif : impossible de déployer.",
      );
    }
    const module = pack.deploymentModule ?? (await this.findDefaultModule());
    if (!module) {
      throw new BadRequestException(
        "Déploiement non configuré pour votre pack (aucun module de déploiement). Contactez l'équipe support.",
      );
    }
    if (module.isActive !== true) {
      throw new BadRequestException(
        'Le module de déploiement de votre pack est désactivé. Contactez le support.',
      );
    }
    const server = this.requireCoolifyServer(module.server);
    const project = await this.resolveProject(module, server, userId);
    return { server, pack, module, ...project };
  }

  /** Vérifie que le serveur est Coolify + connecté (panelOk + credentials). */
  private requireCoolifyServer(server: Server | null | undefined): Server {
    if (!server || server.panelProvider !== ServerPanelProvider.COOLIFY) {
      throw new BadRequestException(
        'Le serveur Coolify de cette cible n’est pas configuré.',
      );
    }
    if (server.panelOk !== true || !server.apiBaseUrl || !server.apiTokenEnc) {
      throw new BadRequestException(
        'Le serveur Coolify de cette cible n’est pas connecté (vérification API en échec).',
      );
    }
    return server;
  }

  /** Module actif « par défaut » — fallback quand le pack n'a pas de module lié. */
  private async findDefaultModule(): Promise<(DeploymentModule & { server: Server | null }) | null> {
    return this.prisma.deploymentModule.findFirst({
      where: { isActive: true },
      include: { server: true },
      orderBy: [{ code: 'asc' }],
    });
  }

  /** Résout le projet Coolify du module (A partagé / B client dédié). */
  private async resolveProject(
    module: DeploymentModule | null,
    server: Server,
    userId: string,
  ): Promise<{ projectUuid?: string; clientProjectId?: string }> {
    if (!module) {
      // Aucun module configuré → comportement historique : projet du serveur.
      return { projectUuid: server.coolifyProjectUuid ?? undefined };
    }
    if (module.kind === DeploymentModuleKind.SHARED_PROJECT) {
      if (!module.sharedProjectUuid) {
        throw new BadRequestException(
          "Le module partagé n'a pas de projet Coolify configuré (page Packs).",
        );
      }
      return { projectUuid: module.sharedProjectUuid };
    }
    // Module B — projet Coolify dédié du client, créé à la première app.
    const cp = await this.getOrCreateClientProject(userId, server, module);
    return { projectUuid: cp.projectUuid, clientProjectId: cp.id };
  }

  /**
   * Projet Coolify dédié du client (Module B) : UN SEUL par (client, serveur),
   * quel que soit le module de déploiement B. Existant → renvoyé tel quel (la
   * 2ème app du client réutilise, elle ne recrée jamais un projet) ; sinon créé
   * paresseusement sur Coolify (`POST /projects`, idempotent via @@unique) puis
   * persisté. Nom = `<perClientPrefix>-<id client>` — retrouvable par le support.
   * Le module est passé pour le préfixe du nom + trace, mais la clé de dédup
   * ignore `moduleId` (projet dédié client, pas par module).
   * Exposed for admin create-client-project endpoint (UsersService).
   */
  async getOrCreateClientProject(
    userId: string,
    server: Server,
    module: DeploymentModule | null,
  ): Promise<{ id: string; projectUuid: string }> {
    const key = { userId, serverId: server.id };
    const existing = await this.prisma.clientProject.findUnique({
      where: { userId_serverId: key },
    });
    if (existing) return { id: existing.id, projectUuid: existing.projectUuid };

    const name = module ? `${module.perClientPrefix}-${userId}` : `client-${userId}`;
    const created = await this.panelFactory
      .create()
      .createProject(this.buildTarget(server), {
        name,
        description: 'Projet Coolify dédié du client (Module B).',
        serverUuid: server.coolifyServerUuid ?? '0',
      });
    try {
      const row = await this.prisma.clientProject.create({
        data: { ...key, moduleId: module?.id ?? null, name, projectUuid: created.uuid },
      });
      return { id: row.id, projectUuid: row.projectUuid };
    } catch (err) {
      // Course concurrente : le projet a été persisté entre-temps → on reprend
      // la ligne existante (P2002 = violation de la contrainte unique).
      if ((err as { code?: string }).code === 'P2002') {
        const row = await this.prisma.clientProject.findUnique({
          where: { userId_serverId: key },
        });
        if (row) return { id: row.id, projectUuid: row.projectUuid };
      }
      throw err;
    }
  }

  /** Limites Coolify dérivées d'un pack ACTIVE (RAM/CPU). null = rien à appliquer.
   *  Phase 13 : les overrides du module (`overrideRamMb`/`overrideCpuCores`)
   *  priment sur le pack. Le quota disque (Plan.storage_limit, y compris
   *  `overrideStorageLimit`) reste enregistré mais NON appliqué — système de
   *  quota prévu après la mise en prod. */
  private packLimits(pack: HostingPack | null, module?: DeploymentModule | null): CoolifyAppLimits | null {
    if (!pack || pack.status !== PackStatus.ACTIVE) return null;
    return resolveEffectiveLimits(pack, module)?.limits ?? null;
  }

  /**
   * Phase 17 (3d) — QUOTA PAR PACK, jamais fusionné entre packs d'un même client.
   * Compte et somme les ressources des apps du client rattachées à CE pack précis
   * (packId), compare au budget DÉRIVÉ du pack (limite effective par app × maxApps),
   * et refuse la création si elle dépasserait le quota d'apps OU les ressources
   * du pack. Appelé AVANT toute création côté Coolify.
   */
  private async assertUnderPackQuota(
    userId: string,
    pack: HostingPack | null,
    module?: DeploymentModule | null,
  ): Promise<void> {
    if (!pack) return;
    const eff = resolveEffectiveLimits(pack, module);
    // Apps du client qui appartiennent à CE pack précis (jamais d'autres packs).
    const deps = await this.prisma.deployment.findMany({
      where: { userId, packId: pack.id, status: { not: DeploymentStatus.FAILED } },
      select: { limitsRamMb: true, limitsCpu: true },
    });
    const count = deps.length;
    const maxApps = pack.maxApps ?? null;
    if (maxApps != null && count >= maxApps) {
      throw new ForbiddenException(
        `Quota d'applications du pack « ${pack.name} » atteint (${count}/${maxApps}). Supprimez une application ou passez à un plan supérieur.`,
      );
    }
    // Budget dérivé : limite effective par app × maxApps. Chaque pack a SON budget,
    // indépendant des autres packs du client.
    if (maxApps != null && eff) {
      const sumRam = deps.reduce((acc, d) => acc + (d.limitsRamMb ?? eff.ramMb), 0);
      const sumCpu = deps.reduce((acc, d) => acc + (d.limitsCpu ?? eff.cpuCores), 0);
      const budgetRam = eff.ramMb * maxApps;
      const budgetCpu = eff.cpuCores * maxApps;
      if (sumRam + eff.ramMb > budgetRam || sumCpu + eff.cpuCores > budgetCpu) {
        throw new ForbiddenException(
          `Limites de ressources du pack « ${pack.name} » dépassées (RAM ${sumRam + eff.ramMb}/${budgetRam} Mo, CPU ${sumCpu + eff.cpuCores}/${budgetCpu}). Supprimez une application ou passez à un plan supérieur.`,
        );
      }
    }
  }

  /** Phase 17 (3c) — apps dont l'application des limites a échoué (suivi visible admin). */
  async listLimitsIssues(limit = 200): Promise<
    Array<{
      id: string;
      appName: string | null;
      fqdn: string | null;
      clientEmail: string;
      clientName: string | null;
      status: DeploymentStatus;
      limitsStatus: LimitsStatus;
      limitsRamMb: number | null;
      limitsCpu: number | null;
      limitsLastError: string | null;
      limitsRetryCount: number;
    }>
  > {
    const rows = await this.prisma.deployment.findMany({
      where: { limitsStatus: { in: [LimitsStatus.FAILED, LimitsStatus.PENDING_RETRY] } },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { name: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      appName: r.appName,
      fqdn: r.fqdn,
      clientEmail: r.user.email,
      clientName: r.user.name,
      status: r.status,
      limitsStatus: r.limitsStatus as LimitsStatus,
      limitsRamMb: r.limitsRamMb,
      limitsCpu: r.limitsCpu,
      limitsLastError: r.limitsLastError,
      limitsRetryCount: r.limitsRetryCount,
    }));
  }

  /**
   * Phase 17 (3c) — re-application MANUELLE des limites (bouton admin). Réutilise
   * les limites effectives ENREGISTRÉES à la création (pas de recalcul dépendant du
   * pack actuel). Lève en cas d'échec (l'admin voit le message). Ne redéploie jamais
   * l'app ni ne redémarre le conteneur : uniquement un PATCH des champs Coolify, donc
   * aucune interruption du service client. Un cooldown anti-spam évite une boucle
   * qui frapperait l'API Coolify (pas d'auto-retry).
   */
  async reapplyLimits(id: string): Promise<{ status: LimitsStatus; message: string }> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id },
      include: { server: true },
    });
    if (!dep) throw new NotFoundException('Déploiement introuvable.');
    if (!dep.coolifyUuid || !dep.server || dep.server.panelOk !== true || !dep.server.apiBaseUrl || !dep.server.apiTokenEnc) {
      throw new BadRequestException(
        'Ré-application impossible : app Coolify ou serveur connecté non tracé pour cette app.',
      );
    }
    if (dep.limitsRamMb == null && dep.limitsCpu == null) {
      throw new BadRequestException("Aucune limite enregistrée pour cette app (pas de pack ACTIVE à la création).");
    }
    const cooldownMs = 60_000;
    if (
      dep.limitsStatus === LimitsStatus.PENDING_RETRY &&
      Date.now() - (dep.updatedAt?.getTime() ?? 0) < cooldownMs
    ) {
      throw new BadRequestException('Ré-application trop récente. Attendez quelques instants.');
    }
    const limits: CoolifyAppLimits = {};
    if (dep.limitsRamMb != null && dep.limitsRamMb > 0) limits.memory = memoryFromMb(dep.limitsRamMb);
    if (dep.limitsCpu != null && dep.limitsCpu > 0) limits.cpus = cpusFromCores(dep.limitsCpu);
    const target = this.buildTarget(dep.server);
    const transport = this.panelFactory.create();
    try {
      await transport.applyAppLimits(target, dep.coolifyUuid, limits);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await this.prisma.deployment.update({
        where: { id },
        data: { limitsStatus: LimitsStatus.FAILED, limitsLastError: m, limitsRetryCount: { increment: 1 } },
      });
      throw new BadRequestException(`Échec de la ré-application des limites : ${m}`);
    }
    await this.prisma.deployment.update({
      where: { id },
      data: { limitsStatus: LimitsStatus.APPLIED, limitsLastError: null, limitsRetryCount: { increment: 1 } },
    });
    return {
      status: LimitsStatus.APPLIED,
      message: `Limites ré-appliquées (${limits.memory ?? ''} RAM${limits.cpus ? `, ${limits.cpus} CPU` : ''}).`,
    };
  }

  /** Construit la cible du transport : jeton API panneau déchiffré à la volée. */
  private buildTarget(server: Server): PanelTarget {
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc!);
    } catch {
      throw new BadRequestException(
        'Impossible de déchiffrer le jeton API Coolify (ENCRYPTION_KEY ?).',
      );
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl!,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }

  /**
   * AUTO-DÉTECTION du serveur Coolify cible quand `server.coolifyServerUuid` est
   * vide (demande utilisateur : « si le champ Serveur Coolify cible (uuid) est
   * vide → utiliser le uuid détecté »). Interroge `GET /servers` et choisit celui
   * qui correspond au `hostname`, sinon le premier. Best-effort : tout échec
   * renvoie undefined → le transport se replie sur le défaut, jamais bloquant.
   */
  private async resolveCoolifyServerUuid(
    server: Server,
    transport: PanelTransport,
  ): Promise<string | undefined> {
    if (server.coolifyServerUuid) return server.coolifyServerUuid;
    try {
      const servers = await transport.listServers(this.buildTarget(server));
      if (servers.length === 0) return undefined;
      const byHost = servers.find((s) => s.ip && server.hostname && s.ip.includes(server.hostname));
      return byHost?.uuid ?? servers[0]?.uuid;
    } catch {
      return undefined;
    }
  }

  /** Re-sonde Coolify et met à jour la ligne si l'état a changé (audit). */
  private async refreshStatus(
    row: DeploymentWithRefs,
    actor: Actor,
  ): Promise<DeploymentWithRefs> {
    const server = await this.prisma.server.findUnique({ where: { id: row.serverId! } });
    if (
      !server ||
      server.panelProvider !== ServerPanelProvider.COOLIFY ||
      !server.apiBaseUrl ||
      !server.apiTokenEnc
    ) {
      return row;
    }
    let rawStatus: string;
    let detail: string | undefined;
    try {
      const result = await this.panelFactory
        .create()
        .deploymentStatus(this.buildTarget(server), row.coolifyUuid!);
      rawStatus = result.rawStatus;
      detail = result.detail;
    } catch {
      return row; // Coolify injoignable — état courant conservé
    }
    const mapped = mapCoolifyStatus(rawStatus);
    if (!mapped || mapped === row.status) {
      return row;
    }
    const updated = await this.prisma.deployment.update({
      where: { id: row.id },
      data: { status: mapped, detail: detail ?? `Statut Coolify : ${rawStatus}` },
      include: {
        server: { select: { id: true, name: true } },
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'deploy.status',
      resourceType: 'deployment',
      resourceId: row.id,
      details: { from: row.status, to: mapped, rawStatus, repoFullName: row.repoFullName },
    });
    return updated;
  }
}
