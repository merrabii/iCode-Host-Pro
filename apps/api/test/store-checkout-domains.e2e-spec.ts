import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  DomainStatus,
  OrderStatus,
  PaymentMethodType,
  ProvisionAction,
  Role,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { CloudflareService } from './../src/cloudflare/cloudflare.service';
import {
  CloudflareTransport,
  CloudflareTransportFactory,
  CfDnsRecord,
} from './../src/cloudflare/cloudflare.transport';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';

/**
 * Phase 4 — Checkout store multi-domaines (e2e). Couvre les trois groupes :
 *   A. POST /api/store/subdomain/check — vérification publique du sous-domaine
 *      (whitelist allowedDomainIds, domaines DISABLED, ambiguïté, défaut plateforme,
 *      racine unique éligible) ;
 *   B. POST /api/store/checkout — persistance de requestedSubdomain/requestedDomainId,
 *      rejets fail-fast (racine inexistante / hors whitelist / DISABLED / ambiguïté),
 *      idempotence (replay) et chemin membre (2 commandes distinctes, racines différentes) ;
 *   C. Provisioning multi-domaines — requestedDomainId réellement consommé par le
 *      provisioning, gel de effectiveDomainId AVANT l'allocation DNS (trace au moment
 *      de createRecord), FQDN sous la racine demandée, retry force=1 idempotent,
 *      commande legacy (requestedDomainId null → racine unique), et durcissement
 *      racine (livrée conservée puis DISABLED vs nouvelle allocation rejetée).
 *
 * Coutures (AUCUN réseau réel) : CloudflareTransportFactory (records en mémoire +
 * trace du gel au moment du create), MailTransportFactory (jamais de SMTP),
 * PanelTransportFactory (jamais de Coolify). CloudflareService, CryptoService et
 * PrismaService sont RÉELS. Les singletons CloudflareSetting/BillingSetting sont
 * restaurés à l'identique ; le nettoyage est borné aux fixtures de la suite.
 */
