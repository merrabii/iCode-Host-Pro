// Phase 3 — service DNS & sous-domaines Cloudflare.
// Le contrôle des enregistrements EST LIVE via l'API Cloudflare (see
// CloudflareTransport). Ce service porte la configuration plateforme :
//   - le compte Cloudflare (CloudflareSetting, SINGLETON) — clé AES-256-GCM au
//     repos, JAMAIS renvoyée (seule `hasApiToken`) ;
//   - les zones racines importées (Domain) et la sélection de la racine (≤ 1) ;
//   - l'allocation d'un sous-domaine gratuit à l'app d'un client au déploiement.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Domain, DomainStatus, Prisma, SubdomainStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService, MailCryptoError } from '../crypto/crypto.service';
import {
  CfDnsRecord,
  CfZone,
  CloudflareTarget,
  CloudflareTransport,
  CloudflareTransportFactory,
} from './cloudflare.transport';

// ── Vulnérables ──────────────────────────────────────────────────────────

export interface RootDomainRef {
  id: string;
  name: string;
  cnameTarget: string | null;
}

export interface CloudflareSettingsView {
  id: string | null;
  hasApiToken: boolean;
  accountEmail: string | null;
  rootDomainId: string | null;
  rootDomain: RootDomainRef | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DomainView {
  id: string;
  name: string;
  zoneId: string;
  cnameTarget: string | null;
  status: DomainStatus;
  isRoot: boolean;
  clientSubdomainCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DnsRecordView extends CfDnsRecord {}

export interface AvailabilityView {
  available: boolean;
  fqdn: string;
  existing: CfDnsRecord | null;
}

export interface AllocatedSubdomain {
  subdomain: string;
  fqdn: string;
}

const DEFAULT_SETTINGS_VIEW: Omit<CloudflareSettingsView, 'id' | 'createdAt' | 'updatedAt'> = {
  hasApiToken: false,
  accountEmail: null,
  rootDomainId: null,
  rootDomain: null,
};

const ROOT_INCLUDE = { rootDomain: { select: { id: true, name: true, cnameTarget: true } } } as const;
type SettingsRow = Prisma.CloudflareSettingGetPayload<{ include: typeof ROOT_INCLUDE }>;

/** Normalise un sous-domaine (juger une saisie libre en slug sûr). */
function normalizeSubdomain(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/** Slug automatique depuis le nom du service (fallback « app »). */
function slugify(seed: string): string {
  const base = normalizeSubdomain(seed);
  return base || 'app';
}

@Injectable()
export class CloudflareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly cfFactory: CloudflareTransportFactory,
  ) {}

  // ── Helpers internes ───────────────────────────────────────────────────

  private async settingsRow(): Promise<SettingsRow | null> {
    return this.prisma.cloudflareSetting.findFirst({ include: ROOT_INCLUDE });
  }

  private async ensureSettings(): Promise<SettingsRow> {
    const existing = await this.prisma.cloudflareSetting.findFirst();
    // Seul `.id` est utilisé par les appelsants (l'update re-fetch avec include).
    if (existing) return existing as SettingsRow;
    return (await this.prisma.cloudflareSetting.create({ data: {}, include: ROOT_INCLUDE })) as SettingsRow;
  }

  private toSettingsView(row: SettingsRow | null): CloudflareSettingsView {
    if (!row) return { id: null, ...DEFAULT_SETTINGS_VIEW, createdAt: null, updatedAt: null };
    return {
      id: row.id,
      hasApiToken: Boolean(row.apiTokenEnc),
      accountEmail: row.accountEmail,
      rootDomainId: row.rootDomainId,
      rootDomain: row.rootDomain
        ? { id: row.rootDomain.id, name: row.rootDomain.name, cnameTarget: row.rootDomain.cnameTarget }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private domainView(
    d: Domain & { rootOf?: { id: string } | null; _count?: { clientSubdomains: number } },
  ): DomainView {
    return {
      id: d.id,
      name: d.name,
      zoneId: d.zoneId,
      cnameTarget: d.cnameTarget,
      status: d.status,
      isRoot: Boolean(d.rootOf),
      clientSubdomainCount: d._count?.clientSubdomains ?? 0,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  private async requireDomain(id: string): Promise<Domain> {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Domaine introuvable');
    return d;
  }

  /** Jeton déchiffré (à la volée, jamais renvoyé) ou erreur claire. */
  private async requireToken(): Promise<string> {
    const row = await this.prisma.cloudflareSetting.findFirst();
    if (!row?.apiTokenEnc) {
      throw new BadRequestException('Aucun jeton Cloudflare configuré.');
    }
    try {
      return this.crypto.decrypt(row.apiTokenEnc);
    } catch (err) {
      if (err instanceof MailCryptoError) {
        throw new BadRequestException(err.message);
      }
      throw new BadRequestException('Impossible de déchiffrer le jeton Cloudflare (ENCRYPTION_KEY ?).');
    }
  }

  private target(): Promise<CloudflareTarget> {
    return this.requireToken().then((token) => ({ token, strictTls: true }));
  }

  // ── Paramètres du compte ────────────────────────────────────────────────

  getSettings(): Promise<CloudflareSettingsView> {
    return this.settingsRow().then((row) => this.toSettingsView(row));
  }

  /** PATCH semantics — `apiToken` undefined = inchangé ; '' = effacé. */
  async updateSettings(
    dto: { apiToken?: string; accountEmail?: string },
    actor: { sub: string; email: string },
  ): Promise<CloudflareSettingsView> {
    const row = await this.ensureSettings();
    const data: Prisma.CloudflareSettingUpdateInput = {};
    let tokenChanged = false;
    let emailChanged = false;
    if (dto.apiToken !== undefined) {
      data.apiTokenEnc = dto.apiToken === '' ? null : this.crypto.encrypt(dto.apiToken);
      tokenChanged = true;
    }
    if (dto.accountEmail !== undefined) {
      data.accountEmail = dto.accountEmail === '' ? null : dto.accountEmail;
      emailChanged = true;
    }
    if (!tokenChanged && !emailChanged) {
      return this.getSettings();
    }
    const updated = await this.prisma.cloudflareSetting.update({
      where: { id: row.id },
      data,
      include: ROOT_INCLUDE,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.settings.update',
      resourceType: 'cloudflareSetting',
      resourceId: updated.id,
      // Jamais la clé en clair — seulement son état.
      details: {
        hasApiToken: Boolean(updated.apiTokenEnc),
        accountEmail: updated.accountEmail,
      },
    });
    return this.toSettingsView(updated);
  }

  /** Vérifie le jeton (listZones) : résultat lisible + zones du compte. */
  async verify(actor: { sub: string; email: string }): Promise<{ ok: boolean; zones: CfZone[]; detail: string }> {
    const token = await this.requireToken();
    let zones: CfZone[];
    try {
      zones = await this.cfFactory.create().listZones({ token, strictTls: true });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'cloudflare.verify',
        resourceType: 'cloudflareSetting',
        resourceId: '',
        details: { ok: false, detail: m },
      });
      return { ok: false, zones: [], detail: m };
    }
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.verify',
      resourceType: 'cloudflareSetting',
      resourceId: '',
      details: { ok: true, zoneCount: zones.length },
    });
    return { ok: true, zones, detail: `Cloudflare API : ${zones.length} zone(s) sur le compte.` };
  }

  // ── Zones live (provenance des racines importables) ─────────────────────

  async listZones(): Promise<CfZone[]> {
    const token = await this.requireToken();
    return this.cfFactory.create().listZones({ token, strictTls: true });
  }

  // ── Domaines racines (la "liste" admin) ────────────────────────────────

  async listDomains(): Promise<DomainView[]> {
    const domains = await this.prisma.domain.findMany({
      orderBy: { createdAt: 'desc' },
      include: { rootOf: { select: { id: true } }, _count: { select: { clientSubdomains: true } } },
    });
    return domains.map((d) => this.domainView(d));
  }

  async registerDomain(
    dto: { zoneId: string; name: string; cnameTarget?: string },
    actor: { sub: string; email: string },
  ): Promise<DomainView> {
    const name = dto.name.trim();
    const existingByName = await this.prisma.domain.findUnique({ where: { name } });
    const existingByZone = await this.prisma.domain.findUnique({ where: { zoneId: dto.zoneId } });
    if (existingByName || existingByZone) {
      throw new ConflictException('Cette zone est déjà importée.');
    }
    const created = await this.prisma.domain.create({
      data: {
        name,
        zoneId: dto.zoneId,
        cnameTarget: dto.cnameTarget && dto.cnameTarget.trim() !== '' ? dto.cnameTarget.trim() : null,
        status: DomainStatus.ACTIVE,
      },
      include: { rootOf: { select: { id: true } } },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.domain.create',
      resourceType: 'domain',
      resourceId: created.id,
      details: { name, zoneId: dto.zoneId },
    });
    return this.domainView(created);
  }

  async updateDomain(
    id: string,
    dto: { cnameTarget?: string; status?: DomainStatus },
    actor: { sub: string; email: string },
  ): Promise<DomainView> {
    const before = await this.requireDomain(id);
    const data: Prisma.DomainUpdateInput = {};
    if (dto.cnameTarget !== undefined) {
      data.cnameTarget = dto.cnameTarget === '' ? null : dto.cnameTarget;
    }
    if (dto.status !== undefined) data.status = dto.status;
    const updated = await this.prisma.domain.update({
      where: { id },
      data,
      include: { rootOf: { select: { id: true } }, _count: { select: { clientSubdomains: true } } },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.domain.update',
      resourceType: 'domain',
      resourceId: id,
      details: { name: before.name, cnameTarget: updated.cnameTarget, status: updated.status },
    });
    return this.domainView(updated);
  }

  /** Supprime un domaine (et sa sélection comme racine, si nécessaire). */
  async removeDomain(id: string, actor: { sub: string; email: string }): Promise<DomainView> {
    const before = await this.requireDomain(id);
    const view = this.domainView({ ...before, rootOf: null });
    const affected: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const settings = await tx.cloudflareSetting.findFirst();
      if (settings?.rootDomainId === id) {
        await tx.cloudflareSetting.updateMany({ where: { rootDomainId: id }, data: { rootDomainId: null } });
        affected.push('root');
      }
      await tx.domain.delete({ where: { id } });
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.domain.delete',
      resourceType: 'domain',
      resourceId: id,
      details: { name: before.name, unlinkedRoot: affected.includes('root') },
    });
    return view;
  }

  /** Sélectionne (≤ 1) le domaine racine utilisé pour les sous-domaines client.
   *  `domainId === null` désélectionne. */
  async setRootDomain(
    domainId: string | null,
    actor: { sub: string; email: string },
  ): Promise<CloudflareSettingsView> {
    if (domainId != null) await this.requireDomain(domainId);
    const row = await this.ensureSettings();
    const updated = await this.prisma.cloudflareSetting.update({
      where: { id: row.id },
      data: { rootDomainId: domainId },
      include: ROOT_INCLUDE,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.root.set',
      resourceType: 'cloudflareSetting',
      resourceId: row.id,
      details: { domainId },
    });
    return this.toSettingsView(updated);
  }

  // ── Enregistrements DNS (live proxy) ────────────────────────────────────

  async listDnsRecords(domainId: string): Promise<DnsRecordView[]> {
    const domain = await this.requireDomain(domainId);
    const t = await this.target();
    const recs = await this.cfFactory.create().listRecords(t, domain.zoneId);
    return recs.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl }));
  }

  async createDnsRecord(
    domainId: string,
    dto: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
    actor: { sub: string; email: string },
  ): Promise<{ id: string }> {
    const domain = await this.requireDomain(domainId);
    const t = await this.target();
    const id = await this.cfFactory.create().createRecord(t, domain.zoneId, dto);
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.record.create',
      resourceType: 'domain',
      resourceId: domainId,
      details: { domain: domain.name, type: dto.type, name: dto.name, content: dto.content, proxied: dto.proxied },
    });
    return { id };
  }

  async deleteDnsRecord(
    domainId: string,
    recordId: string,
    actor: { sub: string; email: string },
  ): Promise<{ id: string }> {
    const domain = await this.requireDomain(domainId);
    const t = await this.target();
    await this.cfFactory.create().deleteRecord(t, domain.zoneId, recordId);
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'cloudflare.record.delete',
      resourceType: 'domain',
      resourceId: domainId,
      details: { domain: domain.name, recordId },
    });
    return { id: recordId };
  }

  /** Disponibilité d'un sous-domaine sous une racine (live Cloudflare). */
  async checkSubdomainAvailability(subdomain: string, domainId: string): Promise<AvailabilityView> {
    const domain = await this.requireDomain(domainId);
    const t = await this.target();
    const fqdn = `${normalizeSubdomain(subdomain)}.${domain.name}`;
    const existing = await this.cfFactory.create().findRecordByName(t, domain.zoneId, fqdn);
    const takenLocally = await this.prisma.clientSubdomain.findFirst({ where: { fqdn } });
    const recorded = existing ?? (takenLocally ? (takenLocally as unknown as CfDnsRecord) : null);
    return { available: !existing && !takenLocally, fqdn, existing: recorded };
  }

  // ── Allocation au déploiement ───────────────────────────────────────────

  /**
   * Alloue un sous-domaine gratuit à l'app d'un client : vérifie la dispo DNS
   * (live), crée un CNAME → cnameTarget (ou fallbackHost), enregistre la row
   * ClientSubdomain et renvoie { subdomain, fqdn } pour le stockage sur le
   * Deployment. Appelé en best-effort par DeploymentsService (voir ADR-030).
   * - saisi explicitement & déjà pris → échec (le déploiement continue sans
   *   domaine, audit warn côté déploiement) ;
   * - auto (slug du nom de service) & pris → réessai avec suffixe court.
   */
  async allocateClientSubdomain(input: {
    root: Domain;
    requested?: string;
    seed: string;
    fallbackHost: string;
    deploymentId: string;
  }): Promise<AllocatedSubdomain> {
    const { root } = input;
    const t = await this.target();
    const transport = this.cfFactory.create();
    const requestedExplicit = Boolean(input.requested && input.requested.trim() !== '');
    const base = requestedExplicit ? normalizeSubdomain(input.requested!) : slugify(input.seed);
    if (!base) throw new BadRequestException('Sous-domaine invalide.');
    const content = root.cnameTarget ?? input.fallbackHost;

    const attempts = requestedExplicit ? 1 : 5;
    const seen = new Set<string>();
    for (let i = 0; i < attempts; i++) {
      const subdomain = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 5)}`;
      if (seen.has(subdomain)) continue;
      seen.add(subdomain);
      const fqdn = `${subdomain}.${root.name}`;
      const existing = await transport.findRecordByName(t, root.zoneId, fqdn);
      const takenLocally = !!((await this.prisma.clientSubdomain.findFirst({ where: { fqdn } })));
      if (!existing && !takenLocally) {
        return this.createSubdomainRecord({ t, transport, root, subdomain, fqdn, content, deploymentId: input.deploymentId });
      }
      if (requestedExplicit) {
        throw new BadRequestException(`Sous-domaine déjà pris : ${fqdn}`);
      }
    }
    throw new BadRequestException(`Impossible de trouver un sous-domaine libre sous ${root.name}.`);
  }

  /** Crée le CNAME (proxied, ttl auto) puis la row ClientSubdomain. */
  private async createSubdomainRecord(args: {
    t: CloudflareTarget;
    transport: CloudflareTransport;
    root: Domain;
    subdomain: string;
    fqdn: string;
    content: string;
    deploymentId: string;
  }): Promise<AllocatedSubdomain> {
    const { t, transport, root, subdomain, fqdn, content } = args;
    let recordId: string | null = null;
    try {
      recordId = await transport.createRecord(t, root.zoneId, {
        type: 'CNAME',
        name: fqdn,
        content,
        proxied: true,
        ttl: 1,
      });
    } catch (err) {
      await this.prisma.clientSubdomain.create({
        data: {
          subdomain,
          domainId: root.id,
          fqdn,
          status: SubdomainStatus.ERROR,
          deploymentId: args.deploymentId,
        },
      });
      throw err;
    }
    await this.prisma.clientSubdomain.create({
      data: {
        subdomain,
        domainId: root.id,
        fqdn,
        recordId,
        status: SubdomainStatus.CREATED,
        deploymentId: args.deploymentId,
      },
    });
    return { subdomain, fqdn };
  }

  /** Domain racine ACTIVE pour les allocations, ou null (aucune configurée). */
  async findActiveRootDomain(): Promise<Domain | null> {
    const settings = await this.prisma.cloudflareSetting.findFirst({
      where: { rootDomainId: { not: null } },
    });
    if (!settings?.rootDomainId) return null;
    const domain = await this.prisma.domain.findFirst({
      where: { id: settings.rootDomainId, status: DomainStatus.ACTIVE },
    });
    return domain ?? null;
  }
}