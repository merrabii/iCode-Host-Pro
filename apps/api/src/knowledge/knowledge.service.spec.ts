import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  KnowledgeAudience,
  KnowledgeStatus,
  KnowledgeType,
} from '@prisma/client';
import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService (base de connaissance admin+client, Phase 11)', () => {
  const mockPrisma = {
    knowledgeArticle: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'a1', email: 'admin@example.com', role: 'ADMIN' } as never;

  const article = (over: Record<string, unknown> = {}) => ({
    id: 'k1',
    audience: KnowledgeAudience.ADMIN,
    type: KnowledgeType.INFORMATIVE,
    status: KnowledgeStatus.PUBLISHED,
    title: 'Phase 10 — Sécurité',
    slug: 'phase-10-securite',
    summary: null,
    body: '<p>Contenu</p>',
    category: null,
    phase: 'Phase 10',
    tags: [],
    authorId: 'a1',
    authorEmail: 'admin@example.com',
    createdAt: new Date('2026-09-02T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    publishedAt: new Date('2026-09-02T00:00:00Z'),
    ...over,
  });

  let service: KnowledgeService;
  beforeEach(() => {
    service = new KnowledgeService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('creates an admin article: slug slugifié, statut par défaut DRAFT, audité', async () => {
    mockPrisma.knowledgeArticle.findMany.mockResolvedValue([]);
    mockPrisma.knowledgeArticle.create.mockResolvedValue(
      article({ slug: 'phase-10-securite-comptes' }),
    );
    const result = await service.create(actor, {
      audience: KnowledgeAudience.ADMIN,
      type: KnowledgeType.INFORMATIVE,
      title: 'Phase 10 — Sécurité & comptes',
      body: '<p>x</p>',
    });
    expect(result.slug).toBe('phase-10-securite-comptes');
    // Le slug calculé (slugifié, accents retirés) est bien envoyé à la base.
    const call = mockPrisma.knowledgeArticle.create.mock.calls[0][0];
    expect(call.data).toMatchObject({
      slug: 'phase-10-securite-comptes',
      status: KnowledgeStatus.DRAFT,
      audience: KnowledgeAudience.ADMIN,
      authorEmail: 'admin@example.com',
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge.create', actorId: 'a1' }),
    );
  });

  it('dé-duplique le slug (suffixe -2) sur collision', async () => {
    mockPrisma.knowledgeArticle.findMany.mockResolvedValue([article()]);
    mockPrisma.knowledgeArticle.create.mockResolvedValue(article({ slug: 'phase-10-securite-2' }));
    const result = await service.create(actor, {
      audience: KnowledgeAudience.ADMIN,
      type: KnowledgeType.INFORMATIVE,
      title: 'Phase 10 — Sécurité',
      body: '<p>x</p>',
    });
    expect(result.slug).toBe('phase-10-securite-2');
  });

  it('rejette un titre non slugifiable sans slug explicite', async () => {
    await expect(
      service.create(actor, {
        audience: KnowledgeAudience.ADMIN,
        type: KnowledgeType.HOWTO,
        title: '!!!',
        body: '<p>x</p>',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('publier un brouillon pose publishedAt (et ré-audite)', async () => {
    mockPrisma.knowledgeArticle.findUnique.mockResolvedValue(article({ status: KnowledgeStatus.DRAFT }));
    mockPrisma.knowledgeArticle.update.mockResolvedValue(article());
    await service.update(actor, 'k1', { status: KnowledgeStatus.PUBLISHED });
    expect(mockPrisma.knowledgeArticle.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: expect.objectContaining({
        status: KnowledgeStatus.PUBLISHED,
        publishedAt: expect.any(Date),
      }),
      include: expect.any(Object),
    });
  });

  it('suppression : audite knowledge.delete', async () => {
    mockPrisma.knowledgeArticle.findUnique.mockResolvedValue(article());
    mockPrisma.knowledgeArticle.delete.mockResolvedValue(article());
    await service.remove(actor, 'k1');
    expect(mockPrisma.knowledgeArticle.delete).toHaveBeenCalledWith({ where: { id: 'k1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge.delete', resourceId: 'k1' }),
    );
  });

  it('lecture client : NE renvoie QUE CLIENT + PUBLISHED, sans le body en liste', async () => {
    mockPrisma.knowledgeArticle.findMany.mockResolvedValue([
      { id: 'k1', type: KnowledgeType.HOWTO, title: 'Aide', slug: 'aide', category: 'Support' },
    ]);
    const rows = await service.listPublished({});
    const call = mockPrisma.knowledgeArticle.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      audience: KnowledgeAudience.CLIENT,
      status: KnowledgeStatus.PUBLISHED,
    });
    // Le catalogue client ne transporte JAMAIS le corps (body) — liste légère.
    expect(call.select).not.toHaveProperty('body');
    expect(rows).toHaveLength(1);
  });

  it('client ne voit JAMAIS un brouillon ni un article ADMIN', async () => {
    mockPrisma.knowledgeArticle.findFirst.mockResolvedValue(null);
    await expect(service.getPublished('secret-draft')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.knowledgeArticle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          audience: KnowledgeAudience.CLIENT,
          status: KnowledgeStatus.PUBLISHED,
        }),
      }),
    );
  });

  it('404 si l’article admin demandé n’existe pas', async () => {
    mockPrisma.knowledgeArticle.findUnique.mockResolvedValue(null);
    await expect(service.get(actor, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
