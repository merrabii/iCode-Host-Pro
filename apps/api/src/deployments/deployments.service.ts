import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Deployment,
  DeploymentStatus,
  HostingPack,
  PackStatus,
  Server,
  ServerPanelProvider,
  Service,
  ServiceStatus,
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
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { DetectResult, GithubRepo, GithubService } from './github.service';

/** Vue masquée d'un déploiement : jamais `coolifyUuid` (infra Coolify, ADR-021 —
 *  le client ne reçoit ni l'UUID d'application ni l'adresse du serveur). */
export type DeploymentView = Omit<Deployment, 'coolifyUuid'> & {
  service?: { id: string; name: string } | null;
  server?: { id: string; name: string } | null;
};

type DeploymentWithRefs = Deployment & {
  service?: { id: string; name: string } | null;
  server?: { id: string; name: string } | null;
};

/** Mapping best-effort du statut brut Coolify vers notre DeploymentStatus. */
function mapCoolifyStatus(raw: string): DeploymentStatus | null {
  const s = raw.toLowerCase();
  if (['running', 'exited', 'finished', 'success', 'successful', 'deployed'].includes(s)) {
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

    const { service, server, pack } = await this.resolveCoolifyTarget(dto.serviceId, actor.sub);
    const branch = dto.branch?.trim() ? dto.branch.trim() : (detectedBranch ?? 'main');
    const buildPack = dto.buildPack ?? suggestedBuildPack ?? 'nixpacks';
    const appName = dto.appName?.trim() ? dto.appName.trim() : service.name;
    const target = this.buildTarget(server);
    const transport = this.panelFactory.create();

    const row = await this.prisma.deployment.create({
      data: {
        userId: actor.sub,
        serviceId: service.id,
        serverId: server.id,
        repoFullName,
        repoUrl: dto.repoUrl ? repoUrl : null,
        buildPack,
        appName,
        branch,
        status: DeploymentStatus.PENDING,
      },
    });

    try {
      const app = await transport.createGitApp(target, {
        repoUrl,
        branch,
        serviceName: service.name,
        buildPack,
        appName,
        projectUuid: server.coolifyProjectUuid ?? undefined,
        serverUuid: server.coolifyServerUuid ?? undefined,
      });
      // Phase 12 — applique les limites RAM/CPU du pack du produit AVANT de
      // lancer le déploiement. Best-effort : un échec n'interrompt pas l'app.
      const limits = this.packLimits(pack);
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
          const m = err instanceof Error ? err.message : String(err);
          deployDetail = `App créée — limites non appliquées (${m}). Déploiement lancé.`;
          await this.audit.record({
            actorId: actor.sub,
            actorEmail: actor.email,
            action: 'deploy.limits.warn',
            resourceType: 'deployment',
            resourceId: row.id,
            details: { coolifyUuid: app.uuid, ...limits, packName: pack?.name, message: m },
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
        },
        include: {
          service: { select: { id: true, name: true } },
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
          buildPack,
          appName,
          mode: dto.repoUrl ? 'url' : 'github',
          serviceId: service.id,
          serverId: server.id,
          coolifyUuid: app.uuid,
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
        details: { repoFullName, branch, buildPack, appName, message },
      });
      throw new BadGatewayException(`Échec du déploiement : ${message}`);
    }
  }

  /** Les déploiements du client (service + nom de serveur inclus). */
  async listMine(actor: Actor): Promise<DeploymentView[]> {
    const rows = await this.prisma.deployment.findMany({
      where: { userId: actor.sub },
      include: {
        service: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
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
        service: { select: { id: true, name: true } },
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

  // ── Internes ───────────────────────────────────────────────────────────────

  /**
   * Cible = le Service ACTIVE du client, affecté par l'admin à un serveur
   * `panelProvider=COOLIFY` dont la vérification API a réussi (panelOk=true) —
   * « le serveur Coolify actuellement connecté ».
   */
  private async resolveCoolifyTarget(
    serviceId: string,
    userId: string,
  ): Promise<{ service: Service; server: Server; pack: HostingPack | null }> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, subscription: { userId } },
      include: {
        server: true,
        subscription: {
          include: { product: { include: { pack: true } } },
        },
      },
    });
    if (!service) {
      throw new NotFoundException('Service introuvable.');
    }
    if (service.status !== ServiceStatus.ACTIVE) {
      throw new BadRequestException('Service non actif : impossible de déployer.');
    }
    const server = service.server;
    if (!server || server.panelProvider !== ServerPanelProvider.COOLIFY) {
      throw new BadRequestException(
        'Ce service n’est pas affecté à un serveur Coolify connecté.',
      );
    }
    if (server.panelOk !== true || !server.apiBaseUrl || !server.apiTokenEnc) {
      throw new BadRequestException(
        'Le serveur Coolify de ce service n’est pas connecté (vérification API en échec).',
      );
    }
    // Pack du produit auquel le client est abonné — nul si le produit n'a pas de
    // pack (ou de relation abonnement→produit résolue).
    const pack = service.subscription?.product?.pack ?? null;
    return { service, server, pack };
  }

  /** Limites Coolify dérivées d'un pack ACTIVE (RAM/CPU). null = rien à appliquer. */
  private packLimits(pack: HostingPack | null): CoolifyAppLimits | null {
    if (!pack || pack.status !== PackStatus.ACTIVE) return null;
    const limits: CoolifyAppLimits = {};
    if (pack.cpuCores && pack.cpuCores > 0) limits.cpus = cpusFromCores(pack.cpuCores);
    if (pack.ramMb && pack.ramMb > 0) limits.memory = memoryFromMb(pack.ramMb);
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
        service: { select: { id: true, name: true } },
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
