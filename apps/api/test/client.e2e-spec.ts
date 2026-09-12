import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role, SubscriptionStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 5 (ADR-021) + Bloc 1/4 (ADR-035) : espace client — modèle order-driven.
// Les abonnements sont créés ACTIVE par la procédure de commande (checkout store),
// jamais via une route de création publique (directive C). Ici la création se
// reproduit de façon déterministe en base (la ligne ACTIVE que produit le checkout).
// L'admin garde les transitions : suspendre / réactiver (PENDING→approbation n'existe
// plus). La table `Service` a disparu — l'isolation porte sur les subscriptions.
// Le client ne voit jamais /api/admin/* (403) ni de détails serveur.
describe('Client workspace (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `admin5_${stamp}@example.com`;
  const userA = `clienta_${stamp}@example.com`;
  const userB = `clientb_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let aToken = '';
  let bToken = '';
  let productId = '';
  let subId = '';
  let subBId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    for (const [email, role] of [
      [adminEmail, Role.ADMIN],
      [userA, Role.USER],
      [userB, Role.USER],
    ] as const) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role },
      });
    }
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    aToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userA, password })
        .expect(201)
    ).body.accessToken as string;
    bToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userB, password })
        .expect(201)
    ).body.accessToken as string;

    // Plateforme : un produit à pack (ADMIN-managed). Pas de serveur requis ici
    // — la table `Service` a disparu et ce spec teste le cycle d'abonnement.
    productId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `prod5_${stamp}`, kind: 'deployment' })
        .expect(201)
    ).body.id as string;

    // Les abonnements naissent ACTIVE via checkout (le paiement vaut approbation,
    // décisions a/e d'ADR-035). Reproduction déterministe en base : la ligne exacte
    // que produit le checkout, sans réseau.
    const aRow = await prisma.subscription.create({
      data: { userId: (await aMeUserId(aToken)), productId, status: SubscriptionStatus.ACTIVE },
    });
    subId = aRow.id;
    const bRow = await prisma.subscription.create({
      data: { userId: (await aMeUserId(bToken)), productId, status: SubscriptionStatus.ACTIVE },
    });
    subBId = bRow.id;
  });

  // Résout l'id de l'utilisateur via /users/me (authentifié) — évite de ré-écrire
  // le login en Prisma.
  async function aMeUserId(token: string): Promise<string> {
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return me.body.id as string;
  }

  afterAll(async () => {
    // Deleting users cascades subscriptions; product remains free (Restrict).
    await prisma.user
      .deleteMany({ where: { email: { in: [userA, userB, adminEmail] } } })
      .catch(() => {});
    if (productId) await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await app.close();
  });

  it('register without a checkout intent stays closed (403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .send({ email: `x${stamp}@example.com`, password })
      .expect(403);
  });

  it('a USER cannot reach the admin overlay (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(403);
  });

  it('client can browse the catalogue (products)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/products`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.some((p: { id: string }) => p.id === productId)).toBe(true);
  });

  it('no public route creates subscriptions — checkout is the only path (POST → 404)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ productId })
      .expect(404);
  });

  it('client lists own ACTIVE subscription, created by checkout, with its product', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    const mine = list.body.find((s: { id: string }) => s.id === subId);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('ACTIVE');
    // Le produit est inclus ; aucune info serveur/infra n'est exposée.
    expect(mine.product).toMatchObject({ id: productId });
    expect(mine).not.toHaveProperty('server');
    expect(mine).not.toHaveProperty('serverId');
  });

  it('ADMIN lists all subscriptions (rapport Bloc 5) incl. product + pack + order', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = list.body.find((s: { id: string }) => s.id === subId);
    expect(row).toBeTruthy();
    expect(row.product).toBeTruthy();
    expect(row.user.email).toBe(userA);
    // `order` (commande liée) et `pack` existent comme colonnes de la refonte.
    expect(row).toHaveProperty('order');
    expect(row.product).toHaveProperty('pack');
  });

  it('cross-client isolation: B never sees A’s subscription (404 on mutate, absent in list)', async () => {
    const bList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bList.body.some((s: { id: string }) => s.id === subId)).toBe(false);

    // B cannot mutate/cancel A's subscription (404, no existence leak).
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/subscriptions/${subId}/cancel`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(404);
  });

  it('client cancels own ACTIVE subscription → CANCELLED; admin cannot reactivate a CANCELLED one (400)', async () => {
    const cancelled = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/subscriptions/${subId}/cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // CANCELLED → ACTIVE n'est pas une transition autorisée.
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('ADMIN can suspend an ACTIVE subscription, then reactivate it — client sees the change', async () => {
    const suspended = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subBId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'SUSPENDED' })
      .expect(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const bList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bList.body.find((s: { id: string }) => s.id === subBId).status).toBe('SUSPENDED');

    const reactivated = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subBId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(reactivated.body.status).toBe('ACTIVE');
  });

  it('client cancels own SUSPENDED subscription → CANCELLED (allowed)', async () => {
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subBId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'SUSPENDED' })
      .expect(200);

    const cancelled = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/subscriptions/${subBId}/cancel`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});