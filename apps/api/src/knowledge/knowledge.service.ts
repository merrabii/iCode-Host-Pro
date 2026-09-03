import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeAudience,
  KnowledgeStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateKnowledgeArticleDto } from './dto/create-knowledge-article.dto';
import { UpdateKnowledgeArticleDto } from './dto/update-knowledge-article.dto';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // enlève les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

/**
 * Phase 11 — base de connaissance.
 * UN service pour les DEUX audiences :
 *  - ADMIN : articles internes (INFORMATIVE = récap phase, TECHNICAL = détails
 *    d'implémentation, HOWTO = guides admin) — CRUD complet, tout statut visible.
 *  - CLIENT : articles publiés servis sur /aide (support / explication des
 *    options) — l'admin les crée/édite/publie/archive ici, le client ne voit
 *    QUE `status=PUBLISHED` (jamais un brouillon ni un article ADMIN).
 * Chaque mutation est audité (audit.*). L'auteur (ADMIN) est dénormalisé en
 * authorEmail pour survivre à la suppression du compte.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private auditRecord(
    actor: { sub: string; email: string },
    action: string,
    resourceId: string | null,
    details?: Prisma.InputJsonObject,
  ) {
    return this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action,
      resourceType: 'knowledgeArticle',
      resourceId,
      ...(details ? { details } : {}),
    });
  }

  private async assertArticle(id: string) {
    const article = await this.prisma.knowledgeArticle.findUnique({
      where: { id },
    });
    if (!article) throw new NotFoundException('Article introuvable.');
    return article;
  }

  /** Slug par défaut = titre slugifié ; collision → suffixe -2, -3… */
  private ensureUniqueSlug(audience: KnowledgeAudience, slug: string, exceptId?: string) {
    const id = exceptId;
    return this.prisma.knowledgeArticle
      .findMany({
        where: {
          audience,
          ...(id ? { id: { not: id } } : {}),
          slug: { startsWith: slug },
        },
        select: { slug: true },
      })
      .then((rows) => {
        const used = new Set(rows.map((r) => r.slug));
        if (!used.has(slug)) return slug;
        let n = 2;
        while (used.has(`${slug}-${n}`)) n += 1;
        return `${slug}-${n}`;
      });
  }

  // ── Admin : CRUD complet ─────────────────────────────────────────────────────

  async list(
    actor: JwtPayload,
    opts: { audience?: KnowledgeAudience; status?: KnowledgeStatus; q?: string } = {},
  ) {
    const where: Prisma.KnowledgeArticleWhereInput = {};
    if (opts.audience) where.audience = opts.audience;
    if (opts.status) where.status = opts.status;
    if (opts.q) {
      const like = { contains: opts.q, mode: Prisma.QueryMode.insensitive } as const;
      where.OR = [{ title: like }, { summary: like }, { body: like }, { category: like }];
    }
    const rows = await this.prisma.knowledgeArticle.findMany({
      where,
      orderBy: [{ audience: 'asc' }, { updatedAt: 'desc' }],
      include: { author: { select: { id: true, email: true, name: true } } },
    });
    await this.auditRecord(actor, 'knowledge.list', null, { count: rows.length });
    return rows;
  }

  async get(actor: JwtPayload, id: string) {
    const article = await this.prisma.knowledgeArticle.findUnique({
      where: { id },
      include: { author: { select: { id: true, email: true, name: true } } },
    });
    if (!article) throw new NotFoundException('Article introuvable.');
    await this.auditRecord(actor, 'knowledge.read', id);
    return article;
  }

  async create(actor: JwtPayload, dto: CreateKnowledgeArticleDto) {
    const slug = dto.slug ?? slugify(dto.title);
    if (!slug) throw new BadRequestException('Titre non transformable en slug — fournissez un slug.');
    const unique = await this.ensureUniqueSlug(dto.audience, slug);
    const article = await this.prisma.knowledgeArticle.create({
      data: {
        audience: dto.audience,
        type: dto.type,
        title: dto.title,
        slug: unique,
        summary: dto.summary ?? null,
        body: dto.body,
        category: dto.category ?? null,
        phase: dto.phase ?? null,
        tags: dto.tags ?? [],
        status: dto.status ?? KnowledgeStatus.DRAFT,
        publishedAt:
          dto.status === KnowledgeStatus.PUBLISHED ? new Date() : null,
        authorId: actor.sub,
        authorEmail: actor.email,
      },
      include: { author: { select: { id: true, email: true, name: true } } },
    });
    await this.auditRecord(actor, 'knowledge.create', article.id, {
      audience: article.audience,
      type: article.type,
      title: article.title,
      slug: article.slug,
    });
    return article;
  }

  async update(
    actor: JwtPayload,
    id: string,
    dto: UpdateKnowledgeArticleDto,
  ) {
    const article = await this.assertArticle(id);
    // PATCH : seuls les champs présents sont modifiés.
    const data: Prisma.KnowledgeArticleUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.audience !== undefined) data.audience = dto.audience;
    if (dto.summary !== undefined) data.summary = dto.summary || null;
    if (dto.body !== undefined) data.body = dto.body;
    if (dto.category !== undefined) data.category = dto.category || null;
    if (dto.phase !== undefined) data.phase = dto.phase || null;
    if (dto.tags !== undefined) data.tags = dto.tags ?? [];
    if (dto.status !== undefined) {
      data.status = dto.status;
      // publication = date ; re-draft/archive = on conserve la dernière date.
      if (dto.status === KnowledgeStatus.PUBLISHED && article.status !== KnowledgeStatus.PUBLISHED) {
        data.publishedAt = new Date();
      }
    }
    if (dto.slug !== undefined && dto.slug !== article.slug) {
      const unique = await this.ensureUniqueSlug(dto.audience ?? article.audience, dto.slug, id);
      data.slug = unique;
    }
    const updated = await this.prisma.knowledgeArticle.update({
      where: { id: article.id },
      data,
      include: { author: { select: { id: true, email: true, name: true } } },
    });
    await this.auditRecord(actor, 'knowledge.update', article.id, {
      audience: updated.audience,
      type: updated.type,
      title: updated.title,
      status: updated.status,
    });
    return updated;
  }

  async remove(actor: JwtPayload, id: string) {
    const article = await this.assertArticle(id);
    await this.prisma.knowledgeArticle.delete({ where: { id: article.id } });
    await this.auditRecord(actor, 'knowledge.delete', id, {
      title: article.title,
      slug: article.slug,
    });
    return { ok: true };
  }

  // ── Client : lectures publiques (PUBLISHED seulement) ───────────────────────

  /** Client catalogue — articles PUBLISHED de l'audience CLIENT. */
  async listPublished(opts: { category?: string; q?: string } = {}) {
    const where: Prisma.KnowledgeArticleWhereInput = {
      audience: KnowledgeAudience.CLIENT,
      status: KnowledgeStatus.PUBLISHED,
    };
    if (opts.category) where.category = opts.category;
    if (opts.q) {
      const like = { contains: opts.q, mode: Prisma.QueryMode.insensitive } as const;
      where.OR = [{ title: like }, { summary: like }, { body: like }];
    }
    return this.prisma.knowledgeArticle.findMany({
      where,
      orderBy: [{ category: 'asc' }, { publishedAt: 'desc' }],
      select: {
        id: true,
        type: true,
        title: true,
        slug: true,
        summary: true,
        category: true,
        tags: true,
        publishedAt: true,
      },
    });
  }

  /** Client detail — PUBLISHED, résolu par id ou slug. */
  async getPublished(idOrSlug: string) {
    const where: Prisma.KnowledgeArticleWhereInput = {
      audience: KnowledgeAudience.CLIENT,
      status: KnowledgeStatus.PUBLISHED,
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    };
    const article = await this.prisma.knowledgeArticle.findFirst({ where });
    if (!article) throw new NotFoundException('Article introuvable.');
    return article;
  }

  /** Catégories client distinctes (pour la barre de navigation du /aide). */
  async listClientCategories() {
    const rows = await this.prisma.knowledgeArticle.findMany({
      where: {
        audience: KnowledgeAudience.CLIENT,
        status: KnowledgeStatus.PUBLISHED,
        category: { not: null },
      },
      distinct: ['category'],
      select: { category: true },
    });
    return rows.map((r) => r.category).filter(Boolean) as string[];
  }
}
