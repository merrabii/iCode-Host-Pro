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
 * 17B.4E-D-B1 — e2e PostgreSQL du cancel idempotent (corrections D1–D5 + C1–C3).
 * Fixtures minimales via Prisma, AUCUN provider réel (pas de coolifyUuid → unknown).
 * Contrat : gate 200/409, CAS+history atomiques, double POST, invoice left_paid,
 * sub CANCELLED, refus provision force sur CANCELLED.
 * C2 : Deployment sans resourceId opaque → provider=unknown, row conservée, partial=true.
 * D2 : CS sans recordId → dns=unknown, row conservée, partial=true.
 * D3/C1 : ownership legacy prouvé (owner Customer.userId ↔ Deployment.userId) vs
 * ambiguous/foreign (jamais de suppression sans preuve).
 * C3 (CAS A) : AuditLog est append-only (ADR-019) — cette spec ne supprime JAMAIS
 * les audits ; re-exécuter la spec fait croître le journal (dette de pollution signalée).
 */
describe('Store cancel-provisioning (e2e, 17B.4E-D-B1)', () => {
  const url = (id: string) => `/${GlobalPrefix}/store/admin/orders/${id}/cancel-provisioning`;
  const provisionUrl = (id: string) => `/${GlobalPrefix}/store/admin/orders/${id}/provision`;
  const reason = 'Rollback provisioning incomplet — test e2e';

  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `canceladmin_${stamp}@example.com`;
  const userEmail = `canceluser_${stamp}@example.com`;
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
        customerName: 'Cancel E2E',
        customerEmail: `cancel-e2e-${stamp}@example.com`,
        productId,
        productName: `cancel-e2e-${stamp}`,
        status,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
        domainType: 'FREE_SUBDOMAIN',
        domainValue: opts?.domainValue ?? `cancel-${stamp}.example.test`,
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
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN, name: 'CancelAdmin' },
    });
    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER, name: 'CancelUser' },
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
    const product = await prisma.product.create({ data: { name: `cancel-e2e-${stamp}` } });
    productId = product.id;
    const customer = await prisma.customer.create({
      data: { email: `cancel-cust-${stamp}@example.com`, name: 'Cancel E2E', userId },
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
    await prisma.customer.deleteMany({ where: { email: `cancel-cust-${stamp}@example.com` } }).catch(() => {});
    await prisma.product.deleteMany({ where: { name: `cancel-e2e-${stamp}` } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    // C3 CAS A : les AuditLog ne sont JAMAIS supprimés ici (append-only ADR-019).
    await app.close();
  });

  it('401 sans token, 403 USER, 400 reason court', async () => {
    const orderId = await seedOrder(OrderStatus.PROVISIONING);
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
    const still = await prisma.order.findUnique({ where: { id: orderId } });
    expect(still!.status).toBe(OrderStatus.PROVISIONING);
    createdIds = createdIds.filter((x) => x !== orderId);
    await prisma.order.delete({ where: { id: orderId } }).catch(() => {});
  });

  it('404 order inconnu', async () => {
    await request(app.getHttpServer())
      .post(url('cm0000000000000000000000000'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(404);
  });

  it.each([OrderStatus.PAID, OrderStatus.ACTIVE, OrderStatus.SUSPENDED, OrderStatus.REFUNDED, OrderStatus.PENDING_PAYMENT])(
    '409 sur Order %s, aucune écriture',
    async (status) => {
      const id = await seedOrder(status);
      await request(app.getHttpServer())
        .post(url(id))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason })
        .expect(409);
      const row = await prisma.order.findUnique({ where: { id } });
      expect(row!.status).toBe(status);
      createdIds = createdIds.filter((x) => x !== id);
      await prisma.order.delete({ where: { id } }).catch(() => {});
    },
  );

  it('C2 — Deployment SANS coolifyUuid → provider=unknown, row CONSERVÉE, partial=true, dns skipped', async () => {
    const id = await seedOrder(OrderStatus.PROVISIONING, { domainValue: `nouniq-${stamp}.example.test` });

    const dep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/cancel-nouuid',
        appName: 'cancel-nouuid',
        branch: 'main',
        status: 'DEPLOYING',
        orderId: id,
        fqdn: `nouniq-${stamp}.example.test`,
        reconcileNextAt: new Date(Date.now() + 60_000),
        // coolifyUuid NULL volontaire (C2) → unknown, jamais « skipped » confirmé.
      },
    });
    createdIds.push(id);

    const invoice = await prisma.invoice.create({
      data: {
        number: `INV-CANCEL-NU-${stamp}`,
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
      alreadyCancelled: false,
      provider: 'unknown',
      dns: 'skipped',
      deployment: 'kept',
      clientSubdomain: 'absent',
      invoice: 'left_paid',
      subscription: 'cancelled',
      partial: true,
    });

    const order = await prisma.order.findUnique({ where: { id } });
    expect(order!.status).toBe(OrderStatus.CANCELLED);

    const stillDep = await prisma.deployment.findUnique({ where: { id: dep.id } });
    expect(stillDep).not.toBeNull();
    expect(stillDep!.coolifyUuid).toBeNull();
    expect(stillDep!.reconcileNextAt).toBeNull();

    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv!.status).toBe(InvoiceStatus.PAID);

    const s = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(s!.status).toBe(SubscriptionStatus.CANCELLED);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.cancel_provisioning', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const details = audit!.details as Record<string, unknown>;
    expect(details.provider).toBe('unknown');
    expect(details.partial).toBe(true);

    // Double POST : rejoue unknown/kept (row toujours présente sans resourceId).
    const second = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Rejeu idempotent unknown' })
      .expect(201);
    expect(second.body.alreadyCancelled).toBe(true);
    expect(second.body.provider).toBe('unknown');
    expect(second.body.deployment).toBe('kept');
    expect(second.body.partial).toBe(true);
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).not.toBeNull();

    await prisma.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
    await prisma.subscription.delete({ where: { id: sub.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('D2 — CS exact sans recordId → dns=unknown, row CONSERVÉE, partial=true (pas de suppression CF)', async () => {
    const fqdn = `d2-${stamp}.example.test`;
    const id = await seedOrder(OrderStatus.PROVISIONING, { domainValue: fqdn });
    const dep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/cancel-d2',
        appName: 'cancel-d2',
        branch: 'main',
        status: 'DEPLOYING',
        orderId: id,
        fqdn,
        reconcileNextAt: new Date(Date.now() + 60_000),
        // Pas de coolifyUuid → C2 provider=unknown (jamais skipped confirmé).
      },
    });
    const domain = await prisma.domain.create({
      data: {
        name: `d2-zone-${stamp}.example.test`,
        zoneId: `d2-${stamp}`,
        status: 'ACTIVE',
      },
    });
    const cs = await prisma.clientSubdomain.create({
      data: {
        subdomain: `d2-${stamp}`,
        domainId: domain.id,
        fqdn,
        status: 'CREATED',
        deploymentId: dep.id,
        // recordId NULL volontaire (pas de CF réel) → D2 unknown, jamais « absent »
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body).toMatchObject({
      provider: 'unknown',
      dns: 'unknown',
      deployment: 'kept',
      clientSubdomain: 'kept',
      partial: true,
    });

    // C2 : sans resourceId, le Deployment n'est JAMAIS supprimé localement.
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).not.toBeNull();
    const stillCs = await prisma.clientSubdomain.findUnique({ where: { id: cs.id } });
    expect(stillCs).not.toBeNull();
    expect(stillCs!.recordId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.cancel_provisioning', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.details as Record<string, unknown>).dns).toBe('unknown');
    expect((audit!.details as Record<string, unknown>).provider).toBe('unknown');

    await prisma.clientSubdomain.delete({ where: { id: cs.id } }).catch(() => {});
    await prisma.domain.delete({ where: { id: domain.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('C1 — CS legacy fqdn + domainId + owner concordant (Deployment.userId ↔ Customer.userId) → legacy_proven, sans recordId → dns unknown/kept', async () => {
    const fqdn = `legacy-${stamp}.example.test`;
    const domain = await prisma.domain.create({
      data: { name: `legacy-zone-${stamp}.example.test`, zoneId: `lz-${stamp}`, status: 'ACTIVE' },
    });
    const id = await seedOrder(OrderStatus.PROVISIONING, {
      domainValue: fqdn,
      effectiveDomainId: domain.id,
    });
    // Deployment de référence obligatoire pour prouver l'ownership (C1).
    const dep = await prisma.deployment.create({
      data: {
        userId, // concorde avec Customer.userId
        repoFullName: 'e2e/cancel-legacy',
        appName: 'cancel-legacy',
        branch: 'main',
        status: 'DEPLOYING',
        orderId: id,
        fqdn,
        // pas de coolifyUuid → C2 provider=unknown
      },
    });
    const cs = await prisma.clientSubdomain.create({
      data: {
        subdomain: `legacy-${stamp}`,
        domainId: domain.id,
        fqdn,
        status: 'CREATED',
        // deploymentId NULL volontaire (path store historique)
        // recordId NULL → D2 : jamais interprété comme « record absent »
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    // Ownership prouvé (legacy_proven) mais recordId absent → unknown/kept, partial=true.
    expect(res.body.clientSubdomain).toBe('kept');
    expect(res.body.dns).toBe('unknown');
    expect(res.body.provider).toBe('unknown');
    expect(res.body.deployment).toBe('kept');
    expect(res.body.partial).toBe(true);
    expect(await prisma.clientSubdomain.findUnique({ where: { id: cs.id } })).not.toBeNull();
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.cancel_provisioning', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.details as Record<string, unknown>).csOwnership).toBe('legacy_proven');

    await prisma.clientSubdomain.delete({ where: { id: cs.id } }).catch(() => {});
    await prisma.domain.delete({ where: { id: domain.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: dep.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('C1 — legacy SANS Deployment de référence → ambiguous, row CONSERVÉE, partial=true, aucun appel CF', async () => {
    const fqdn = `amb-${stamp}.example.test`;
    const domainOrder = await prisma.domain.create({
      data: { name: `amb-order-${stamp}.example.test`, zoneId: `amb-o-${stamp}`, status: 'ACTIVE' },
    });
    const domainCs = await prisma.domain.create({
      data: { name: `amb-cs-${stamp}.example.test`, zoneId: `amb-c-${stamp}`, status: 'ACTIVE' },
    });
    const id = await seedOrder(OrderStatus.PROVISIONING, {
      domainValue: fqdn,
      effectiveDomainId: domainOrder.id,
    });
    const cs = await prisma.clientSubdomain.create({
      data: {
        subdomain: `amb-${stamp}`,
        domainId: domainCs.id, // domaine DIFFÉRENT de effectiveDomainId
        fqdn,
        status: 'CREATED',
        recordId: 'rec-should-not-delete',
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body.clientSubdomain).toBe('kept');
    expect(res.body.dns).toBe('unknown');
    expect(res.body.partial).toBe(true);
    expect(await prisma.clientSubdomain.findUnique({ where: { id: cs.id } })).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.cancel_provisioning', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.details as Record<string, unknown>).csOwnership).toBe('ambiguous');

    await prisma.clientSubdomain.delete({ where: { id: cs.id } }).catch(() => {});
    await prisma.domain.deleteMany({
      where: { id: { in: [domainOrder.id, domainCs.id] } },
    }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('C1 — CS.deploymentId d’un AUTRE Deployment → foreign, conservée, partial=true, aucun delete', async () => {
    const fqdn = `foreign-${stamp}.example.test`;
    const domain = await prisma.domain.create({
      data: { name: `foreign-zone-${stamp}.example.test`, zoneId: `fz-${stamp}`, status: 'ACTIVE' },
    });
    const id = await seedOrder(OrderStatus.PROVISIONING, {
      domainValue: fqdn,
      effectiveDomainId: domain.id,
    });
    const otherOrder = await prisma.order.create({
      data: {
        customerId,
        customerName: 'Foreign Host',
        customerEmail: `foreign-${stamp}@example.com`,
        productId,
        productName: `foreign-${stamp}`,
        status: OrderStatus.ACTIVE,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
        domainType: 'FREE_SUBDOMAIN',
        domainValue: `foreign-host-${stamp}.example.test`,
        domainStatus: 'READY',
      },
    });
    const otherDep = await prisma.deployment.create({
      data: {
        userId,
        repoFullName: 'e2e/foreign',
        appName: 'foreign-app',
        branch: 'main',
        status: 'ACTIVE',
        orderId: otherOrder.id,
        coolifyUuid: 'uuid-foreign-e2e',
      },
    });
    const cs = await prisma.clientSubdomain.create({
      data: {
        subdomain: `foreign-${stamp}`,
        domainId: domain.id,
        fqdn,
        status: 'CREATED',
        recordId: 'rec-foreign-keep',
        deploymentId: otherDep.id, // Appartient à un AUTRE déploiement
      },
    });

    const res = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    expect(res.body.clientSubdomain).toBe('kept');
    expect(res.body.dns).toBe('unknown');
    expect(res.body.partial).toBe(true);
    expect(await prisma.clientSubdomain.findUnique({ where: { id: cs.id } })).not.toBeNull();
    expect(await prisma.deployment.findUnique({ where: { id: otherDep.id } })).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'order.cancel_provisioning', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.details as Record<string, unknown>).csOwnership).toBe('foreign');

    await prisma.clientSubdomain.delete({ where: { id: cs.id } }).catch(() => {});
    await prisma.domain.delete({ where: { id: domain.id } }).catch(() => {});
    await prisma.deployment.delete({ where: { id: otherDep.id } }).catch(() => {});
    await prisma.order.delete({ where: { id: otherOrder.id } }).catch(() => {});
    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('double POST sans Deployment → 200 alreadyCancelled idempotent, provider=absent, partial=false', async () => {
    const id = await seedOrder(OrderStatus.PROVISIONING, { domainValue: `replay-${stamp}.example.test` });

    const first = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);
    expect(first.body.alreadyCancelled).toBe(false);
    expect(first.body.provider).toBe('absent');
    expect(first.body.partial).toBe(false);

    const second = await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Rejeu idempotent e2e' })
      .expect(201);
    expect(second.body.alreadyCancelled).toBe(true);
    expect(second.body.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(second.body.provider).toBe('absent');
    expect(second.body.partial).toBe(false);

    const histories = await prisma.orderStatusHistory.count({
      where: { orderId: id, status: OrderStatus.CANCELLED },
    });
    expect(histories).toBe(1);

    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });

  it('cancel puis provision force=1 → 409 (jamais re-provision)', async () => {
    const id = await seedOrder(OrderStatus.PROVISIONING);

    await request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(201);

    await request(app.getHttpServer())
      .post(`${provisionUrl(id)}?force=1`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    const order = await prisma.order.findUnique({ where: { id } });
    expect(order!.status).toBe(OrderStatus.CANCELLED);

    createdIds = createdIds.filter((x) => x !== id);
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: id } }).catch(() => {});
    await prisma.order.delete({ where: { id } }).catch(() => {});
  });
});
