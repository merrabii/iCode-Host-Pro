import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { OrderStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { SecuritySettingsService } from './../src/auth/security/security-settings.service';

/**
 * Correctif sécurité — GET /api/store/orders/:id/status (e2e minimal).
 * Vérifie le contrat public : {found:false} sur id inexistant, et sur une
 * commande réelle UNIQUEMENT {found,status} — jamais customerEmail ni autre
 * PII, même quand la commande en porte. Fixtures minimales (customer +
 * product + order) créées via Prisma, aucun checkout réel.
 */
describe('Store order status (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let settings: SecuritySettingsService;
  const stamp = Date.now();
  let orderId = '';
  // Singleton SecuritySetting : s'il existait avant la suite il est restauré à
  // l'identique, sinon la row créée par le test est supprimée (rien de résiduel).
  let priorSettings: {
    turnstileEnabled: boolean;
    turnstileSiteKey: string | null;
    turnstileSecretEnc: string | null;
    oauthGoogleEnabled: boolean;
    oauthGithubEnabled: boolean;
    mfaRequiredForAdmins: boolean;
    selfRegistrationEnabled: boolean;
    deployEnabled: boolean;
    orderStatusRateLimitEnabled: boolean;
    orderStatusRateLimitMax: number;
    orderStatusRateLimitWindowSec: number;
  } | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);
    settings = moduleRef.get(SecuritySettingsService);
    // Buckets propres : le rate-limit de l'endpoint est par IP (supertest = IP
    // locale partagée avec d'autres suites), on part d'un état vierge.
    limiter.reset();

    const existing = await prisma.securitySetting.findFirst();
    priorSettings = existing
      ? {
          turnstileEnabled: existing.turnstileEnabled,
          turnstileSiteKey: existing.turnstileSiteKey,
          turnstileSecretEnc: existing.turnstileSecretEnc,
          oauthGoogleEnabled: existing.oauthGoogleEnabled,
          oauthGithubEnabled: existing.oauthGithubEnabled,
          mfaRequiredForAdmins: existing.mfaRequiredForAdmins,
          selfRegistrationEnabled: existing.selfRegistrationEnabled,
          deployEnabled: existing.deployEnabled,
          orderStatusRateLimitEnabled: existing.orderStatusRateLimitEnabled,
          orderStatusRateLimitMax: existing.orderStatusRateLimitMax,
          orderStatusRateLimitWindowSec: existing.orderStatusRateLimitWindowSec,
        }
      : null;
    await prisma.securitySetting.deleteMany({}).catch(() => {});

    const product = await prisma.product.create({ data: { name: `e2e-order-status-${stamp}` } });
    const customer = await prisma.customer.create({
      data: { email: `e2e-order-status-${stamp}@example.com`, name: 'E2E Order Status' },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'E2E Order Status',
        customerEmail: customer.email,
        productId: product.id,
        productName: product.name,
        status: OrderStatus.PROVISIONING,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.customer.deleteMany({ where: { email: `e2e-order-status-${stamp}@example.com` } });
    await prisma.product.deleteMany({ where: { name: `e2e-order-status-${stamp}` } });
    // Restauration EXACTE du singleton (row préexistante recréée telle quelle,
    // sinon suppression de la row du test) — aucune config résiduelle.
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    if (priorSettings) {
      await prisma.securitySetting.create({ data: priorSettings }).catch(() => {});
    }
    await app.close();
  });

  it('id inexistant → 200 + { found: false }', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/store/orders/cm0000000000000000000000000/status`)
      .expect(200);
    expect(res.body).toEqual({ found: false });
  });

  it('commande existante → { found: true, status } SANS aucune PII', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/store/orders/${orderId}/status`)
      .expect(200);
    expect(res.body).toEqual({ found: true, status: OrderStatus.PROVISIONING });
    expect(res.body).not.toHaveProperty('customerEmail');
    expect(res.body).not.toHaveProperty('invoiceNumber');
    expect(res.body).not.toHaveProperty('createdAt');
    expect(res.body).not.toHaveProperty('orderId');
  });

  it('dépassement → 429 + Retry-After ; X-Forwarded-For forgé IGNORÉ (trust proxy désactivé)', async () => {
    const actor = { sub: 'e2e-order-status', email: 'e2e-order-status@example.com' };
    try {
      // Configuration courte appliquée par le service (invalide le cache 30 s)
      // pour observer le dépassement sans attente.
      await settings.update(
        { orderStatusRateLimitEnabled: true, orderStatusRateLimitMax: 5, orderStatusRateLimitWindowSec: 10 },
        actor,
      );
      limiter.reset();

      const path = `/${GlobalPrefix}/store/orders/${orderId}/status`;
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer()).get(path).expect(200);
      }

      // 6ᵉ requête → 429 (Too Many Requests) + Retry-After entier positif.
      const blocked = await request(app.getHttpServer()).get(path).expect(429);
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);

      // X-Forwarded-For FORGÉ ignoré : trust proxy est désactivé (défaut), donc
      // le bucket reste celui de l'adresse socket — une IP inventée par le
      // client ne contourne pas la limite.
      await request(app.getHttpServer())
        .get(path)
        .set('X-Forwarded-For', '203.0.113.7')
        .expect(429);
      await request(app.getHttpServer())
        .get(path)
        .set('X-Forwarded-For', '198.51.100.42')
        .expect(429);
    } finally {
      // Restauration : la suite revient au défaut recommandé, buckets purgés.
      await settings
        .update(
          { orderStatusRateLimitEnabled: true, orderStatusRateLimitMax: 30, orderStatusRateLimitWindowSec: 60 },
          actor,
        )
        .catch(() => {});
      limiter.reset();
    }
  });
});
