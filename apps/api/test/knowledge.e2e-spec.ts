import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { KnowledgeAudience, KnowledgeStatus, KnowledgeType, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 11 — base de connaissance. Deux audiences (ADMIN interne / CLIENT), un
// CRUD admin complet (audité) + des lectures publiques qui ne laissent JAMAIS
// filtrer un brouillon ni un article interne admin.
describe('Knowledge base (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `kbadmin_${stamp}@example.com`;
  const userEmail = `kbuser_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  let adminId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN },
    });
    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userEmail, password })
        .expect(201)
    ).body.accessToken as string;
    adminId = (
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/me`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.id as string;
  });

  afterAll(async () => {
    await prisma.knowledgeArticle.deleteMany({
      where: { authorEmail: { in: [adminEmail] } },
    }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    await app.close();
  });

  it('admin CRUD: 401/403 gates, create → draft, publish, list, update, delete', async () => {
    // 401 sans jeton, 403 pour un USER.
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/knowledge`).expect(401);
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/knowledge`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    // Création (statut par défaut DRAFT).
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/knowledge`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        audience: KnowledgeAudience.ADMIN,
        type: KnowledgeType.INFORMATIVE,
        title: 'Phase 10 — Sécurité & comptes',
        body: '<p>Récapitulatif</p>',
        phase: 'Phase 10',
      })
      .expect(201);
    expect(created.body.slug).toBe('phase-10-securite-comptes');
    expect(created.body.status).toBe(KnowledgeStatus.DRAFT);
    expect(created.body.authorEmail).toBe(adminEmail);
    const id = created.body.id as string;

    // Publication.
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/knowledge/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: KnowledgeStatus.PUBLISHED })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe(KnowledgeStatus.PUBLISHED));

    // Liste avec filtre audience + statut.
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/knowledge?audience=${KnowledgeAudience.ADMIN}&status=${KnowledgeStatus.PUBLISHED}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(list.body.some((a: { id: string }) => a.id === id)).toBe(true);

    // Suppression.
    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/knowledge/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('client catalogue public : un brouillon client et un article admin ne sont JAMAIS exposés', async () => {
    // Article client publié.
    const clientPub = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/knowledge`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        audience: KnowledgeAudience.CLIENT,
        type: KnowledgeType.HOWTO,
        title: 'Comment configurer mon déploiement',
        slug: 'configurer-deploiement',
        summary: 'Un guide client',
        body: '<p>Guide</p>',
        category: 'Déploiement',
        status: KnowledgeStatus.PUBLISHED,
      })
      .expect(201);

    // Brouillon client (pas encore publié).
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/knowledge`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        audience: KnowledgeAudience.CLIENT,
        type: KnowledgeType.HOWTO,
        title: 'Brouillon client secret',
        slug: 'brouillon-secret',
        body: '<p>ne doit pas sortir</p>',
        status: KnowledgeStatus.DRAFT,
      })
      .expect(201);

    // Article admin (interne) — jamais servi au client.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/knowledge`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        audience: KnowledgeAudience.ADMIN,
        type: KnowledgeType.TECHNICAL,
        title: 'Détails techniques internes',
        slug: 'technique-interne',
        body: '<p>secret admin</p>',
        status: KnowledgeStatus.PUBLISHED,
      })
      .expect(201);

    // Catalogue public : seul l'article client publié apparaît, sans le body.
    const catalog = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/knowledge`)
      .expect(200);
    const slugs = catalog.body.map((a: { slug: string }) => a.slug);
    expect(slugs).toContain('configurer-deploiement');
    expect(slugs).not.toContain('brouillon-secret');
    expect(slugs).not.toContain('technique-interne');
    catalog.body.forEach((a: { body?: unknown }) => expect(a).not.toHaveProperty('body'));

    // Lecture directe d'un brouillon client → 404.
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/knowledge/brouillon-secret`)
      .expect(404);

    // Catégories client distinctes.
    const cats = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/knowledge/categories`)
      .expect(200);
    expect(cats.body).toContain('Déploiement');

    // Cleanup des articles créés.
    await prisma.knowledgeArticle.deleteMany({
      where: { authorEmail: adminEmail },
    });
  });
});
