import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Server } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { ProbeResult, ProbeTransportFactory } from './probe-transport.factory';
import { CryptoService, MailCryptoError } from '../crypto/crypto.service';
import {
  PanelKind,
  PanelVerifyResult,
  PanelMetrics,
  PanelTransportFactory,
} from './panel-transport.factory';
import { HostResolverFactory } from './host-resolver.factory';
import { Actor } from '../users/users.service';

/**
 * Déduit le port de gestion (SSH/API) depuis l'URL de base de l'API du panneau,
 * quand l'admin n'a pas saisi de port manuellement (Phase 9bis). Ex. :
 * http://portal.exemple.com:8000/api/v1 -> 8000 ; https://panel.exemple.com -> 443.
 */
function derivePortFromUrl(apiBaseUrl: string): number | null {
  if (!apiBaseUrl) return null;
  try {
    const u = new URL(apiBaseUrl);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Vue masquée d'un serveur : tous les champs sauf `apiTokenEnc`, jamais exposé
 * (Phase 9, ADR-010/ADR-008). La seule trace de présence du jeton est le booléen
 * `hasApiToken` — comme `hasPassword` côté MailSetting (Phase 6).
 */
export type ServerView = Omit<Server, 'apiTokenEnc'> & {
  hasApiToken: boolean;
};

export interface ServerCheckResult {
  server: ServerView;
  probe: ProbeResult;
}

export interface ServerPanelVerifyResult {
  server: ServerView;
  result: PanelVerifyResult;
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly probeFactory: ProbeTransportFactory,
    private readonly panelFactory: PanelTransportFactory,
    private readonly crypto: CryptoService,
    private readonly hostResolverFactory: HostResolverFactory,
  ) {}

  /** Auto-détecte l'IP depuis le hostname (best-effort ; null = échec). */
  private async resolveIp(hostname: string): Promise<string | null> {
    return this.hostResolverFactory.create().resolveIp(hostname);
  }

  /** Masque le jeton et expose uniquement hasApiToken. */
  private view(s: Server): ServerView {
    const { apiTokenEnc, ...rest } = s;
    return { ...rest, hasApiToken: Boolean(apiTokenEnc) };
  }

  /** Trouve un serveur tel qu'en base (le jeton chiffré est lisible ICI uniquement). */
  private async findRaw(id: string): Promise<Server> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) {
      throw new NotFoundException('Server not found');
    }
    return server;
  }

  /** Chiffre un jeton entrant ; trouble une clé manquante en 400 clair. */
  private encryptToken(plain: string): string {
    try {
      return this.crypto.encrypt(plain);
    } catch (err) {
      if (err instanceof MailCryptoError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async create(dto: CreateServerDto, actor: Actor): Promise<ServerView> {
    // Phase 9bis : auto-détection IP (DNS) si l'admin n'a pas saisi d'IP, et
    // déduction du port de gestion depuis l'URL de l'API du panneau si aucun
    // port n'est saisi (ex. http://portal.exemple.com:8000 -> 8000).
    const ipAddress = dto.ipAddress ?? (await this.resolveIp(dto.hostname));
    const data: Prisma.ServerCreateInput = {
      name: dto.name,
      hostname: dto.hostname,
      status: dto.status,
      ipAddress: ipAddress ?? null,
      port: dto.port ?? derivePortFromUrl(dto.apiBaseUrl ?? ''),
      provider: dto.provider ?? null,
      region: dto.region ?? null,
      quotaMaxAccounts: dto.quotaMaxAccounts,
      strictTls: dto.strictTls,
      panelProvider: dto.panelProvider,
      apiBaseUrl: dto.apiBaseUrl === '' ? null : (dto.apiBaseUrl ?? null),
      apiUser: dto.apiUser === '' ? null : (dto.apiUser ?? null),
      apiTokenEnc:
        dto.apiToken && dto.apiToken.trim() !== ''
          ? this.encryptToken(dto.apiToken)
          : null,
      ramMb: dto.ramMb ?? null,
      cpuCores: dto.cpuCores ?? null,
      diskGb: dto.diskGb ?? null,
      bandwidthLimit: dto.bandwidthLimit === '' ? null : (dto.bandwidthLimit ?? null),
    };
    const server = await this.prisma.server.create({ data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.create',
      resourceType: 'server',
      resourceId: server.id,
      details: {
        name: server.name,
        hostname: server.hostname,
        status: server.status,
        hasApiToken: Boolean(server.apiTokenEnc),
      },
    });
    return this.view(server);
  }

  async findAll(): Promise<ServerView[]> {
    const servers = await this.prisma.server.findMany({ orderBy: { createdAt: 'desc' } });
    return servers.map((s) => this.view(s));
  }

  async findOne(id: string): Promise<ServerView> {
    return this.view(await this.findRaw(id));
  }

  async update(id: string, dto: UpdateServerDto, actor: Actor): Promise<ServerView> {
    const before = await this.findRaw(id);
    const data: Prisma.ServerUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.hostname !== undefined ? { hostname: dto.hostname } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      // IP : si non fournie explicitement, auto-détection DNS pour remplir une
      // IP jusque-là absente ou pour rafraîchir après un changement de hostname.
      // Une IP posée manuellement et dont on ne touche pas au hostname est préservée.
      ...(dto.ipAddress !== undefined
        ? { ipAddress: dto.ipAddress === '' ? null : dto.ipAddress }
        : dto.hostname !== undefined || before.ipAddress == null
          ? { ipAddress: (await this.resolveIp(dto.hostname ?? before.hostname)) ?? before.ipAddress ?? null }
          : {}),
      ...(dto.port !== undefined ? { port: dto.port } : {}),
      // Port : déduit de la nouvelle apiBaseUrl si aucun port explicite et qu'aucun
      // n'était connu (remplit un port jusque-là vide sans écraser une valeur manuelle).
      ...(dto.port === undefined &&
      dto.apiBaseUrl !== undefined &&
      before.port == null
        ? { port: derivePortFromUrl(dto.apiBaseUrl === '' ? '' : dto.apiBaseUrl) }
        : {}),
      ...(dto.provider !== undefined ? { provider: dto.provider } : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
      ...(dto.quotaMaxAccounts !== undefined ? { quotaMaxAccounts: dto.quotaMaxAccounts } : {}),
      ...(dto.strictTls !== undefined ? { strictTls: dto.strictTls } : {}),
      ...(dto.panelProvider !== undefined ? { panelProvider: dto.panelProvider } : {}),
      ...(dto.apiBaseUrl !== undefined ? { apiBaseUrl: dto.apiBaseUrl === '' ? null : dto.apiBaseUrl } : {}),
      ...(dto.apiUser !== undefined ? { apiUser: dto.apiUser === '' ? null : dto.apiUser } : {}),
      // Métriques (Phase 9bis) : remplacées seulement quand l'admin les fournit.
      ...(dto.ramMb !== undefined ? { ramMb: dto.ramMb } : {}),
      ...(dto.cpuCores !== undefined ? { cpuCores: dto.cpuCores } : {}),
      ...(dto.diskGb !== undefined ? { diskGb: dto.diskGb } : {}),
      ...(dto.bandwidthLimit !== undefined
        ? { bandwidthLimit: dto.bandwidthLimit === '' ? null : dto.bandwidthLimit }
        : {}),
    };
    // Token API : undefined = inchangé ; '' = effacer ; sinon chiffrer et remplacer.
    if (dto.apiToken !== undefined) {
      data.apiTokenEnc = dto.apiToken === '' ? null : this.encryptToken(dto.apiToken);
    }
    const server = await this.prisma.server.update({ where: { id }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.update',
      resourceType: 'server',
      resourceId: id,
      details: { from: this.view(before), to: this.view(server) },
    });
    return this.view(server);
  }

  /**
   * Phase 8 (ADR-025): sonde de connectivité réelle vers un serveur.
   * Cible = hostname + port de gestion (défaut 22 si absent). Le résultat est
   * persisté (lastCheckedAt/Ok/Detail) mais le STATUT lui-même reste piloté
   * manuellement par l'admin — la sonde PROPOSE une bascule, elle ne la force pas.
   */
  async check(id: string, actor: Actor): Promise<ServerCheckResult> {
    const server = await this.findRaw(id);
    const port = server.port ?? 22;
    const transport = this.probeFactory.create();
    const probe = await transport.probe({
      host: server.hostname,
      port,
      strictTls: server.strictTls,
    });
    const checked = await this.prisma.server.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastProbeOk: probe.ok,
        lastProbeDetail: probe.detail,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.check',
      resourceType: 'server',
      resourceId: id,
      details: {
        host: server.hostname,
        port,
        ok: probe.ok,
        detail: probe.detail,
        latencyMs: probe.latencyMs ?? null,
        httpStatus: probe.httpStatus ?? null,
        statusLeft: server.status,
      },
    });
    return { server: this.view(checked), probe };
  }

  /**
   * Phase 9 (ADR-010): vérification de l'API du panneau serveur (Hestia/Coolify).
   * Le transport (PanelTransportFactory) touche l'API réelle du panneau si une
   * URL + un jeton sont configurés ; le jeton est déchiffré À LA VOLÉE (jamais
   * logué, jamais renvoyé). Le résultat est persisté (panelVerifiedAt/Ok/Detail)
   * et journalisé sous `server.panel.verify`.
   */
  async verifyPanel(id: string, actor: Actor): Promise<ServerPanelVerifyResult> {
    const server = await this.findRaw(id);
    if (server.panelProvider === 'NONE') {
      throw new BadRequestException(
        'Aucun module de panneau sélectionné (panelProvider).',
      );
    }
    if (!server.apiBaseUrl) {
      throw new BadRequestException(
        'Aucune URL d’API configurée (apiBaseUrl) — vérification impossible.',
      );
    }
    if (!server.apiTokenEnc) {
      throw new BadRequestException(
        'Aucun jeton API configuré pour ce panneau — vérification impossible.',
      );
    }
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc);
    } catch {
      throw new BadRequestException(
        'Impossible de déchiffrer le jeton API du panneau (ENCRYPTION_KEY ?).',
      );
    }
    const transport = this.panelFactory.create();
    const result = await transport.verify({
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl,
      token,
      user: server.apiUser,
      strictTls: server.strictTls,
    });
    // Métriques auto-détectées (Hestia sysinfo) : appliquées SEULEMENT sur les
    // champs encore vides, pour ne jamais écraser une valeur saisie manuellement.
    const metrics: PanelMetrics | null = result.metrics ?? null;
    const detected = metrics
      ? {
          ...(server.ramMb == null && metrics.ramMb != null ? { ramMb: metrics.ramMb } : {}),
          ...(server.cpuCores == null && metrics.cpuCores != null
            ? { cpuCores: metrics.cpuCores }
            : {}),
          ...(server.diskGb == null && metrics.diskGb != null ? { diskGb: metrics.diskGb } : {}),
        }
      : {};
    const updated = await this.prisma.server.update({
      where: { id },
      data: {
        panelVerifiedAt: new Date(),
        panelOk: result.ok,
        panelDetail: result.detail,
        ...detected,
      },
    });
    const hadMetrics =
      metrics && Object.keys(detected).length > 0
        ? { ramMb: detected.ramMb ?? null, cpuCores: detected.cpuCores ?? null, diskGb: detected.diskGb ?? null }
        : null;
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.panel.verify',
      resourceType: 'server',
      resourceId: id,
      details: {
        provider: server.panelProvider,
        baseUrl: server.apiBaseUrl,
        ok: result.ok,
        detail: result.detail,
        latencyMs: result.latencyMs ?? null,
        version: result.version ?? null,
        metricsDetected: hadMetrics,
        statusLeft: server.status,
      },
    });
    return { server: this.view(updated), result };
  }

  async remove(id: string, actor: Actor): Promise<ServerView> {
    const before = await this.findRaw(id);
    const server = await this.prisma.server.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.delete',
      resourceType: 'server',
      resourceId: id,
      details: { name: before.name },
    });
    return this.view(server);
  }
}