describe('Store checkout multi-domaines (e2e, Phase 4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let cloudflare: CloudflareService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const adminEmail = `cdadmin_${stamp}@example.com`;
  const memberEmail = `cdmember_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let memberToken = '';

  let domA: { id: string; name: string; zoneId: string };
  let domB: { id: string; name: string; zoneId: string };
  let domC: { id: string; name: string; zoneId: string };
  let provId = '';
  let pmId = '';
  let prodABId = ''; // rule [A, B]
  let prodBId = ''; // rule [B]
  let prodACId = ''; // rule [A, C] (C = DISABLED)
  let prodEdgeId = ''; // rule [A]

  // Assainissement borné (jamais deleteMany{} global) :
  const allOrderIds: string[] = [];
  const guestEmails: string[] = [];
  const seededCustomerEmails: string[] = [];

  // ── Singletons à restaurer à l'identique ──────────────────────────────────
  let priorCf: { id: string; apiTokenEnc: string | null; accountEmail: string | null; rootDomainId: string | null } | null =
    null;
  let cfRowId: string | null = null;
  let priorBilling: { id: string; invoiceSequence: number } | null = null;

  // ── Fake Cloudflare : records mémoire + trace du gel (effectiveDomainId au moment du create) ──
  interface DnsTraceEntry {
    zoneId: string;
    name: string;
    content: string;
    proxied?: boolean;
    effectiveDomainIdAtCreate: string | null;
  }
  const dnsRecords: string[] = [];
  const dnsCreateTrace: DnsTraceEntry[] = [];
  let dnsCreateCounter = 0;

  const fakeCfTransport: CloudflareTransport = {
    listZones: jest.fn().mockResolvedValue([]),
    listRecords: jest.fn().mockResolvedValue([]),
    findRecordByName: jest.fn().mockResolvedValue(null),
    createRecord: jest.fn(async (_target, zoneId: string, input) => {
      dnsCreateCounter += 1;
      dnsRecords.push(input.name);
      const entry: DnsTraceEntry = { zoneId, name: input.name, content: input.content, proxied: input.proxied, effectiveDomainIdAtCreate: null };
      const domain = await prisma.domain.findUnique({ where: { zoneId } });
      if (domain) {
        const sub = input.name.split('.')[0];
        const order = await prisma.order.findFirst({
          where: { requestedSubdomain: sub },
          orderBy: { updatedAt: 'desc' },
        });
        entry.effectiveDomainIdAtCreate = order?.effectiveDomainId ?? null;
      }
      dnsCreateTrace.push(entry);
      return `rec-${dnsCreateCounter}`;
    }),
    deleteRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudflareTransport;
  const fakeCfFactory: CloudflareTransportFactory = {
    create: () => fakeCfTransport,
  } as unknown as CloudflareTransportFactory;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport =>
      ({
        verify: jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' }),
        createGitApp: jest.fn().mockResolvedValue({ uuid: 'fake-app' }),
        createProject: jest.fn().mockResolvedValue({ uuid: 'fake-proj', name: 'x' }),
        listProjects: jest.fn().mockResolvedValue([]),
        listServers: jest.fn().mockResolvedValue([]),
        deployApp: jest.fn().mockResolvedValue(undefined),
        applyAppLimits: jest.fn().mockResolvedValue(undefined),
        setAppEnvironment: jest.fn().mockResolvedValue(undefined),
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: jest.fn().mockResolvedValue(undefined),
        deleteApplication: jest.fn().mockResolvedValue(undefined),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'in_progress' }),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function setCfRoot(domainId: string | null): Promise<void> {
    if (!cfRowId) throw new Error('cfRowId not initialised');
    await prisma.cloudflareSetting.update({ where: { id: cfRowId }, data: { rootDomainId: domainId } });
  }

  async function waitFor<T>(
    label: string,
    fn: () => Promise<T>,
    pred: (t: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 30_000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (pred(value)) return value;
        last = value;
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timeout (30s) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`);
  }

  async function waitOrderActive(orderId: string): Promise<void> {
    await waitFor(`order ${orderId} ACTIVE`, () => prisma.order.findUnique({ where: { id: orderId } }), (o) => o?.status === OrderStatus.ACTIVE);
  }

  /** Stalle tous les provisioning fire-and-forget lancés par les checkouts du groupe B. */
  async function settleCheckoutOrders(ids: string[]): Promise<void> {
    for (const id of ids) await waitOrderActive(id);
  }

  async function seedOrder(opts: {
    customerEmail: string;
    productId: string;
    productName: string;
    subdomain: string;
    requestedDomainId?: string | null;
  }): Promise<string> {
    const customer = await prisma.customer.create({
      data: { email: opts.customerEmail, name: 'Client E2E phase4' },
    });
    seededCustomerEmails.push(opts.customerEmail);
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'Client E2E phase4',
        customerEmail: opts.customerEmail,
        productId: opts.productId,
        productName: opts.productName,
        status: OrderStatus.PAID,
        amountHtCents: 1500,
        taxAmountCents: 0,
        amountTtcCents: 1500,
        requestedSubdomain: opts.subdomain,
        requestedDomainId: opts.requestedDomainId ?? null,
      },
    });
    allOrderIds.push(order.id);
    return order.id;
  }

  function checkoutBody(over: Record<string, unknown>) {
    return {
      productSlug: '',
      paymentMethodId: pmId,
      name: 'Client E2E',
      email: '',
      ...over,
    };
  }

  function checkSub(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post(`/${GlobalPrefix}/store/subdomain/check`).send(body);
  }

  function placeOrder(body: Record<string, unknown>, token?: string): request.Test {
    const req = request(app.getHttpServer()).post(`/${GlobalPrefix}/store/checkout`).send(body);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CloudflareTransportFactory)
      .useValue(fakeCfFactory)
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
    crypto = moduleRef.get(CryptoService);
    cloudflare = moduleRef.get(CloudflareService);
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();

    // Utilisateurs (seeds directs Prisma, comme les autres suites e2e).
    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN },
    });
    await prisma.user.create({
      data: { email: memberEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    memberToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: memberEmail, password })
        .expect(201)
    ).body.accessToken as string;
    expect(adminToken).toBeTruthy();
    expect(memberToken).toBeTruthy();

    // Domaine racine (import simule : la zone n'est jamais listée réellement).
    domA = await prisma.domain.create({
      data: { name: `a-${stamp}.test`, zoneId: `zone-a-${stamp}`, cnameTarget: 'panel.test', status: DomainStatus.ACTIVE },
    });
    domB = await prisma.domain.create({
      data: { name: `b-${stamp}.test`, zoneId: `zone-b-${stamp}`, cnameTarget: 'panel.test', status: DomainStatus.ACTIVE },
    });
    domC = await prisma.domain.create({
      data: { name: `c-${stamp}.test`, zoneId: `zone-c-${stamp}`, cnameTarget: 'panel.test', status: DomainStatus.DISABLED },
    });

    // Méthode de provisioning (DNS only) + moyen de paiement actif.
    const prov = await prisma.provisionMethod.create({
      data: { name: `store-dns-${stamp}`, code: `store-dns-${stamp}`, actions: [ProvisionAction.CONFIGURE_DNS] },
    });
    provId = prov.id;
    const pm = await prisma.paymentMethod.create({
      data: { name: `CB-${stamp}`, type: PaymentMethodType.CARD, isActive: true },
    });
    pmId = pm.id;

    // Produits (fiches store répondant aux mêmes contraintes que le catalogue admin).
    const mk = async (slug: string, allowed: string[]) => {
      const p = await prisma.product.create({
        data: {
          name: `${slug}-${stamp}`,
          slug,
          status: 'ACTIVE',
          hidden: false,
          priceHtCents: 1500,
          provisionModuleId: provId,
          freeSubdomainRule: { create: { allowedDomainIds: allowed } },
        },
      });
      return p.id;
    };
    prodABId = await mk(`prod-ab-${stamp}`, [domA.id, domB.id]);
    prodBId = await mk(`prod-b-${stamp}`, [domB.id]);
    prodACId = await mk(`prod-ac-${stamp}`, [domA.id, domC.id]);
    prodEdgeId = await mk(`prod-edge-${stamp}`, [domA.id]);

    // Singleton CloudflareSetting : on conserve la row préexistante (s'il y en a
    // une) mais on lui affuble un token factice CHIFFRÉ (CryptoService RÉEL) pour
    // que le service reste utilisable sans aucun appel réseau — restauré après.
    const existingCf = await prisma.cloudflareSetting.findFirst();
    priorCf = existingCf
      ? {
          id: existingCf.id,
          apiTokenEnc: existingCf.apiTokenEnc,
          accountEmail: existingCf.accountEmail,
          rootDomainId: existingCf.rootDomainId,
        }
      : null;
    if (existingCf) {
      cfRowId = existingCf.id;
      await prisma.cloudflareSetting.update({
        where: { id: existingCf.id },
        data: { apiTokenEnc: crypto.encrypt('fake-cf-token'), accountEmail: 'e2e@test.local', rootDomainId: null },
      });
    } else {
      const created = await prisma.cloudflareSetting.create({
        data: { apiTokenEnc: crypto.encrypt('fake-cf-token'), accountEmail: 'e2e@test.local', rootDomainId: null },
      });
      cfRowId = created.id;
    }

    // Singleton BillingSetting : snapshot avant mutation (invoiceSequence++, voir
    // claimInvoiceSequence) puis restauration exacte en afterAll.
    const billing = await prisma.billingSetting.findFirst();
    priorBilling = billing ? { id: billing.id, invoiceSequence: billing.invoiceSequence } : null;
  });

  afterAll(async () => {
    // Ordre de suppression respectant les FK bornées (aucun deleteMany global).
    await prisma.invoice.deleteMany({ where: { orderId: { in: allOrderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: allOrderIds } } }).catch(() => {});
    const domainIds = [domA.id, domB.id, domC.id];
    await prisma.clientSubdomain.deleteMany({ where: { domainId: { in: domainIds } } }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { email: { in: [...guestEmails, ...seededCustomerEmails, memberEmail] } },
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { email: { in: [...guestEmails, adminEmail, memberEmail] } },
    }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [prodABId, prodBId, prodACId, prodEdgeId] } } }).catch(() => {});
    await prisma.provisionMethod.deleteMany({ where: { id: provId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: pmId } }).catch(() => {});
    await prisma.domain.deleteMany({ where: { id: { in: domainIds } } }).catch(() => {});

    // Restauration EXACTE des singletons.
    if (cfRowId) {
      if (priorCf) {
        await prisma.cloudflareSetting
          .update({
            where: { id: priorCf.id },
            data: { apiTokenEnc: priorCf.apiTokenEnc, accountEmail: priorCf.accountEmail, rootDomainId: priorCf.rootDomainId },
          })
          .catch(() => {});
      } else {
        await prisma.cloudflareSetting.deleteMany({ where: { id: cfRowId } }).catch(() => {});
      }
    }
    if (priorBilling) {
      await prisma.billingSetting
        .update({ where: { id: priorBilling.id }, data: { invoiceSequence: priorBilling.invoiceSequence } })
        .catch(() => {});
    } else {
      const createdBilling = await prisma.billingSetting.findFirst({ where: { invoiceSequence: { gt: 1 } } }).catch(() => null);
      if (createdBilling) await prisma.billingSetting.delete({ where: { id: createdBilling.id } }).catch(() => {});
    }

    await app.close();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Groupe A — POST /store/subdomain/check (vérification publique)
  // ═════════════════════════════════════════════════════════════════════════
  describe('A — /store/subdomain/check', () => {
    it('A1 — choix explicite dans la whitelist → disponible + FQDN sous la racine choisie', async () => {
      await setCfRoot(null);
      const sub = `sub-a1-${stamp}`;
      const res = await checkSub({ productSlug: `prod-ab-${stamp}`, subdomain: sub, requestedDomainId: domA.id }).expect(201);
      expect(res.body.available).toBe(true);
      expect(res.body.fqdn).toBe(`${sub}.${domA.name}`);
      expect(res.body.reason).toBeUndefined();
    });

    it('A2 — racine demandée inexistante → refus (reason=invalid)', async () => {
      const res = await checkSub({
        productSlug: `prod-ab-${stamp}`,
        subdomain: `sub-a2-${stamp}`,
        requestedDomainId: 'cm0000000000000000000000000',
      }).expect(201);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toBe('invalid');
    });

    it('A3 — racine existante mais hors whitelist du produit → refus (reason=invalid)', async () => {
      const res = await checkSub({ productSlug: `prod-b-${stamp}`, subdomain: `sub-a3-${stamp}`, requestedDomainId: domA.id }).expect(201);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toBe('invalid');
    });

    it('A4 — racine DISABLED (même whitelistée) → refus (reason=invalid)', async () => {
      const res = await checkSub({ productSlug: `prod-ac-${stamp}`, subdomain: `sub-a4-${stamp}`, requestedDomainId: domC.id }).expect(201);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toBe('invalid');
    });

    it('A5 — plusieurs éligibles sans choix ni défaut plateforme → ambiguïté (reason=invalid), AUCUN pick arbitraire', async () => {
      await setCfRoot(null);
      const res = await checkSub({ productSlug: `prod-ab-${stamp}`, subdomain: `sub-a5-${stamp}` }).expect(201);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toBe('invalid');
    });

    it('A6 — défaut PLATEFORME (rootDomainId) éligible → auto-sélection sans ambiguïté', async () => {
      await setCfRoot(domA.id);
      const sub = `sub-a6-${stamp}`;
      const res = await checkSub({ productSlug: `prod-ab-${stamp}`, subdomain: sub }).expect(201);
      expect(res.body.available).toBe(true);
      expect(res.body.fqdn).toBe(`${sub}.${domA.name}`);
    });

    it('A7 — un seul éligible (whitelist réduite) → auto-sélection de l’unique', async () => {
      const sub = `sub-a7-${stamp}`;
      const res = await checkSub({ productSlug: `prod-b-${stamp}`, subdomain: sub }).expect(201);
      expect(res.body.available).toBe(true);
      expect(res.body.fqdn).toBe(`${sub}.${domB.name}`);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Groupe B — POST /store/checkout (persistance + rejets faill-fast)
  // ═════════════════════════════════════════════════════════════════════════
  describe('B — /store/checkout', () => {
    const bCheckoutOrderIds: string[] = [];

    it('B1 — checkout invité valide → order créée avec requestedSubdomain + requestedDomainId', async () => {
      limiter.reset();
      const email = `guest-b1-${stamp}@example.com`;
      guestEmails.push(email);
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-ab-${stamp}`,
          email,
          subdomain: `sub-b1-${stamp}`,
          requestedDomainId: domA.id,
        }),
      ).expect(201);
      expect(res.body.orderId).toBeTruthy();
      expect(res.body.nextStep).toBe('provisioning-pending');
      const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(order).toBeTruthy();
      expect(order!.requestedSubdomain).toBe(`sub-b1-${stamp}`);
      expect(order!.requestedDomainId).toBe(domA.id);
      // La commande est créée PAID, mais le provisioning fire-and-forget peut déjà
      // l'avoir fait évoluer (PROVISIONING/ACTIVE) — la persistance de la racine
      // demandée et le gel sont attestés de façon déterministe en groupe C.
      expect([OrderStatus.PAID, OrderStatus.PROVISIONING, OrderStatus.ACTIVE]).toContain(order!.status);
      bCheckoutOrderIds.push(res.body.orderId as string);
      allOrderIds.push(res.body.orderId as string);
    });

    it('B2 — racine demandée inexistante → 400 avant toute création de commande', async () => {
      limiter.reset();
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-ab-${stamp}`,
          email: `guest-b2-${stamp}@example.com`,
          subdomain: `sub-b2-${stamp}`,
          requestedDomainId: 'cm0000000000000000000000000',
        }),
      ).expect(400);
      expect(res.body.message).toContain('n’est pas disponible');
    });

    it('B3 — racine hors whitelist du produit → 400 (rule [B], choix A)', async () => {
      limiter.reset();
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-b-${stamp}`,
          email: `guest-b3-${stamp}@example.com`,
          subdomain: `sub-b3-${stamp}`,
          requestedDomainId: domA.id,
        }),
      ).expect(400);
      expect(res.body.message).toContain('n’est pas disponible');
    });

    it('B4 — racine DISABLED whitelistée → 400 (rule [A,C], choix C)', async () => {
      limiter.reset();
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-ac-${stamp}`,
          email: `guest-b4-${stamp}@example.com`,
          subdomain: `sub-b4-${stamp}`,
          requestedDomainId: domC.id,
        }),
      ).expect(400);
      expect(res.body.message).toContain('n’est pas disponible');
    });

    it('B5 — plusieurs éligibles SANS choix → 400 ambiguïté, aucun pick arbitraire', async () => {
      limiter.reset();
      await setCfRoot(null);
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-ab-${stamp}`,
          email: `guest-b5-${stamp}@example.com`,
          subdomain: `sub-b5-${stamp}`,
        }),
      ).expect(400);
      expect(res.body.message).toContain('veuillez choisir');
    });

    it('B6 — replay identique (double-clic) → MÊME orderId, une seule commande', async () => {
      limiter.reset();
      const email = `guest-b6-${stamp}@example.com`;
      guestEmails.push(email);
      const body = checkoutBody({
        productSlug: `prod-ab-${stamp}`,
        email,
        subdomain: `sub-b6-${stamp}`,
        requestedDomainId: domA.id,
      });
      const first = await placeOrder(body).expect(201);
      const second = await placeOrder(body).expect(201);
      expect(second.body.orderId).toBe(first.body.orderId);
      const count = await prisma.order.count({ where: { id: first.body.orderId } });
      expect(count).toBe(1);
      bCheckoutOrderIds.push(first.body.orderId as string);
      allOrderIds.push(first.body.orderId as string);
    });

    it('B7 — membre connecté : 2 commandes distinctes, racines A puis B, même sous-domaine', async () => {
      limiter.reset();
      const bodyA = checkoutBody({
        productSlug: `prod-ab-${stamp}`,
        email: `${memberEmail}`,
        name: 'Membre E2E',
        subdomain: `sub-b7-${stamp}`,
        requestedDomainId: domA.id,
      });
      const bodyB = checkoutBody({
        productSlug: `prod-ab-${stamp}`,
        email: `${memberEmail}`,
        name: 'Membre E2E',
        subdomain: `sub-b7-${stamp}`,
        requestedDomainId: domB.id,
      });
      const oa = await placeOrder(bodyA, memberToken).expect(201);
      const ob = await placeOrder(bodyB, memberToken).expect(201);
      expect(ob.body.orderId).not.toBe(oa.body.orderId);
      const orderA = await prisma.order.findUnique({ where: { id: oa.body.orderId } });
      const orderB = await prisma.order.findUnique({ where: { id: ob.body.orderId } });
      expect(orderA!.requestedSubdomain).toBe(`sub-b7-${stamp}`);
      expect(orderA!.requestedDomainId).toBe(domA.id);
      expect(orderB!.requestedSubdomain).toBe(`sub-b7-${stamp}`);
      expect(orderB!.requestedDomainId).toBe(domB.id);
      bCheckoutOrderIds.push(oa.body.orderId as string, ob.body.orderId as string);
      allOrderIds.push(oa.body.orderId as string, ob.body.orderId as string);
    });

    it('B-context — tous les provisioning fire-and-forget du groupe sont terminés avant le C', async () => {
      await settleCheckoutOrders(bCheckoutOrderIds);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Groupe C — Provisioning multi-domaines (gel / retry / durcissement)
  // ═════════════════════════════════════════════════════════════════════════
  describe('C — Provisioning multi-domaines', () => {
    let c1OrderId = '';
    const c1Sub = `sub-c1-${stamp}`;
    const c1Fqdn = `${c1Sub}.a-${stamp}.test`;

    it('C1 — requestedDomainId réellement consommé : provisioning sous la racine A et ACTIVE', async () => {
      limiter.reset();
      const email = `guest-c1-${stamp}@example.com`;
      guestEmails.push(email);
      const res = await placeOrder(
        checkoutBody({
          productSlug: `prod-ab-${stamp}`,
          email,
          subdomain: c1Sub,
          requestedDomainId: domA.id,
        }),
      ).expect(201);
      c1OrderId = res.body.orderId as string;
      allOrderIds.push(c1OrderId);

      await waitOrderActive(c1OrderId);

      const order = await prisma.order.findUnique({ where: { id: c1OrderId } });
      expect(order!.status).toBe(OrderStatus.ACTIVE);
      expect(order!.effectiveDomainId).toBe(domA.id);
      expect(order!.domainValue).toBe(c1Fqdn);
      expect(order!.domainStatus).toBe('READY');

      const alloc = await prisma.clientSubdomain.findFirst({ where: { fqdn: c1Fqdn } });
      expect(alloc).toBeTruthy();
      expect(alloc!.domainId).toBe(domA.id);
      expect(alloc!.subdomain).toBe(c1Sub);

      // L'enregistrement DNS est bien sous la zone de A.
      const trace = dnsCreateTrace.filter((e) => e.name === c1Fqdn);
      expect(trace).toHaveLength(1);
      expect(trace[0]!.zoneId).toBe(domA.zoneId);
      expect(trace[0]!.content).toBe('panel.test');
    });

    it('C2 — le gel de effectiveDomainId précède l’allocation DNS (vérifié au moment du create)', async () => {
      const trace = dnsCreateTrace.find((e) => e.name === c1Fqdn);
      expect(trace).toBeTruthy();
      expect(trace!.effectiveDomainIdAtCreate).toBe(domA.id);
    });

    it('C3 — le FQDN livré est bien le sous-domaine demandé SOUS la racine choisie', async () => {
      const order = await prisma.order.findUnique({ where: { id: c1OrderId } });
      const alloc = await prisma.clientSubdomain.findFirst({ where: { fqdn: c1Fqdn } });
      expect(order!.domainValue).toBe(c1Fqdn);
      expect(alloc!.fqdn).toBe(c1Fqdn);
      expect(order!.requestedDomainId).toBe(domA.id);
      expect(order!.effectiveDomainId).toBe(domA.id);
    });

    it('C4 — retry force=1 (x2) : même racine gelée, même FQDN, aucune 2ᵉ allocation ni 2ᵉ record DNS', async () => {
      const beforeCount = dnsCreateCounter;
      const beforeAllocs = await prisma.clientSubdomain.count({ where: { fqdn: c1Fqdn } });
      for (let i = 0; i < 2; i++) {
        const res = await request(app.getHttpServer())
          .post(`/${GlobalPrefix}/store/admin/orders/${c1OrderId}/provision?force=1`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(201);
        expect(res.body.orderId).toBe(c1OrderId);
        expect(res.body.status).toBe(OrderStatus.ACTIVE);
        expect(res.body.fqdn).toBe(c1Fqdn);
      }
      const order = await prisma.order.findUnique({ where: { id: c1OrderId } });
      expect(order!.effectiveDomainId).toBe(domA.id);
      expect(order!.domainValue).toBe(c1Fqdn);
      expect(dnsCreateCounter).toBe(beforeCount);
      expect(await prisma.clientSubdomain.count({ where: { fqdn: c1Fqdn } })).toBe(beforeAllocs);
      expect(dnsCreateTrace.filter((e) => e.name === c1Fqdn)).toHaveLength(1);
    });

    it('C5 — commande legacy (requestedDomainId null) → résolution par l’unicité admissible (racine B)', async () => {
      await setCfRoot(null);
      const sub = `sub-c5-${stamp}`;
      const fqdn = `${sub}.b-${stamp}.test`;
      const checkpoints = { effectiveDomainIdAtCreate: null as string | null };
      const origCreate = fakeCfTransport.createRecord as jest.Mock;
      const beforeCount = dnsCreateCounter;
      const orderId = await seedOrder({
        customerEmail: `legacy-c5-${stamp}@example.com`,
        productId: prodBId,
        productName: `prod-b-${stamp}`,
        subdomain: sub,
        requestedDomainId: null,
      });
      (fakeCfTransport.createRecord as jest.Mock).mockImplementationOnce(async (...args: [unknown, string, { name: string; content: string }]) => {
        const out = await origCreate(...args);
        const entry = dnsCreateTrace[dnsCreateTrace.length - 1];
        checkpoints.effectiveDomainIdAtCreate = entry?.effectiveDomainIdAtCreate ?? null;
        expect(args[1]).toBe(domB.zoneId);
        expect(args[2].name).toBe(fqdn);
        return out;
      });

      const res = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/provision?force=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(res.body.status).toBe(OrderStatus.ACTIVE);
      expect(res.body.fqdn).toBe(fqdn);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.effectiveDomainId).toBe(domB.id);
      expect(order!.domainValue).toBe(fqdn);
      expect(dnsCreateCounter).toBe(beforeCount + 1);
      expect(checkpoints.effectiveDomainIdAtCreate).toBe(domB.id);
      const alloc = await prisma.clientSubdomain.findFirst({ where: { fqdn } });
      expect(alloc).toBeTruthy();
      expect(alloc!.domainId).toBe(domB.id);
    });

    it('C6 — durcissement : racine livrée conservée puis DISABLED vs nouvelle allocation rejetée', async () => {
      const subA = `sub-c6a-${stamp}`;
      const fqdnA = `${subA}.a-${stamp}.test`;
      const orderA = await seedOrder({
        customerEmail: `legacy-c6a-${stamp}@example.com`,
        productId: prodEdgeId,
        productName: `prod-edge-${stamp}`,
        subdomain: subA,
        requestedDomainId: domA.id,
      });
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${orderA}/provision?force=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await waitOrderActive(orderA);
      const pre = await prisma.order.findUnique({ where: { id: orderA } });
      expect(pre!.effectiveDomainId).toBe(domA.id);
      expect(pre!.domainValue).toBe(fqdnA);
      const beforeCount = dnsCreateCounter;

      // La racine A est désactivée APRÈS livraison.
      await prisma.domain.update({ where: { id: domA.id }, data: { status: DomainStatus.DISABLED } });

      // (a) Résolution directe : livrée (fqdn READY) → racine GARDÉE malgré DISABLED.
      const kept = await cloudflare.resolveEffectiveRoot({
        allowedDomainIds: [domA.id],
        requestedDomainId: domA.id,
        effectiveDomainId: domA.id,
        hasDeliveredFqdn: true,
      });
      expect(kept.root.id).toBe(domA.id);
      expect(kept.source).toBe('effective');

      // (a2) Sans fqdn livré → rejet explicite (#13), JAMAIS de re-pick.
      await expect(
        cloudflare.resolveEffectiveRoot({
          allowedDomainIds: [domA.id],
          requestedDomainId: domA.id,
          effectiveDomainId: domA.id,
          hasDeliveredFqdn: false,
        }),
      ).rejects.toThrow(/désactivé/);

      // (a3) Retry admin sur la commande livrée : intacte, aucun record DNS en plus.
      const retryA = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${orderA}/provision?force=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(retryA.body.status).toBe(OrderStatus.ACTIVE);
      expect(retryA.body.fqdn).toBe(fqdnA);
      const afterRetryA = await prisma.order.findUnique({ where: { id: orderA } });
      expect(afterRetryA!.effectiveDomainId).toBe(domA.id);
      expect(afterRetryA!.domainValue).toBe(fqdnA);
      expect(dnsCreateCounter).toBe(beforeCount);

      // (b) NOUVELLE allocation sur racine DISABLED → configure_dns FAILED, la
      //     commande reste PROVISIONING, effectiveDomainId JAMAIS figé (null).
      const subB = `sub-c6b-${stamp}`;
      const orderB = await seedOrder({
        customerEmail: `legacy-c6b-${stamp}@example.com`,
        productId: prodEdgeId,
        productName: `prod-edge-${stamp}`,
        subdomain: subB,
        requestedDomainId: domA.id,
      });
      const resB = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${orderB}/provision?force=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(resB.body.status).toBe(OrderStatus.PROVISIONING);
      expect(resB.body.fqdn).toBeNull();
      const log = await prisma.provisioningLog.findFirst({
        where: { orderId: orderB, step: 'configure_dns' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.status).toBe('FAILED');
      expect(log!.message).toContain('n’est pas disponible');
      const orderBRow = await prisma.order.findUnique({ where: { id: orderB } });
      expect(orderBRow!.effectiveDomainId).toBeNull();
      expect(orderBRow!.domainValue).toBeNull();
      expect(dnsCreateCounter).toBe(beforeCount);

      // Restauration : la racine A redevient ACTIVE (déterministe pour la suite/le cleanup).
      await prisma.domain.update({ where: { id: domA.id }, data: { status: DomainStatus.ACTIVE } });
    });
  });
});