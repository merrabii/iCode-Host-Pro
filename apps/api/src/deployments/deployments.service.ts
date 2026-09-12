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
  cpusFromCores,
  memoryFromMb,
  PanelKind,
  PanelTarget,
  PanelTransportFactory,
} from '../servers/panel-transport.factory';
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

/** Mapping best-effort du statut brut Coolify vers notre DeploymentStatus. */
function mapCoolifyStatus(raw: string): DeploymentStatus | null {
  const s = raw.toLowerCase();
  // Coolify rend l'état d'une app sous la forme « <état>:<santé> » (ex
  // « running:healthy », « running:unknown », « exited:unhealthy »). Toute
  // variante « running»* = l'app TOURNE → ACTIVE.
  if (s.startsWith('running') || ['exited', 'finished', 'success', 'successful', 'deployed'].includes(s)) {
    return DeploymentStatus.ACTIVE;
  }
  if (['queued', 'in_progress', 'starting', 'building', 'deploying', 'processing', 'pending'].includes(s)) {
    return DeploymentStatus.DEPLOYING;
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'crash'].some((x) => s.includes(x))) {
    return DeploymentStatus.FAILED;
  }
  return null; // statut inconnu → on garde l'état courant
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
    // Quota d'apps du pack (Phase 13) : count des apps du client hors FAILED.
    // Appliqué AVANT toute création côté Coolify.
    if (pack?.maxApps != null && pack.maxApps > 0) {
      const used = await this.prisma.deployment.count({
        where: { userId: actor.sub, status: { not: DeploymentStatus.FAILED } },
      });
      if (used >= pack.maxApps) {
        throw new ForbiddenException(
          `Quota d'applications atteint (${used}/${pack.maxApps}). Supprimez une application ou passez à un plan supérieur.`,
        );
      }
    }

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
        serverUuid: server.coolifyServerUuid ?? undefined,
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
      // prioritaires) AVANT de lancer le déploiement. Best-effort : un échec
      // n'interrompt pas l'app. Le quota disque reste enregistré, non appliqué.
      const limits = this.packLimits(pack, module);
      let deployDetail = 'Déploiement déclenché sur Coolify.';
      if (limits) {
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
          // Sécurité serveur partagé (Bloc 3) — fail-closed : une app ne reste
          // JAMAIS sans plafond sur un box partagé. Si les limites du pack ne
          // peuvent pas être appliquées, on échoue la deployment (FAILED) au lieu
          // de lancer le build. On lève ici ; le catch externe marque FAILED et
          // lève BadGateway avec le message.
          const m = err instanceof Error ? err.message : String(err);
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.limits.failed',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, ...limits, packName: pack?.name, message: m },
          });
          throw new Error(
            `Limites pack non appliquées — app non laissée sans plafond sur serveur partagé (${m}).`,
          );
        }
      }
      // Phase 3 — sous-domaine gratuit (CNAME → hostname Coolify) via Cloudflare,
      // APRÈS les limites et AVANT le run. Best-effort comme les limites : un
      // échec (sous-domaine pris, DNS indisponible…) n'interrompt pas le déploiement.
      let dns: { subdomain?: string; fqdn?: string; domainId?: string } = {};
      const root = await this.cloudflare.findActiveRootDomain();
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
    const quota = await this.resolveQuota(actor.sub);
    return { deployments: rows.map((r) => this.toView(r)), quota };
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
   * Projet Coolify dédié du client (Module B) : existe → renvoyé ; sinon créé
   * paresseusement sur Coolify (`POST /projects`, idempotent via @@unique) puis
   * persisté. Nom = `<perClientPrefix>-<id client>` — retrouvable par le support.
   * Exposed for admin create-client-project endpoint (UsersService).
   */
  async getOrCreateClientProject(
    userId: string,
    server: Server,
    module: DeploymentModule,
  ): Promise<{ id: string; projectUuid: string }> {
    const key = { userId, serverId: server.id, moduleId: module.id };
    const existing = await this.prisma.clientProject.findUnique({
      where: { userId_serverId_moduleId: key },
    });
    if (existing) return { id: existing.id, projectUuid: existing.projectUuid };

    const name = `${module.perClientPrefix}-${userId}`;
    const created = await this.panelFactory
      .create()
      .createProject(this.buildTarget(server), {
        name,
        description: 'Projet Coolify dédié du client (Module B).',
        serverUuid: server.coolifyServerUuid ?? '0',
      });
    try {
      const row = await this.prisma.clientProject.create({
        data: { ...key, name, projectUuid: created.uuid },
      });
      return { id: row.id, projectUuid: row.projectUuid };
    } catch (err) {
      // Course concurrente : le projet a été persisté entre-temps → on reprend
      // la ligne existante (P2002 = violation de la contrainte unique).
      if ((err as { code?: string }).code === 'P2002') {
        const row = await this.prisma.clientProject.findUnique({
          where: { userId_serverId_moduleId: key },
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
    const ramMb = module?.overrideRamMb ?? pack.ramMb;
    const cpuCores = module?.overrideCpuCores ?? pack.cpuCores;
    const limits: CoolifyAppLimits = {};
    if (cpuCores && cpuCores > 0) limits.cpus = cpusFromCores(cpuCores);
    if (ramMb && ramMb > 0) limits.memory = memoryFromMb(ramMb);
    return limits.cpus || limits.memory ? limits : null;
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
