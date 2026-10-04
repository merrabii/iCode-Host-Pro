import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  BillingCycle,
  HostingServiceStatus,
  InvoiceStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { CryptoService } from './../src/crypto/crypto.service';
import {
  PanelTarget,
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Sweeps (timers) OFF : déclenchement à la demande (horloge accélérée en base).
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';
// Q5 : C4 OFF ici (protocole C4 du moteur d'effets = unit suspension-effects).
delete process.env.HOSTING_C4_ENABLED;

/**
 * Q5 (GO item 5) — suspension / réactivation réversibles (e2e, socle) :
 *
 *  1. Portée stricte : UNE facture impayée n'affecte que SON abonnement —
 *     plusieurs abonnements du MÊME client restent intacts (le dernier actif
 *     n'est JAMAIS choisi) ; services hébergement du seul abonnement concerné
 *     basculent dans la même transaction que le CAS.
 *  2. Effets provider : arrêt réversible (`stopApplication`) des apps de
 *     l'abonnement suspendu — JAMAIS `deleteApplication` (zéro suppression) ;
 *     l'app du sœur resté actif n'est ni arrêtée ni touchée.
 *  3. Nouveaux déploiements bloqués pendant la suspension (403 explicite).
 *  4. Réactivation contrôlée admin (SUSPENDED → ACTIVE) : relance
 *     (`startApplication`), AUCUNE écriture de facture (sans double
 *     facturation), effets RETOURNÉS dans la réponse.
 *  5. Capacité provider manquante (panneau non Coolify) → blocage EXPLICITE
 *     comptabilisé dans `effects.blocked`, l'action de statut POURSUIT.
 *  6. Course paiement/suspension : règlement d'abord → aucune suspension ;
 *     règlement concurrent → facture PAID + cohérence (aucun crash, toute
 *     suspension avérée porte son audit `subscription.auto_suspend`).
 *  7. Email client honnête : décrit l'arrêt réversible constaté, JAMAIS
 *     « l'accès est suspendu » sur un simple changement de statut.
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée (icode_host_pro_socle).
 */
describe('Suspension / réactivation réversibles (e2e, Q5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `q5admin_${stamp}@example.com`;
  const danEmail = `q5dan_${stamp}@example.com`;
  const emmaEmail = `q5emma_${stamp}@example.com`;
  const fayEmail = `q5fay_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let danToken = '';
  let emmaToken = '';

  let danUserId = '';
  let emmaUserId = '';
  let fayUserId = '';
  let danCustomerId = '';
  let emmaCustomerId = '';
  let fayCustomerId = '';

  let productId = '';
  let danSubA = ''; // suspendu (facture UNPAID impayée)
  let danSubB = ''; // intact (facture PAID) ; puis suspension admin → HESTIA
  let emmaSub = ''; // suspendu puis réactivé admin
  let faySub = ''; // course paiement/suspension
  let hsA = '';
  let hsB = '';
  let hsE = '';
  let invA = '';
  let invB = '';
  let invE = '';
  let invF = '';
  let invG = '';
  let createdMailId: string | null = null;
  const numbers: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  // Transport factice : journalise chaque tentative ; `deleteApplication`
  // échoue BRUYAMMENT (aucune suppression n'est jamais permise en Q5).
  const stopCalls: Array<{ provider: string; uuid: string }> = [];
  const startCalls: Array<{ provider: string; uuid: string }> = [];
  const deleteCalls: string[] = [];
  const capabilityGuard = (target: PanelTarget, uuid: string, log: typeof stopCalls) => {
    log.push({ provider: target.provider, uuid });
    if (target.provider !== 'COOLIFY') {
      // Contrat réel de NodePanelTransport.assertCoolify (capacité absente).
      throw new Error(
        "Cette opération n'est pas disponible pour ce fournisseur (Coolify uniquement).",
      );
    }
  };
  const fakeTransport = {
    stopApplication: jest.fn(async (target: PanelTarget, uuid: string) =>
      capabilityGuard(target, uuid, stopCalls),
    ),
    startApplication: jest.fn(async (target: PanelTarget, uuid: string) =>
      capabilityGuard(target, uuid, startCalls),
    ),
    deleteApplication: jest.fn(async (uuid: string) => {
      deleteCalls.push(uuid);
      throw new Error('SUPPRESSION INTERDITE EN Q5');
    }),
  };
  const fakePanelFactory = {
    create: () => fakeTransport,
  } as unknown as PanelTransportFactory;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  /** Un passage complet du scheduler (admin). */
  function sweep(token = adminToken) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/renewal/sweep`)
      .set('Authorization', `Bearer ${token}`);
  }

  function patchSubscription(id: string, status: string, token = adminToken) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });
  }

  /** Mail capturé dont le sujet porte `subjectNeedle` (et, si précisé,
   *  adressé à `toNeedle`) — le rappel d'impayé porte aussi le numéro. */
  function findMail(
    subjectNeedle: string,
    toNeedle?: string,
  ): { to?: string; subject?: string; text?: string } | undefined {
    for (const call of mailTransportStub.sendMail.mock.calls) {
      for (const arg of call) {
        if (
          arg &&
          typeof arg === 'object' &&
          String((arg as { subject?: string }).subject ?? '').includes(subjectNeedle) &&
          (!toNeedle || String((arg as { to?: string }).to ?? '').includes(toNeedle))
        ) {
          return arg as { to?: string; subject?: string; text?: string };
        }
      }
    }
    return undefined;
  }

  const mkNumber = (tag: string) => {
    const n = `Q5-${tag}-${stamp}`;
    numbers.push(n);
    return n;
  };

  // ── Boot + fixtures ────────────────────────────────────────────────────────
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
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();
    const crypto = moduleRef.get(CryptoService);

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: { email, name, passwordHash: await bcrypt.hash(password, 10), role },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin Q5');
    await mkUser(danEmail, Role.USER, 'Dan Q5');
    await mkUser(emmaEmail, Role.USER, 'Emma Q5');
    await mkUser(fayEmail, Role.USER, 'Fay Q5');
    adminToken = await login(adminEmail);
    danToken = await login(danEmail);
    emmaToken = await login(emmaEmail);
    await login(fayEmail); // sanity : le compte existe (aucun appel HTTP pour fay)

    const users = await prisma.user.findMany({
      where: { email: { in: [danEmail, emmaEmail, fayEmail] } },
      select: { id: true, email: true },
    });
    danUserId = users.find((u) => u.email === danEmail)!.id;
    emmaUserId = users.find((u) => u.email === emmaEmail)!.id;
    fayUserId = users.find((u) => u.email === fayEmail)!.id;

    const mkCustomer = async (userId: string, email: string, name: string) => {
      const c = await prisma.customer.upsert({
        where: { userId },
        update: {},
        create: { userId, email, name },
      });
      return c.id;
    };
    danCustomerId = await mkCustomer(danUserId, danEmail, 'Dan Q5');
    emmaCustomerId = await mkCustomer(emmaUserId, emmaEmail, 'Emma Q5');
    fayCustomerId = await mkCustomer(fayUserId, fayEmail, 'Fay Q5');

    const product = await prisma.product.create({
      data: { name: `Q5 prod ${stamp}`, billingCycle: BillingCycle.MONTHLY, priceHtCents: 1000 },
    });
    productId = product.id;

    // Serveurs panneau (jetons chiffrés par le VRAI CryptoService) :
    // coolify = capacité OK ; hestia = capacité ABSENTE pour stop/start.
    const coolify = await prisma.server.create({
      data: {
        name: `q5-coolify-${stamp}`,
        hostname: 'panel-coolify.test',
        panelProvider: 'COOLIFY',
        apiBaseUrl: 'https://panel-coolify.test/api/v1',
        apiTokenEnc: crypto.encrypt(`q5-tok-${stamp}`),
        strictTls: true,
      },
    });
    const hestia = await prisma.server.create({
      data: {
        name: `q5-hestia-${stamp}`,
        hostname: 'panel-hestia.test',
        panelProvider: 'HESTIA',
        apiBaseUrl: 'https://panel-hestia.test:8083',
        apiTokenEnc: crypto.encrypt(`q5-tok-${stamp}`),
        strictTls: false,
      },
    });

    const mkSub = async (userId: string) =>
      (
        await prisma.subscription.create({
          data: { userId, productId, status: SubscriptionStatus.ACTIVE },
        })
      ).id;
    danSubA = await mkSub(danUserId);
    danSubB = await mkSub(danUserId);
    emmaSub = await mkSub(emmaUserId);
    faySub = await mkSub(fayUserId);

    const mkService = async (userId: string, subscriptionId: string) =>
      (
        await prisma.hostingService.create({
          data: {
            userId,
            subscriptionId,
            status: HostingServiceStatus.ACTIVE,
            ramMbSnapshot: 512,
            cpuCoresSnapshot: 1,
          },
        })
      ).id;
    hsA = await mkService(danUserId, danSubA);
    hsB = await mkService(danUserId, danSubB);
    hsE = await mkService(emmaUserId, emmaSub);

    await prisma.deployment.createMany({
      data: [
        {
          userId: danUserId,
          serverId: coolify.id,
          hostingServiceId: hsA,
          repoFullName: 'dan/app-a',
          coolifyUuid: 'uuid-dan-a',
          status: 'ACTIVE',
        },
        {
          userId: danUserId,
          serverId: hestia.id,
          hostingServiceId: hsB,
          repoFullName: 'dan/app-b',
          coolifyUuid: 'uuid-dan-b',
          status: 'ACTIVE',
        },
        {
          userId: emmaUserId,
          serverId: coolify.id,
          hostingServiceId: hsE,
          repoFullName: 'emma/app-e',
          coolifyUuid: 'uuid-emma-e',
          status: 'ACTIVE',
        },
      ],
    });

    invA = (
      await prisma.invoice.create({
        data: {
          number: mkNumber('A'),
          customerId: danCustomerId,
          subscriptionId: danSubA,
          status: InvoiceStatus.UNPAID,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          dueDate: daysAgo(20), // au-delà du délai de grâce (14 j)
        },
      })
    ).id;
    invB = (
      await prisma.invoice.create({
        data: {
          number: mkNumber('B'),
          customerId: danCustomerId,
          subscriptionId: danSubB,
          status: InvoiceStatus.PAID, // réglée → AUCUNE suspension
          paidAt: new Date(),
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          dueDate: daysAgo(20),
        },
      })
    ).id;
    invE = (
      await prisma.invoice.create({
        data: {
          number: mkNumber('E'),
          customerId: emmaCustomerId,
          subscriptionId: emmaSub,
          status: InvoiceStatus.UNPAID,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          dueDate: daysAgo(20),
        },
      })
    ).id;
    invF = (
      await prisma.invoice.create({
        data: {
          number: mkNumber('F'),
          customerId: fayCustomerId,
          subscriptionId: faySub,
          status: InvoiceStatus.UNPAID,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          dueDate: daysAgo(1), // PAS encore au-delà du grâce
        },
      })
    ).id;

    // Config SMTP minimale : sans elle `sendPlain` lève (« Configuration mail
    // non définie ») et les emails de suspension seraient avortés en silence.
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali Q5',
          },
        })
      ).id;
    }
  });

  afterAll(async () => {
    // Nettoyage MÊME si un échec de test : fixtures de recette sans valeur
    // métier, dans l'ordre des FK (RESTRICT d'abord), le reste de la DB n'est
    // pas touché.
    try {
      if (prisma) {
        if (numbers.length) {
          await prisma.invoice.deleteMany({ where: { number: { in: numbers } } });
        }
        await prisma.deployment.deleteMany({
          where: { repoFullName: { in: ['dan/app-a', 'dan/app-b', 'emma/app-e'] } },
        });
        await prisma.hostingService.deleteMany({ where: { id: { in: [hsA, hsB, hsE] } } });
        if (productId) {
          await prisma.subscription.deleteMany({ where: { productId } });
          await prisma.product.delete({ where: { id: productId } });
        }
        await prisma.server.deleteMany({
          where: { name: { in: [`q5-coolify-${stamp}`, `q5-hestia-${stamp}`] } },
        });
        await prisma.customer.deleteMany({
          where: { email: { in: [danEmail, emmaEmail, fayEmail] } },
        });
        await prisma.user.deleteMany({
          where: { email: { in: [adminEmail, danEmail, emmaEmail, fayEmail] } },
        });
        if (createdMailId) {
          await prisma.mailSetting.delete({ where: { id: createdMailId } });
        }
      }
    } catch {
      // Meilleur effort : jamais d'échec de nettoyage masquant un vrai test.
    }
    if (app) await app.close();
  });

  // ── 1. Sweep : portée stricte + effets réversibles ─────────────────────────
  it('sweep : seul l\u2019abonnement de la facture impay\u00e9e est suspendu (multi-abonnements), apps arr\u00eat\u00e9es sans suppression', async () => {
    const res = await sweep().expect(201);
    expect(res.body.suspended).toBeGreaterThanOrEqual(2);

    // Portée : dan A suspendu, dan B (facture PAID) INTACT, fay intacte.
    const subs = await prisma.subscription.findMany({
      where: { id: { in: [danSubA, danSubB, emmaSub, faySub] } },
      select: { id: true, status: true },
    });
    const byId = Object.fromEntries(subs.map((s) => [s.id, s.status]));
    expect(byId[danSubA]).toBe(SubscriptionStatus.SUSPENDED);
    expect(byId[danSubB]).toBe(SubscriptionStatus.ACTIVE);
    expect(byId[emmaSub]).toBe(SubscriptionStatus.SUSPENDED);
    expect(byId[faySub]).toBe(SubscriptionStatus.ACTIVE);

    // Services hébergement du SEUL abonnement concerné (même transaction).
    const services = await prisma.hostingService.findMany({
      where: { id: { in: [hsA, hsB, hsE] } },
      select: { id: true, status: true },
    });
    const svcById = Object.fromEntries(services.map((s) => [s.id, s.status]));
    expect(svcById[hsA]).toBe(HostingServiceStatus.SUSPENDED);
    expect(svcById[hsB]).toBe(HostingServiceStatus.ACTIVE);
    expect(svcById[hsE]).toBe(HostingServiceStatus.SUSPENDED);

    // Effets provider : arrêt RÉVERSIBLE des seules apps concernées.
    expect(stopCalls).toContainEqual({ provider: 'COOLIFY', uuid: 'uuid-dan-a' });
    expect(stopCalls).toContainEqual({ provider: 'COOLIFY', uuid: 'uuid-emma-e' });
    expect(stopCalls.some((c) => c.uuid === 'uuid-dan-b')).toBe(false);
    expect(startCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0); // AUCUNE suppression

    // Audits : suspension + effets ; jamais sur l'abonnement non concerné.
    for (const subId of [danSubA, emmaSub]) {
      expect(
        await prisma.auditLog.findFirst({
          where: { action: 'subscription.auto_suspend', resourceId: subId },
        }),
      ).not.toBeNull();
      expect(
        await prisma.auditLog.findFirst({
          where: { action: 'suspension.apps_stopped', resourceId: subId },
        }),
      ).not.toBeNull();
    }
    expect(
      await prisma.auditLog.count({
        where: { action: 'subscription.auto_suspend', resourceId: danSubB },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'subscription.auto_suspend', resourceId: faySub },
      }),
    ).toBe(0);

    // Email honnête : l'arrêt réversible est décrit, JAMAIS « accès suspendu ».
    // (Le rappel d'impayé porte aussi le numéro : on cible le mail de
    // suspension adressé à Dan.)
    const mail = findMail('Abonnement suspendu', danEmail);
    expect(mail).toBeDefined();
    expect(mail!.text).toContain('Votre abonnement est suspendu');
    expect(mail!.text).toMatch(/arrêtée\(s\) de façon réversible/);
    expect(mail!.text).not.toMatch(/acc[eè]s est suspendu/);
    expect(mail!.subject).toContain(`Q5-A-${stamp}`);

    // La facture rétablie (PAID) n'est PAS touchée par le sweep.
    const invBFinal = await prisma.invoice.findUniqueOrThrow({
      where: { id: invB },
      select: { status: true },
    });
    expect(invBFinal.status).toBe(InvoiceStatus.PAID);

    // Le statut d\u00e9ploiement local n'est PAS mut\u00e9 (l'arr\u00eat est provider).
    const depA = await prisma.deployment.findFirstOrThrow({
      where: { coolifyUuid: 'uuid-dan-a' },
      select: { status: true },
    });
    expect(depA.status).toBe('ACTIVE');
  });

  // ── 2. Nouveaux d\u00e9ploiements bloqu\u00e9s pendant la suspension ─────────────
  it('nouveau d\u00e9ploiement pendant la suspension \u2192 403 explicite (aucun appel provider)', async () => {
    fakeTransport.stopApplication.mockClear();
    const r = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${emmaToken}`)
      .send({ repoUrl: 'https://github.com/emma/app' })
      .expect(403);
    expect(String(r.body.message)).toMatch(/Aucun pack d.hébergement actif/);
    expect(fakeTransport.stopApplication).not.toHaveBeenCalled();
  });

  // ── 3. R\u00e9activation contr\u00f4l\u00e9e admin ────────────────────────────────────
  it('r\u00e9activation admin (SUSPENDED \u2192 ACTIVE) : relance des apps, effets retourn\u00e9s, Z\u00c9RO \u00e9criture facture', async () => {
    const invoicesBefore = await prisma.invoice.count({
      where: { customerId: emmaCustomerId },
    });
    const invEBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: invE } });

    const r = await patchSubscription(emmaSub, 'ACTIVE').expect(200);
    expect(r.body).toMatchObject({ status: SubscriptionStatus.ACTIVE });
    expect(r.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });

    // Relance de l'app de l'abonnement r\u00e9activ\u00e9 — et de personne d'autre.
    expect(startCalls).toContainEqual({ provider: 'COOLIFY', uuid: 'uuid-emma-e' });
    expect(startCalls.some((c) => c.uuid === 'uuid-dan-a')).toBe(false);
    expect(deleteCalls).toHaveLength(0);

    const svcE = await prisma.hostingService.findUniqueOrThrow({
      where: { id: hsE },
      select: { status: true },
    });
    expect(svcE.status).toBe(HostingServiceStatus.ACTIVE);

    // R\u00e9activation = statut seul : aucune facture ni montant touch\u00e9.
    const invoicesAfter = await prisma.invoice.count({ where: { customerId: emmaCustomerId } });
    expect(invoicesAfter).toBe(invoicesBefore);
    const invEAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invE } });
    expect(invEAfter.status).toBe(invEBefore.status);
    expect(invEAfter.amountTtcCents).toBe(invEBefore.amountTtcCents);
    expect(invEAfter.paidAt?.getTime?.() ?? null).toBe(invEBefore.paidAt?.getTime?.() ?? null);
  });

  // ── 4. Capacit\u00e9 provider manquante : blocage explicite, l'action POURSUIT ────
  it('panneau non Coolify (HESTIA) \u2192 effects.blocked=1, statut suspendu malgr\u00e9 tout, audit capacite_absente', async () => {
    const r = await patchSubscription(danSubB, 'SUSPENDED').expect(200);
    expect(r.body).toMatchObject({ status: SubscriptionStatus.SUSPENDED });
    expect(r.body.effects).toMatchObject({ apps: 1, done: 0, blocked: 1, failed: 0 });

    expect(stopCalls).toContainEqual({ provider: 'HESTIA', uuid: 'uuid-dan-b' });
    expect(deleteCalls).toHaveLength(0);

    const subB = await prisma.subscription.findUniqueOrThrow({
      where: { id: danSubB },
      select: { status: true },
    });
    expect(subB.status).toBe(SubscriptionStatus.SUSPENDED);
    const svcB = await prisma.hostingService.findUniqueOrThrow({
      where: { id: hsB },
      select: { status: true },
    });
    expect(svcB.status).toBe(HostingServiceStatus.SUSPENDED);

    const depB = await prisma.deployment.findFirstOrThrow({
      where: { coolifyUuid: 'uuid-dan-b' },
      select: { id: true },
    });
    const blockAudit = await prisma.auditLog.findFirst({
      where: { action: 'suspension.app_stop_blocked', resourceId: depB.id },
    });
    expect(blockAudit).not.toBeNull();
    expect((blockAudit!.details as { reason?: string }).reason).toBe('capacite_absente');
  });

  // ── 5. RBAC : le client ne r\u00e9active JAMAIS lui-m\u00eame ─────────────────────
  it('RBAC : un client ne peut pas PATCH son propre abonnement (403)', async () => {
    await patchSubscription(danSubB, 'ACTIVE', danToken).expect(403);
    const subB = await prisma.subscription.findUniqueOrThrow({
      where: { id: danSubB },
      select: { status: true },
    });
    expect(subB.status).toBe(SubscriptionStatus.SUSPENDED);
  });

  // ── 6. Course paiement / suspension ────────────────────────────────────────
  it('r\u00e8glement AVANT le sweep \u2192 AUCUNE suspension (impay\u00e9 r\u00e9gl\u00e9 sous verrou)', async () => {
    await prisma.invoice.update({
      where: { id: invF },
      data: { status: InvoiceStatus.PAID, paidAt: new Date(), dueDate: daysAgo(20) },
    });
    await sweep().expect(201);
    const subF = await prisma.subscription.findUniqueOrThrow({
      where: { id: faySub },
      select: { status: true },
    });
    expect(subF.status).toBe(SubscriptionStatus.ACTIVE);
    expect(
      await prisma.auditLog.count({
        where: { action: 'subscription.auto_suspend', resourceId: faySub },
      }),
    ).toBe(0);
  });

  it('course r\u00e9ellement CONCURRENTTE (sweep \u00d7 r\u00e8glement) \u2192 facture PAID + \u00e9tat coh\u00e9rent, aucun crash', async () => {
    invG = (
      await prisma.invoice.create({
        data: {
          number: mkNumber('G'),
          customerId: fayCustomerId,
          subscriptionId: faySub,
          status: InvoiceStatus.UNPAID,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          dueDate: daysAgo(20),
        },
      })
    ).id;

    // Les deux op\u00e9rations s'ex\u00e9cutent EN MÊME TEMPS (vrai chevauchement DB).
    const [sweepRes] = await Promise.all([
      sweep().expect(201),
      prisma.invoice.update({
        where: { id: invG },
        data: { status: InvoiceStatus.PAID, paidAt: new Date() },
      }),
    ]);
    expect(sweepRes.body).toHaveProperty('suspended');

    const invGFinal = await prisma.invoice.findUniqueOrThrow({
      where: { id: invG },
      select: { status: true, paidAt: true },
    });
    expect(invGFinal.status).toBe(InvoiceStatus.PAID);
    expect(invGFinal.paidAt).not.toBeNull();

    const subF = await prisma.subscription.findUniqueOrThrow({
      where: { id: faySub },
      select: { status: true, updatedAt: true },
    });
    if (subF.status === SubscriptionStatus.SUSPENDED) {
      // Toute suspension observ\u00e9e est D\u00c9CID\u00c9E sous verrou sur un impay\u00e9
      // rel\u00u : elle porte son audit (jamais de suspension fant\u00f4me).
      expect(
        await prisma.auditLog.findFirst({
          where: { action: 'subscription.auto_suspend', resourceId: faySub },
        }),
      ).not.toBeNull();
    } else {
      expect(subF.status).toBe(SubscriptionStatus.ACTIVE);
    }
    expect(deleteCalls).toHaveLength(0);
  });
});
