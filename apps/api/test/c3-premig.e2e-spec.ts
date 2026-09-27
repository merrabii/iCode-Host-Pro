import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OrderStatus, PaymentMethodType, ProvisionAction } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { ProvisioningService } from './../src/store/provisioning.service';
import { C3CapabilityService } from './../src/hosting/c3-capability.service';
import { installFingerprintEnv } from './hosting-reservation.fixture';

/**
 * 17B.4F-C3 — e2e sur base PRÉ-MIGRATIONS C1/C3 (`icode_host_pro_c3premig` :
 * 43/47 migrations, tables `HostingService` + `OrderProvisioningTracking`
 * ABSENTES — identité vérifiée par `to_regclass` + nom de base). Scénarios de
 * revue :
 *
 *  1. OFF + base sans migrations C1/C3 ⇒ la sonde de tracking ne CRASHE pas
 *     (table absente ⇒ « non trackée ») et le parcours LEGACY s'exécute
 *     intégralement — le garde n'est jamais un point de rupture de la
 *     migration ;
 *  2. ON + base sans migrations C1/C3 ⇒ 503 fail-closed AVANT toute
 *     écriture métier (aucun provisioning lancé à moitié sur schéma incomplet) ;
 *  3. SCÉNARIO « cache négatif » COMPLET : l'instance A (process courant)
 *     observe l'ABSENCE de la table (cache négatif amorcé) ⇒ un AUTRE acteur B
 *     applique la migration `20260927000000` puis écrit la commande C3
 *     (insertion directe des écrits qu'aurait faits un checkout ON) ⇒ A est
 *     rappelé AVANT expiration du « TTL » négatif (âge du dernier négatif
 *     toujours frais) ⇒ la ligne est DÉTECTÉE par sonde LIVE (jamais servie
 *     depuis le cache négatif) ⇒ refus 409 OFF, 0 repli legacy, 0 appel
 *     provider, commande intacte. La table est restaurée en fin de test
 *     (`DROP TABLE`) pour garder la suite répétable.
 *
 * Coutures : Panel/Mail factories factices (aucun réseau réel).
 */
