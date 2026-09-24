import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { InvoiceStatus, OrderStatus, Role, SubscriptionStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

/**
 * 17B.4E-E2-B — e2e PostgreSQL du terminate idempotent (service actif).
 * Fixtures minimales via Prisma, AUCUN provider/DNS réel (pas de coolifyUuid
 * → unknown ; server sans credentials → failed). Le candidat 17B.4E réel n'est
 * JAMAIS touché (fixtures de cette spec uniquement).
 * Contrat : 401/403/400/404/409, ACTIVE succès, CANCELLED rejeu idempotent,
 * Invoice PAID inchangée, Subscription → CANCELLED, projet conservé,
 * ownership DNS, double POST, historique unique, AuditLog sans secret.
 * C3 (ADR-019) : AuditLog append-only — jamais supprimé ici.
 */
describe('Store terminate-active-service (e2e, 17B.4E-E2-B)', () => {
  const url = (id: string) => `/${GlobalPrefix}/store/admin/orders/${id}/terminate`;
  const reason = 'Terminaison service actif — test e2e terminate';

  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `termadmin_${stamp}@example.com`;
  const userEmail = `termuser_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  let productId = '';
  let customerId = '';
  let userId = '';
  let createdIds: string[] = [];

  async function seedOrder(
    status: OrderStatus,
    opts?: { domainValue?: string; effectiveDomainId?: string },
  ): Promise<string> {
    const order = await prisma.order.create({
      data: {
        customerId,
        customerName: 'Terminate E2E',
        customerEmail: `term-e2e-${stamp}@example.com`,
        productId,
        productName: `term-e2e-${stamp}`,
        status,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
        domainType: 'FREE_SUBDOMAIN',
        domainValue: opts?.domainValue ?? `term-${stamp}.example.test`,
        domainStatus: 'READY',
        ...(opts?.effectiveDomainId ? { effectiveDomainId: opts.effectiveDomainId } : {}),
      },
    });
    createdIds.push(order.id);
    return order.id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix(GlobalPrefix);
    a.use(cookieParser());
    a.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await a.init();
    app = a;
    prisma = moduleRef.get(PrismaService);

    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN, name: 'TermAdmin' },
    });
    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER, name: 'TermUser' },
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

    const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    userId = admin!.id;
    const product = await prisma.product.create({ data: { name: `term-e2e-${stamp}` } });
    productId = product.id;
    const customer = await prisma.customer.create({
      data: { email: `term-cust-${stamp}@example.com`, name: 'Terminate E2E', userId },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { orderId: id } }).catch(() => {});
      await prisma.subscription.deleteMany({ where: { orderId: id } }).catch(() => {});
      await prisma.clientSubdomain.deleteMany({ where: { deployment: { orderId: id } } }).catch(() => {});
      await prisma.clientSubdomain.deleteMany({ where: { fqdn: { contains: String(stamp) } } }).catch(() => {});
      await prisma.deployment.deleteMany({ where: { orderId: id } }).catch(() => {});
      await prisma.domain.deleteMany({ where: { zoneId: { contains: String(stamp) } } }).catch(() => {});
      await prisma.order.delete({ where: { id } }).catch(() => {});
    }
    await prisma.clientProject.deleteMany({ where: { user: { email: adminEmail } } }).catch(() => {});
    await prisma.server.deleteMany({ where: { name: `term-srv-${stamp}` } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: `term-cust-${stamp}@example.com` } }).catch(() => {});
    await prisma.product.deleteMany({ where: { name: `term-e2e-${stamp}` } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    // C3 CAS A : les AuditLog ne sont JAMAIS supprimés (append-only ADR-019).
    await app.close();
  });

  it('401 sans token, 403 USER, 400 reason court', async () => {
    const orderId = await seedOrder(OrderStatus.ACTIVE);
    await request(app.getHttpServer()).post(url(orderId)).expect(401);
    await request(app.getHttpServer())
      .post(url(orderId))
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason })
      .expect(403);
    await request(app.getHttpServer())
      .post(url(orderId))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'court' })
      .expect(400);
    // Aucun champ additionnel accepté (whitelist ValidationPipe).
    await request(app.getHttpServer())
      .post(url(orderId))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason, status: 'CANCELLED', deploymentId: 'hack' })
      .expect(201); // champs extra ignorés, pas de commande détournée
    const still = await prisma.order.findUnique({ where: { id: orderId } });
    // Le dernier appel a terminé l'order (seul `reason` compte).
    expect([OrderStatus.CANCELLED]).toContain(still!.status);
    createdIds = createdIds.filter((x) => x !== orderId);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId } }).catch(() => {});
    await prisma.order.delete({ where: { id: orderId } }).catch(() => {});
  });

  it('404 order inconnu', async () => {
    await request(app.getHttpServer())
      .post(url('cm0000000000000000000000000'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(404);
  });

  it.each([OrderStatus.PROVISIONING, OrderStatus.PAID, OrderStatus.PENDING_PAYMENT, OrderStatus.REFUNDED])(
    '409 sur Order %s, aucune écriture (PROVISIONING → cancel-provisioning)',
    async (status) => {
      const id = await seedOrder(status);
      const res = await request(app.getHttpServer())
        .post(url(id))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason })
        .expect(409);
      if (status === OrderStatus.PROVISIONING) {
        expect(res.body.message).toContain('cancel-provisioning');
      }
      const row = await prisma.order.findUnique({ where: { id } });
      expect(row!.status).toBe(status);
      const histories = await prisma.orderStatusHistory.count({ where: { orderId: id } });
      expect(histories).toBe(0);
      createdIds = createdIds.filter((x) => x !== id);
      await prisma.order.delete({ where: { id } }).catch(() => {});
    },
  );

  it('ACTIVE succès → CANCELLED, Invoice PAID inchangée, Subscription CANCELLED, projet conservé', async () => {
    const fqdn = `term-full-${stamp}.example.test`;
    const id = await seedOrder(OrderStatus.ACTIVE, { domainValue: fqdn });

    const server = await prisma.server.create({
      data: { name: `term-srv-${stamp}`, hostname: `term-${stamp}.example.test` },
    });
    const clientProject = await prisma.clientProject.create({
      data: { userId, serverId: server.id, name: `client-term-${stamp}`, projectUuid: `proj-${stamp}` },
    });
    const dep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/terminate',
        appName: 'terminate-app',
        branch: 'main',
        status: 'ACTIVE',
        orderId: id,
        fqdn,
        clientProjectId: clientProject.id,
        // Pas de coolifyUuid → provider unknown (aucun appel réel).
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        number: `INV-TERM-${stamp}`,
        customerId,
        orderId: id,
        status: InvoiceStatus.PAID,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
        paidAt: new Date(),
      },
    });
    const sub = await prisma.subscription.create({
      data: { userId, productId, status: SubscriptionStatus.ACTIVE, orderId: id },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body).toMatchObject({
      orderId: id,
      orderStatus: OrderStatus.CANCELLED,
      alreadyTerminated: false,
      provider: 'unknown',
      deployment: 'kept',
      invoice: 'left_paid',
      subscription: 'cancelled',
      project: 'retained',
      partial: true,
    });

    const order = await prisma.order.findUnique({ where: { id } });
    expect(order!.status).toBe(OrderStatus.CANCELLED);

    // Invoice PAID JAMAIS touchée.
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv!.status).toBe(InvoiceStatus.PAID);
    expect(inv!.paidAt).not.toBeNull();

    // Subscription → CANCELLED (lien orderId exact).
    const s = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(s!.status).toBe(SubscriptionStatus.CANCELLED);

    // Deployment conservé (provider non confirmé), reconcileNextAt neutralisé.
    const stillDep = await prisma.deployment.findUnique({ where: { id: dep.id } });
    expect(stillDep).not.toBeNull();
    expect(stillDep!.reconcileNextAt).toBeNull();

    // Projet conservé (aucune suppression ClientProject / projet provider).
    const stillProject = await prisma.clientProject.findUnique({ where: { id: clientProject.id } });
    expect(stillProject).not.toBeNull();
    expect(stillProject!.projectUuid).toBe(`proj-${stamp}`);

    // Historique UNE seule transition CANCELLED.
    const histories = await prisma.orderStatusHistory.count({
      where: { orderId: id, status: OrderStatus.CANCELLED },
    });
    expect(histories).toBe(1);

    // Audit sans secret, action officielle, project retained.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.terminate_active_service', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const details = audit!.details as Record<string, unknown>;
    expect(details.project).toBe('retained');
    expect(details.invoice).toBe('left_paid');
    expect(details.invoicePolicy).toBe('no_auto_refund_e2b');
    expect(details.alreadyTerminated).toBe(false);
    const serialized = JSON.stringify(details);
    expect(serialized).not.toMatch(/eyJhbGciOi|Bearer |password|apiTokenEnc/i);

    await prisma.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
    await prisma.subscription.delete({ where: { id: sub.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    await prisma.clientProject.delete({ where: { id: clientProject.id } }).catch(() => {});
    await prisma.server.delete({ where: { id: server.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('CANCELLED rejeu idempotent → alreadyTerminated=true, 1 seule history, double POST', async () => {
    const id = await seedOrder(OrderStatus.ACTIVE);

    const first = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);
    expect(first.body.alreadyTerminated).toBe(false);
    expect(first.body.provider).toBe('absent'); // aucun Deployment
    expect(first.body.partial).toBe(false);

    const second = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Rejeu idempotent terminate' })
      .expect(201);
    expect(second.body.alreadyTerminated).toBe(true);
    expect(second.body.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(second.body.provider).toBe('absent');
    expect(second.body.project).toBe('retained');

    const histories = await prisma.orderStatusHistory.count({
      where: { orderId: id, status: OrderStatus.CANCELLED },
    });
    expect(histories).toBe(1);

    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('provider unknown (sans coolifyUuid) → partial + ligne conservée ; aucun autre Deployment modifié', async () => {
    const id = await seedOrder(OrderStatus.ACTIVE, { domainValue: `term-keep-${stamp}.example.test` });
    const dep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/term-keep',
        appName: 'term-keep',
        branch: 'main',
        status: 'ACTIVE',
        orderId: id,
        fqdn: `term-keep-${stamp}.example.test`,
      },
    });
    // Témoin : un AUTRE Deployment qui ne doit JAMAIS être modifié.
    const otherId = await seedOrder(OrderStatus.ACTIVE, { domainValue: `term-other-${stamp}.example.test` });
    const otherDep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/term-other',
        appName: 'term-other',
        branch: 'main',
        status: 'DEPLOYING',
        orderId: otherId,
        fqdn: `term-other-${stamp}.example.test`,
        reconcileNextAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body).toMatchObject({
      provider: 'unknown',
      deployment: 'kept',
      partial: true,
      project: 'retained',
    });

    const still = await prisma.deployment.findUnique({ where: { id: dep.id } });
    expect(still).not.toBeNull();
    expect(still!.reconcileNextAt).toBeNull();

    // L'autre Deployment totalement intact (status + éligibilité).
    const other = await prisma.deployment.findUnique({ where: { id: otherDep.id } });
    expect(other).not.toBeNull();
    expect(other!.status).toBe('DEPLOYING');
    expect(other!.reconcileNextAt).not.toBeNull();

    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: otherDep.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id && x !== otherId);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: [id, otherId] } } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
    await prisma.order.delete({ where: { id: otherId } }).catch(() => {});
  });

  it('DNS ownership exact → CS supprimée seulement si DNS confirmé ; ambiguous → conservée, partial', async () => {
    const fqdn = `term-dns-${stamp}.example.test`;
    const domain = await prisma.domain.create({
      data: { name: `term-zone-${stamp}.example.test`, zoneId: `tz-${stamp}`, status: 'ACTIVE' },
    });
    const id = await seedOrder(OrderStatus.ACTIVE, { domainValue: fqdn, effectiveDomainId: domain.id });
    const dep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/term-dns',
        appName: 'term-dns',
        branch: 'main',
        status: 'ACTIVE',
        orderId: id,
        fqdn,
        // Pas de coolifyUuid → provider unknown.
      },
    });
    // CS exacte mais SANS recordId → D2 : dns unknown, row conservée.
    const cs = await prisma.clientSubdomain.create({
      data: {
        subdomain: `term-${stamp}`,
        domainId: domain.id,
        fqdn,
        status: 'CREATED',
        deploymentId: dep.id,
        // recordId NULL → jamais interprété comme « record absent ».
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body).toMatchObject({
      dns: 'unknown',
      clientSubdomain: 'kept',
      partial: true,
    });
    const stillCs = await prisma.clientSubdomain.findUnique({ where: { id: cs.id } });
    expect(stillCs).not.toBeNull();
    expect(stillCs!.recordId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.terminate_active_service', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.details as Record<string, unknown>).csOwnership).toBe('exact');

    await prisma.clientSubdomain.delete({ where: { id: cs.id } }).catch(() => {});
    await prisma.domain.delete({ where: { id: domain.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('Order CANCELLED par cancel-provisioning ne redevient pas éligible + audit sans secret (double POST)', async () => {
    // Séparation métier : PROVISIONING → cancel ; puis terminate = rejeu.
    const id = await seedOrder(OrderStatus.PROVISIONING);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${id}/cancel-provisioning`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Annulation provisioning avant terminate' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);
    expect(res.body.alreadyTerminated).toBe(true);
    expect(res.body.project).toBe('retained');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'order.terminate_active_service', resourceId: id },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    for (const a of audits) {
      const s = JSON.stringify(a.details ?? {});
      expect(s).not.toMatch(/eyJhbGciOi|Bearer |passwordHash|apiTokenEnc/i);
    }

    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });
});
