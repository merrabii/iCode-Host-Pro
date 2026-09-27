import { ServiceUnavailableException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { ProvisioningService } from './../src/store/provisioning.service';
import { OrderCancelService } from './../src/store/order-cancel.service';
import { DeploymentsService } from './../src/deployments/deployments.service';
import { C4CapabilityService } from './../src/hosting/c4-capability.service';

/**
 * 17B.4F-C4 — e2e sur base PRÉ-MIGRATION C4 (`icode_host_pro_c4premig` :
 * 48/48 migrations C1–C3 appliquées puis objets C4 DROPpés — 0 table C4 ;
 * identité vérifiée par `current_database()` + `to_regclass`). Scénarios de
 * revue sous `HOSTING_C4_ENABLED=true` :
 *
 *  1. capability C4 : `operational() === false` (5 tables absentes) et
 *     `assertOperational()` → 503 fail-closed « migration C4 requise » ;
 *  2. les TROIS portes d'entrée à mutation sous ON (`cancelProvisioning`,
 *     `finalizeProvisioning`, `deployments.remove`) refusent 503 AVANT tout
 *     lookup/écriture — y compris sur des identifiants inexistants (la sonde
 *     est strictement en amont du gate d'existence) ;
 *  3. ZÉRO écriture : comptes AuditLog/Order/HostingServiceAllocation inchangés,
 *     aucune table C4 apparue (le refus n'est jamais un demi-protocole).
 *
 * Aucun `.env` modifié, aucun appel provider/DNS réel (stubs Panel/Mail), et
 * la base n'est JAMAIS migrée ici : la capacité est testée sur son ABSENCE.
 */
describe('Garde C4 — base sans migration C4 (pré-migration c4premig)', () => {
  delete process.env.HOSTING_C3_ENABLED; // hors sujet ici : C4 est le sujet
  process.env.HOSTING_C4_ENABLED = 'true'; // ON : les gardes doivent refuser

  let app: INestApplication;
  let prisma: PrismaService;
  let provisioning: ProvisioningService;
  let orderCancel: OrderCancelService;
  let deployments: DeploymentsService;
  let c4c: C4CapabilityService;

  const actor = { sub: 'user-premig-e2e', email: 'premig-e2e@example.com' };
  const fakePanelFactory = {
    create: () =>
      ({
        verify: jest.fn().mockResolvedValue({ ok: true }),
        createGitApp: jest.fn().mockResolvedValue({ uuid: 'never-called' }),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
        deleteApplication: jest.fn().mockResolvedValue(undefined),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

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
    orderCancel = moduleRef.get(OrderCancelService);
    deployments = moduleRef.get(DeploymentsService);
    c4c = moduleRef.get(C4CapabilityService);

    // Garde d'identité : cette suite n'exécute QUE sur la base pré-migratoire
    // dédiée (jamais la live, jamais une base complète — le test 3 affirme
    // l'ABSENCE des tables, ce qui serait faux ailleurs).
    const dbs = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (dbs[0]?.db !== 'icode_host_pro_c4premig') {
      throw new Error(
        `Base "${dbs[0]?.db}" inattendue — c4-premig est réservée à icode_host_pro_c4premig.`,
      );
    }
    const c4Table = await prisma.$queryRaw<Array<{ n: string | null }>>`
      SELECT to_regclass('public."C4ProviderAttempt"')::text AS n`;
    if (c4Table[0]?.n !== null) {
      throw new Error(
        `Table C4 présente sur "${dbs[0]?.db}" — la base pré-migratoire a été migrée (restaurer le DROP).`,
      );
    }
  });

  afterAll(async () => {
    delete process.env.HOSTING_C4_ENABLED;
    await app.close();
  });

  it('capability C4 : operational() = false (0/5 tables) + assertOperational() → 503', async () => {
    expect(await c4c.operational()).toBe(false);
    await expect(c4c.assertOperational()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(c4c.assertOperational()).rejects.toThrow(/migration C4 requise/);
    expect(c4c.negativeCacheAgeMs()).not.toBeNull(); // négatif diagnostiqué, jamais un fondement
  });

  it('les 3 portes à mutation sous ON → 503 AVANT lookup/écriture (identifiants inexistants inclus)', async () => {
    const before = {
      audits: await prisma.auditLog.count(),
      orders: await prisma.order.count(),
      allocations: await prisma.hostingServiceAllocation.count(),
      services: await prisma.hostingService.count(),
    };

    // 1) cancelProvisioning : assertOperational strictement AVANT le gate
    //    d'existence de l'Order (raison ≥8 pour passer le DTO interne).
    await expect(
      orderCancel.cancelProvisioning('ord-inexistante-c4', 'motif e2e 503', actor),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // 2) finalizeProvisioning : raison ✓ + flag ON ✓ puis 503 avant lookup.
    await expect(
      provisioning.finalizeProvisioning('ord-inexistante-c4', 'motif e2e 503', actor),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // 3) deployments.remove : assertOperational AVANT la row (404 jamais atteint).
    await expect(
      deployments.remove('dep-inexistante-c4', actor),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // ZÉRO écriture : les comptes sont strictement inchangés.
    const after = {
      audits: await prisma.auditLog.count(),
      orders: await prisma.order.count(),
      allocations: await prisma.hostingServiceAllocation.count(),
      services: await prisma.hostingService.count(),
    };
    expect(after).toEqual(before);

    // Aucune table C4 n'est apparue (le refus n'est jamais un demi-protocole).
    const c4Table = await prisma.$queryRaw<Array<{ n: string | null }>>`
      SELECT to_regclass('public."C4ProviderAttempt"')::text AS n`;
    expect(c4Table[0]?.n).toBeNull();
  });

  it('sous OFF la même base pré-migratoire reste utilisable (garde no-op, contrat historique)', async () => {
    delete process.env.HOSTING_C4_ENABLED;
    try {
      // No-op sous OFF : aucun 503 malgré l'absence de schéma C4.
      await expect(c4c.assertOperational()).resolves.toBeUndefined();
      // Le lookup existe maintenant (hors schéma C4) → NotFound, PAS 503.
      await expect(
        orderCancel.cancelProvisioning('ord-inexistante-c4', 'motif e2e 503', actor),
      ).rejects.not.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      process.env.HOSTING_C4_ENABLED = 'true';
    }
  });
});