describe('Garde C3 — base sans migrations C1/C3 (pré-migrations)', () => {
  delete process.env.HOSTING_C3_ENABLED; // OFF dès le boot
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let provisioning: ProvisioningService;
  let c3: C3CapabilityService;
  let createGitAppCalls = 0;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;
  let provId = '';
  let pmId = '';
  let prodLegacyId = '';
  let prodOnId = '';
  const orderIds: string[] = [];
  const customerEmails: string[] = [];

  const fakePanelFactory = {
    create: () =>
      ({
        createGitApp: jest.fn(async () => {
          createGitAppCalls += 1;
          return { uuid: `app-premig-${createGitAppCalls}` };
        }),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
        verify: jest.fn().mockResolvedValue({ ok: true }),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  async function seedOrder(tag: string, productId: string): Promise<string> {
    const email = `premig-${tag}-${stamp}@example.com`;
    customerEmails.push(email);
    const customer = await prisma.customer.create({ data: { email, name: `Premig ${tag}` } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: `Premig ${tag}`,
        customerEmail: email,
        productId,
        productName: `premig-prod-${stamp}`,
        status: OrderStatus.PAID,
        amountHtCents: 4900,
        taxAmountCents: 0,
        amountTtcCents: 4900,
        paymentMethodId: pmId,
        paymentMethodName: `CB-${stamp}`,
        idempotencyKey: `premig-${tag}-${stamp}`,
      },
    });
    orderIds.push(order.id);
    return order.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue({ create: () => ({ sendMail: jest.fn().mockResolvedValue(undefined) }) })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    provisioning = moduleRef.get(ProvisioningService);
    c3 = moduleRef.get(C3CapabilityService);

    // Garde d'identité : cette suite n'exécute QUE sur la base pré-migratoire
    // dédiée (le DROP de restauration de la partie 3 ne doit jamais toucher une
    // base complète ou la live).
    const dbs = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (dbs[0]?.db !== 'icode_host_pro_c3premig') {
      throw new Error(
        `Base "${dbs[0]?.db}" inattendue — c3-premig est réservée à icode_host_pro_c3premig.`,
      );
    }
    // Auto-guérison : restaure l'état pré-migratoire si un run précédent s'est
    // interrompu avant la restauration de la partie 3.
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "OrderProvisioningTracking"');

    const prov = await prisma.provisionMethod.create({
      data: {
        name: `premig-prov-${stamp}`,
        code: `premig-prov-${stamp}`,
        actions: [] as unknown as ProvisionAction[], // legacy minimal : AUCUNE action
      },
    });
    provId = prov.id;
    const pm = await prisma.paymentMethod.create({
      data: { name: `CB-${stamp}`, type: PaymentMethodType.CARD, isActive: true },
    });
    pmId = pm.id;
    const base = {
      status: 'ACTIVE' as const,
      hidden: false,
      priceHtCents: 4900,
      provisionModuleId: provId,
      moduleParams: { repoUrl: 'https://github.com/acme/site.git', branch: 'main' },
    };
    prodLegacyId = (await prisma.product.create({ data: { ...base, name: `premig-a-${stamp}`, slug: `premig-a-${stamp}` } })).id;
    prodOnId = (await prisma.product.create({ data: { ...base, name: `premig-b-${stamp}`, slug: `premig-b-${stamp}` } })).id;
  });

  afterAll(async () => {
    await prisma.provisioningLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: customerEmails } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [prodLegacyId, prodOnId] } } }).catch(() => {});
    await prisma.provisionMethod.deleteMany({ where: { id: provId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: pmId } }).catch(() => {});
    delete process.env.HOSTING_C3_ENABLED;
    await app.close();
  });

  it('OFF + table tracking absente ⇒ sonde tolérante, parcours LEGACY complet (Order ACTIVE)', async () => {
    const orderId = await seedOrder('legacy', prodLegacyId);
    const res = await provisioning.provisionOrder(orderId);
    expect(res.status).toBe(OrderStatus.ACTIVE);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.ACTIVE);
    // Aucune écriture C3 impossible ni tentée (tables absentes, jamais touchées).
    const tables = await prisma.$queryRaw<Array<{ n: string }>>`
      SELECT to_regclass('public."OrderProvisioningTracking"')::text AS n`;
    expect(tables[0]?.n).toBeNull();
  });

  it('ON + migrations absentes ⇒ 503 fail-closed AVANT toute écriture métier', async () => {
    const orderId = await seedOrder('on-503', prodOnId);
    process.env.HOSTING_C3_ENABLED = 'true';
    try {
      await expect(provisioning.provisionOrder(orderId)).rejects.toThrow(
        /schéma indisponible/,
      );
    } finally {
      delete process.env.HOSTING_C3_ENABLED;
    }
    // État intact : jamais de demi-provisioning sur schéma incomplet.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PAID);
    const depCount = await prisma.deployment.count({ where: { orderId } });
    expect(depCount).toBe(0);
    const logCount = await prisma.provisioningLog.count({ where: { orderId } });
    expect(logCount).toBe(0);
    // Vérification d'identité de la base (rappel : pré-migrations C1/C3).
    const reg = await prisma.$queryRaw<Array<{ hs: string | null }>>`
      SELECT to_regclass('public."HostingService"')::text AS hs`;
    expect(reg[0]?.hs).toBeNull();
  });

  it('cache négatif sur A → migration + commande C3 via B → A avant TTL ⇒ détection live, 409 OFF, 0 repli/provider', async () => {
    const orderId = await seedOrder('neg', prodLegacyId);

    // ── A : amorçage du cache négatif (la table est encore absente) ──────
    expect(await c3.resolveTracking(orderId)).toBeNull();
    expect(c3.negativeCacheAgeMs()).not.toBeNull();

    try {
      // ── B (autre acteur) : applique la migration C3 puis écrit la C3 ────
      const migrationPath = join(
        __dirname,
        '..',
        'prisma',
        'migrations',
        '20260927000000_add_order_provisioning_tracking',
        'migration.sql',
      );
      const sql = readFileSync(migrationPath, 'utf8');
      const statements = sql
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(statements).toHaveLength(2); // CREATE TABLE + FK uniquement
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
      const intent = {
        business: { productId: prodLegacyId, amountTtcCents: 4900, currency: 'EUR' },
        environment: { repoUrl: 'https://github.com/acme/site.git', branch: 'main' },
      };
      await prisma.orderProvisioningTracking.create({ data: { orderId, intent } });

      // ── A rappelé AVANT expiration du « TTL » négatif (âge toujours frais)
      const negAge = c3.negativeCacheAgeMs();
      expect(negAge).not.toBeNull();
      expect(negAge!).toBeLessThan(60_000); // le négatif est encore « valide »

      // La ligne créée par B est DÉTECTÉE : sonde LIVE, jamais le cache négatif.
      expect(await c3.resolveTracking(orderId)).toEqual({ intent });

      // ── A, sous OFF : refus 409 explicite, AUCUN repli legacy, 0 provider ─
      const providerCallsBefore = createGitAppCalls;
      await expect(provisioning.provisionOrder(orderId)).rejects.toThrow(
        /provisioning suspendu tant que C3 est désactivé/,
      );

      expect(createGitAppCalls).toBe(providerCallsBefore); // 0 appel provider
      const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(after.status).toBe(OrderStatus.PAID); // legacy aurait basculé ACTIVE
      expect(await prisma.deployment.count({ where: { orderId } })).toBe(0);
      expect(await prisma.provisioningLog.count({ where: { orderId } })).toBe(0);
      const tracking = await prisma.orderProvisioningTracking.findUnique({
        where: { orderId },
      });
      expect(tracking?.claimToken).toBeNull(); // AUCUNE écriture de claim
      expect(tracking?.leaseUntil).toBeNull();
    } finally {
      // Restauration : la table redevient absente (suite répétable, état
      // pré-migratoire conservé pour les parties 1 et 2).
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "OrderProvisioningTracking"');
    }

    const restored = await prisma.$queryRaw<Array<{ n: string | null }>>`
      SELECT to_regclass('public."OrderProvisioningTracking"')::text AS n`;
    expect(restored[0]?.n).toBeNull();
  });
});
