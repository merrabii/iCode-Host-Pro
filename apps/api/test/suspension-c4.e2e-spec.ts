import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  BillingCycle,
  DeploymentStatus,
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { C4ProtocolService } from './../src/hosting/c4-protocol.service';
import {
  PanelTarget,
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

/**
 * Q12-P3 — effets de suspension sous PROTOCOLE C4 (e2e, PostgreSQL réel,
 * `HOSTING_C4_ENABLED=true` — les 5 tables C4 vivent dans la base) :
 *
 *  1. **Arrêt opposable** : un `C4StopRequest` couvre la cible →
 *     `beginDispatch` REFUSE, transport JAMAIS appelé, aucune tentative
 *     créée, blocage audité (`c4_refuse`) — le statut bascule quand même ;
 *  2. **Bascule OFF avant dispatch** : flag relu à l'appel → AUCUNE table C4
 *     lue ni écrite (0 tentative), appel direct (contrat historique) ;
 *  3. **Arrêt/reprise concurrents sur provider lent** : la tentative ouverte
 *     (avec allocation de l'app) RÉFUSE le second dispatch — jamais deux
 *     arrêts/relances concurrents chez le provider ; après settle, une
 *     nouvelle action rejoue l'effet (récupération) ;
 *  4. **Timeout ambigu** : consignation `UNKNOWN` (incertitude durable, sans
 *     requalification) → toute re-dispatch est REFUSÉE jusqu'à résolution
 *     (aucun contournement de l'incertitude) ;
 *  5. **Succès provider puis échec de consignation** : la tentative reste
 *     DISPATCHED, l'effet n'est JAMAIS compté `done`, échec visible audité.
 *
 * Aucun réseau : PanelTransportFactory + MailTransportFactory stubbés.
 */
describe('Suspension sous C4 — e2e PostgreSQL réel (Q12-P3)', () => {
  process.env.HOSTING_C4_ENABLED = 'true';
  process.env.ORDER_SWEEP_ENABLED = 'false';
  process.env.RENEWAL_SWEEP_ENABLED = 'false';
  delete process.env.HOSTING_C3_ENABLED;

  let app: INestApplication;
  let prisma: PrismaService;
  let c4: C4ProtocolService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p3c4admin_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let productId = '';
  let srvId = '';

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  const stopCalls: string[] = [];
  const startCalls: string[] = [];
  const deleteCalls: string[] = [];
  /** Comportement provider programmable par uuid (deferred = provider lent). */
  let stopImpl: (uuid: string) => Promise<void> = async () => undefined;
  let startImpl: (uuid: string) => Promise<void> = async () => undefined;

  const fakeTransport = {
    stopApplication: jest.fn(async (_t: PanelTarget, uuid: string) => {
      stopCalls.push(uuid);
      return stopImpl(uuid);
    }),
    startApplication: jest.fn(async (_t: PanelTarget, uuid: string) => {
      startCalls.push(uuid);
      return startImpl(uuid);
    }),
    deleteApplication: jest.fn(async (uuid: string) => {
      deleteCalls.push(uuid);
      throw new Error('SUPPRESSION INTERDITE');
    }),
  };
  const fakePanelFactory = { create: () => fakeTransport } as unknown as PanelTransportFactory;

  interface Node {
    subId: string;
    svcId: string;
    depId: string;
    uuid: string;
    userId: string;
  }
  const nodes: Record<'A' | 'B' | 'C' | 'D' | 'E', Node> = {
    A: { subId: '', svcId: '', depId: '', uuid: 'uuid-a', userId: '' },
    B: { subId: '', svcId: '', depId: '', uuid: 'uuid-b', userId: '' },
    C: { subId: '', svcId: '', depId: '', uuid: 'uuid-c', userId: '' },
    D: { subId: '', svcId: '', depId: '', uuid: 'uuid-d', userId: '' },
    E: { subId: '', svcId: '', depId: '', uuid: 'uuid-e', userId: '' },
  };

  async function waitFor<T>(
    label: string,
    fn: () => Promise<T>,
    pred: (t: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 15_000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (pred(value)) return value;
        last = value;
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout (15s) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`);
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function patchSubscription(id: string, status: string) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });
  }

  const attemptsOf = (depId: string) =>
    prisma.c4ProviderAttempt.findMany({
      where: { scopeId: depId },
      orderBy: { dispatchedAt: 'asc' },
    });

  // ── Boot + fixtures ───────────────────────────────────────────────────────
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    c4 = moduleRef.get(C4ProtocolService);
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();
    const crypto = moduleRef.get(CryptoService);

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    adminToken = await login(adminEmail);

    const server = await prisma.server.create({
      data: {
        name: `p3c4-srv-${stamp}`,
        hostname: 'panel.test',
        panelProvider: 'COOLIFY',
        apiBaseUrl: 'http://panel.test:8000/api/v1',
        apiTokenEnc: crypto.encrypt(`p3c4-tok-${stamp}`),
        strictTls: true,
      },
    });
    srvId = server.id;

    const product = await prisma.product.create({
      data: { name: `p3c4-prod-${stamp}`, billingCycle: BillingCycle.MONTHLY, priceHtCents: 1000 },
    });
    productId = product.id;

    for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
      const n = nodes[k];
      const email = `p3c4-${k.toLowerCase()}_${stamp}@example.com`;
      const user = await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
      });
      n.userId = user.id;
      const sub = await prisma.subscription.create({
        data: { userId: user.id, productId, status: SubscriptionStatus.ACTIVE },
      });
      n.subId = sub.id;
      const svc = await prisma.hostingService.create({
        data: {
          userId: user.id,
          subscriptionId: sub.id,
          productId,
          status: HostingServiceStatus.ACTIVE,
          ramMbSnapshot: 512,
          cpuCoresSnapshot: 1,
        },
      });
      n.svcId = svc.id;
      const dep = await prisma.deployment.create({
        data: {
          userId: user.id,
          serverId: srvId,
          repoFullName: `p3c4-${k.toLowerCase()}/app`,
          coolifyUuid: n.uuid,
          status: DeploymentStatus.ACTIVE,
        },
      });
      n.depId = dep.id;
      await prisma.hostingServiceAllocation.create({
        data: {
          hostingServiceId: svc.id,
          deploymentId: dep.id,
          idempotencyKey: `p3c4-${k}-${stamp}`,
          status: HostingServiceAllocationStatus.BOUND,
        },
      });
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        const depIds = Object.values(nodes).map((n) => n.depId);
        const svcIds = Object.values(nodes).map((n) => n.svcId);
        const subIds = Object.values(nodes).map((n) => n.subId);
        const userIds = Object.values(nodes).map((n) => n.userId);
        await prisma.c4ProviderAttempt.deleteMany({ where: { scopeId: { in: depIds } } }).catch(() => undefined);
        await prisma.c4Takeover.deleteMany({ where: { scopeId: { in: depIds } } }).catch(() => undefined);
        await prisma.c4StopRequest.deleteMany({ where: { scopeId: { in: depIds } } }).catch(() => undefined);
        await prisma.hostingServiceAllocation.deleteMany({ where: { hostingServiceId: { in: svcIds } } }).catch(() => undefined);
        await prisma.deployment.deleteMany({ where: { id: { in: depIds } } }).catch(() => undefined);
        await prisma.hostingService.deleteMany({ where: { id: { in: svcIds } } }).catch(() => undefined);
        await prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
        await prisma.product.delete({ where: { id: productId } }).catch(() => undefined);
        await prisma.server.delete({ where: { id: srvId } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
      }
    } catch {
      // meilleur effort
    }
    delete process.env.HOSTING_C4_ENABLED;
    if (app) await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — arrêt opposable
  // ═══════════════════════════════════════════════════════════════════════
  it('arrêt opposable sur la cible → dispatch REFUSÉ, zéro transport, zéro tentative, statut basculé', async () => {
    await c4.requestStop({
      scope: { type: 'DEPLOYMENT', id: nodes.A.depId },
      reason: `p3c4-opposable-${stamp}`,
    });

    const r = await patchSubscription(nodes.A.subId, 'SUSPENDED').expect(200);
    expect(r.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 1, failed: 0 });

    // Jamais de dispatch : transport intact, AUCUNE tentative créée (refus
    // AVANT l'émission), blocage audité.
    expect(stopCalls).not.toContainEqual(nodes.A.uuid);
    expect(deleteCalls).toHaveLength(0);
    expect(await attemptsOf(nodes.A.depId)).toHaveLength(0);
    const blocked = await prisma.auditLog.findFirst({
      where: { action: 'suspension.app_stop_blocked', resourceId: nodes.A.depId },
    });
    expect(blocked).not.toBeNull();
    expect((blocked!.details as { reason?: string }).reason).toBe('c4_refuse');

    // Le statut métier bascule malgré tout (effets = best-effort post-commit).
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: nodes.A.subId },
      select: { status: true },
    });
    expect(sub.status).toBe(SubscriptionStatus.SUSPENDED);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — bascule OFF avant dispatch
  // ═══════════════════════════════════════════════════════════════════════
  it('bascule OFF pendant l\u2019exécution → dispatch direct, AUCUNE table C4 écrite', async () => {
    const prior = process.env.HOSTING_C4_ENABLED;
    process.env.HOSTING_C4_ENABLED = 'false';
    try {
      const r = await patchSubscription(nodes.B.subId, 'SUSPENDED').expect(200);
      expect(r.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
      expect(stopCalls).toContainEqual(nodes.B.uuid);
      // Aucune tentative C4 : le OFF ne lit ni n'écrit les tables du protocole.
      expect(await attemptsOf(nodes.B.depId)).toHaveLength(0);
      expect(await prisma.c4Takeover.count({ where: { scopeId: nodes.B.depId } })).toBe(0);
      // Reprise DANS la même fenêtre OFF : toujours aucune écriture C4.
      const r2 = await patchSubscription(nodes.B.subId, 'ACTIVE').expect(200);
      expect(r2.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
      expect(startCalls).toContainEqual(nodes.B.uuid);
      expect(await attemptsOf(nodes.B.depId)).toHaveLength(0);
      expect(await prisma.c4Takeover.count({ where: { scopeId: nodes.B.depId } })).toBe(0);
    } finally {
      process.env.HOSTING_C4_ENABLED = prior;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — arrêt/reprise concurrents, provider lent
  // ═══════════════════════════════════════════════════════════════════════
  it('provider lent : reprise CONCURRENTTE refusée tant que l\u2019arrêt est en vol, puis récupération', async () => {
    let releaseStop: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    stopImpl = async (uuid) => {
      if (uuid === nodes.C.uuid) await gate;
    };
    try {
      // Requête démarrée EXPLICITEMENT (`.end`) : elle reste en vol pendant
      // que la reprise concurrente est tentée.
      const p1 = new Promise<request.Response>((resolve, reject) => {
        patchSubscription(nodes.C.subId, 'SUSPENDED')
          .expect(200)
          .end((err, res) => (err ? reject(err) : resolve(res)));
      });
      // L'arrêt est committé + la tentative DISPATCHED + le transport EN VOL.
      await waitFor(
        'stop in flight',
        async () => ({
          open: await prisma.c4ProviderAttempt.count({
            where: { scopeId: nodes.C.depId, phase: 'DISPATCHED' },
          }),
          called: stopCalls.filter((u) => u === nodes.C.uuid).length,
        }),
        (s) => s.open >= 1 && s.called >= 1,
      );

      // Reprise concurrente : AUCUNE course provider — le dispatch est REFUSÉ.
      const r2 = await patchSubscription(nodes.C.subId, 'ACTIVE').expect(200);
      expect(r2.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 1, failed: 0 });
      expect(startCalls).not.toContainEqual(nodes.C.uuid);

      // Le provider lent finit : l'arrêt se consigne SUCCESS.
      releaseStop();
      const r1 = await p1;
      expect(r1.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
      const attempts = await attemptsOf(nodes.C.depId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].phase).toBe('RETURNED');
      expect(attempts[0].outcome).toBe('SUCCESS');

      // Récupération : la tentative est close → une nouvelle action rejoue
      // l'effet (aucun blocage résiduel).
      const r3 = await patchSubscription(nodes.C.subId, 'SUSPENDED').expect(200);
      expect(r3.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
      expect(await attemptsOf(nodes.C.depId)).toHaveLength(2);
      expect(deleteCalls).toHaveLength(0);
    } finally {
      stopImpl = async () => undefined;
      releaseStop();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 — timeout ambigu → UNKNOWN, aucun contournement
  // ═══════════════════════════════════════════════════════════════════════
  it('timeout ambigu → tentative UNKNOWN (jamais requalifiée) et reprise REFUSÉE tant que non résolue', async () => {
    stopImpl = async (uuid) => {
      if (uuid === nodes.D.uuid) throw new Error('ETIMEDOUT');
    };
    try {
      const r = await patchSubscription(nodes.D.subId, 'SUSPENDED').expect(200);
      expect(r.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 0, failed: 1 });

      const attempts = await attemptsOf(nodes.D.depId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].phase).toBe('RETURNED');
      // Ambiguïté consignée comme telle : PAS de « failed connu », PAS de succès.
      expect(attempts[0].outcome).toBe('UNKNOWN');
      expect(attempts[0].outcome).not.toBe('FAILED_RETRYABLE');

      // Aucun contournement : tant que l'incertitude n'est pas résolue, la
      // reprise est REFUSÉE (aucun dispatch, zéro appel transport).
      const r2 = await patchSubscription(nodes.D.subId, 'ACTIVE').expect(200);
      expect(r2.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 1, failed: 0 });
      expect(startCalls).not.toContainEqual(nodes.D.uuid);
      expect(await attemptsOf(nodes.D.depId)).toHaveLength(1); // pas de 2e tentative
      expect(deleteCalls).toHaveLength(0);
    } finally {
      stopImpl = async () => undefined;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 — succès provider puis échec de consignation
  // ═══════════════════════════════════════════════════════════════════════
  it('succès provider puis échec de consignation → JAMAIS done, tentative laissée DISPATCHED, échec audité', async () => {
    const spy = jest.spyOn(c4, 'settleStandalone').mockRejectedValueOnce(new Error('pg down'));
    try {
      const r = await patchSubscription(nodes.E.subId, 'SUSPENDED').expect(200);
      // Le transport a RÉUSSI mais la consignation a échoué : aucun requalification.
      expect(stopCalls).toContainEqual(nodes.E.uuid);
      expect(r.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 0, failed: 1 });

      const attempts = await attemptsOf(nodes.E.depId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].phase).toBe('DISPATCHED'); // incertitude conservée
      expect(attempts[0].outcome).toBeNull();

      const failAudit = await prisma.auditLog.findFirst({
        where: { action: 'suspension.app_stop_failed', resourceId: nodes.E.depId },
      });
      expect(failAudit).not.toBeNull();
      expect(String((failAudit!.details as { detail?: string }).detail)).toContain('non consigné');
      expect(deleteCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
