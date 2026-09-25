import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HostingServiceAllocationStatus, HostingServiceStatus, OrderStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { HostingServicesService } from './../src/hosting/hosting-services.service';

/**
 * 17B.4F-B1 — fondation HostingService / HostingServiceAllocation sur Prisma RÉEL.
 *
 * Fixtures isolées (suffixe horodaté) et intégralement nettoyées. Aucun appel
 * Coolify / Cloudflare / Hestia : uniquement des lectures/écritures Prisma locale.
 * La suite prouve aussi le caractère STRICTEMENT ADDITIF de la migration :
 * 0 HostingService créé, 0 allocation créée, toutes les lignes legacy à
 * hostingServiceId = NULL.
 */
const MIGRATION_NAME = '20260925150000_add_hosting_service_foundation';

describe('HostingService foundation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hosting: HostingServicesService;
  const stamp = Date.now();
  const marker = `e2e-hs-${stamp}`;

  const ids: Record<string, string> = {};
  const snap = {
    maxAppsSnapshot: 2,
    ramMbSnapshot: 1024,
    cpuCoresSnapshot: 1,
    storageLimitGbSnapshot: 20,
    packNameSnapshot: null as string | null,
    productNameSnapshot: null as string | null,
  };

  async function cleanup(): Promise<void> {
    // ordre fail-closed (dépendances d'abord, sinon les FK RESTRICT refusent) :
    // déploiements → allocations → projets → services → catalogue → utilisateurs.
    await prisma.deployment
      .deleteMany({ where: { user: { email: { startsWith: `${marker}-` } } } })
      .catch(() => {});
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { idempotencyKey: { contains: marker } } })
      .catch(() => {});
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { hostingService: { user: { email: { startsWith: `${marker}-` } } } } })
      .catch(() => {});
    await prisma.clientProject
      .deleteMany({ where: { user: { email: { startsWith: `${marker}-` } } } })
      .catch(() => {});
    await prisma.hostingService
      .deleteMany({ where: { user: { email: { startsWith: `${marker}-` } } } })
      .catch(() => {});
    await prisma.server.deleteMany({ where: { name: { startsWith: marker } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { userId: { in: [ids.user1, ids.user2, ids.user3].filter(Boolean) } } }).catch(() => {});
    await prisma.order
      .deleteMany({ where: { id: { in: [ids.order1, ids.order2, ids.order3].filter(Boolean) } } })
      .catch(() => {});
    await prisma.customer.deleteMany({ where: { email: `${marker}-owner@example.com` } }).catch(() => {});
    await prisma.product.deleteMany({ where: { name: `${marker}-product` } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { name: `${marker}-pack` } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${marker}-` } } }).catch(() => {});
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    hosting = new HostingServicesService(prisma);

    const user1 = await prisma.user.create({
      data: { email: `${marker}-owner@example.com`, passwordHash: 'e2e-hash' },
    });
    const user2 = await prisma.user.create({
      data: { email: `${marker}-other@example.com`, passwordHash: 'e2e-hash' },
    });
    const pack = await prisma.hostingPack.create({
      data: { name: `${marker}-pack`, ramMb: 1024, cpuCores: 1, storageLimit: 20, maxApps: 2 },
    });
    const product = await prisma.product.create({
      data: { name: `${marker}-product`, packId: pack.id },
    });
    const customer = await prisma.customer.create({
      data: { email: `${marker}-owner@example.com`, name: 'E2E HostingService', userId: user1.id },
    });
    const order1 = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'E2E HostingService',
        customerEmail: customer.email,
        productId: product.id,
        productName: product.name,
        packId: pack.id,
        status: OrderStatus.ACTIVE,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
      },
    });
    const order2 = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'E2E HostingService',
        customerEmail: customer.email,
        productId: product.id,
        productName: product.name,
        packId: pack.id,
        status: OrderStatus.ACTIVE,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
      },
    });
    const subscription = await prisma.subscription.create({
      data: { userId: user1.id, productId: product.id, orderId: order1.id, status: 'ACTIVE' },
    });
    const server1 = await prisma.server.create({
      data: { name: `${marker}-server-1`, hostname: 'e2e.invalid' },
    });
    const server2 = await prisma.server.create({
      data: { name: `${marker}-server-2`, hostname: 'e2e.invalid' },
    });
    const deployment = await prisma.deployment.create({
      data: { userId: user1.id, repoFullName: 'e2e/foundation', status: 'ACTIVE' },
    });

    Object.assign(ids, {
      user1: user1.id,
      user2: user2.id,
      pack: pack.id,
      product: product.id,
      customer: customer.id,
      order1: order1.id,
      order2: order2.id,
      subscription: subscription.id,
      server1: server1.id,
      server2: server2.id,
      deployment: deployment.id,
    });
    // Snapshots figés à l'achat : libellés lisibles du pack/produit du moment.
    snap.packNameSnapshot = pack.name;
    snap.productNameSnapshot = product.name;

    // Projet legacy (héritage modèle ancien) : user1 + server1, service NULL.
    const legacyProject = await prisma.clientProject.create({
      data: { userId: user1.id, serverId: server1.id, name: `client-${stamp}-a`, projectUuid: `uuid-${stamp}-a` },
    });
    const legacyProjectOtherUser = await prisma.clientProject.create({
      data: { userId: user2.id, serverId: server1.id, name: `client-${stamp}-b`, projectUuid: `uuid-${stamp}-b` },
    });
    Object.assign(ids, {
      legacyProject: legacyProject.id,
      legacyProjectOtherUser: legacyProjectOtherUser.id,
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('1. migration applicable : aucune ligne live créée, legacy tout à NULL', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; applied_steps_count: number }>
    >`select "migration_name", "finished_at", "rolled_back_at", "applied_steps_count" from "_prisma_migrations" where "migration_name" = ${MIGRATION_NAME}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[0].rolled_back_at).toBeNull();
    expect(rows[0].applied_steps_count).toBe(1);

    expect(await prisma.hostingService.count()).toBe(0);
    expect(await prisma.hostingServiceAllocation.count()).toBe(0);
    expect(await prisma.deployment.count({ where: { hostingServiceId: { not: null } } })).toBe(0);
    expect(await prisma.clientProject.count({ where: { hostingServiceId: { not: null } } })).toBe(0);
  });

  it('2. crée un HostingService lié à User/Order/Subscription/Pack', async () => {
    const service = await hosting.create(ids.user1, {
      orderId: ids.order1,
      subscriptionId: ids.subscription,
      productId: ids.product,
      packId: ids.pack,
      snapshots: snap,
    });
    ids.service1 = service.id;

    const loaded = await prisma.hostingService.findUniqueOrThrow({
      where: { id: service.id },
      include: { user: true, order: true, subscription: true, pack: true, product: true },
    });
    expect(loaded.userId).toBe(ids.user1);
    expect(loaded.orderId).toBe(ids.order1);
    expect(loaded.subscriptionId).toBe(ids.subscription);
    expect(loaded.packId).toBe(ids.pack);
    expect(loaded.productId).toBe(ids.product);
    expect(loaded.order?.id).toBe(ids.order1);
    expect(loaded.subscription?.id).toBe(ids.subscription);
    expect(loaded.pack?.name).toBe(`${marker}-pack`);
    expect(loaded.product?.name).toBe(`${marker}-product`);
    expect(loaded.status).toBe(HostingServiceStatus.PROVISIONING);
    expect(loaded.maxAppsSnapshot).toBe(2);
    expect(loaded.ramMbSnapshot).toBe(1024);
    expect(loaded.cpuCoresSnapshot).toBe(1);
    expect(loaded.packNameSnapshot).toBe(`${marker}-pack`);
    expect(loaded.productNameSnapshot).toBe(`${marker}-product`);
  });

  it('3. une FK invalide est refusée par PostgreSQL (P2003)', async () => {
    await expect(
      prisma.hostingService.create({
        data: { userId: 'user-inexistant-000', ramMbSnapshot: 1024, cpuCoresSnapshot: 1 },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.hostingService.create({
        data: { userId: ids.user1, packId: 'pack-inexistant-000', ramMbSnapshot: 1024, cpuCoresSnapshot: 1 },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('4. l’unicité de orderId est garantie en base (P2002)', async () => {
    // le service traduit P2002 en 409 métier (aucune fuite de détail DB)
    await expect(hosting.create(ids.user1, { orderId: ids.order1, snapshots: snap })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // l'unicité DB, indépendamment du service
    await expect(
      prisma.hostingService.create({
        data: { userId: ids.user1, orderId: ids.order1, ramMbSnapshot: 1024, cpuCoresSnapshot: 1 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('5. l’unicité de subscriptionId est garantie en base (P2002)', async () => {
    await expect(
      prisma.hostingService.create({
        data: {
          userId: ids.user1,
          subscriptionId: ids.subscription,
          ramMbSnapshot: 1024,
          cpuCoresSnapshot: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('6. la clé d’idempotence de réservation est unique', async () => {
    const key = `${marker}-res`;
    const allocation = await hosting.reserve({
      hostingServiceId: ids.service1,
      actorUserId: ids.user1,
      idempotencyKey: key,
    });
    ids.allocation1 = allocation.id;
    expect(allocation.status).toBe(HostingServiceAllocationStatus.RESERVED);

    // retry avec la même clé → 409 métier, jamais une 2e ligne
    await expect(
      hosting.reserve({ hostingServiceId: ids.service1, actorUserId: ids.user1, idempotencyKey: key }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      prisma.hostingServiceAllocation.create({
        data: { hostingServiceId: ids.service1, idempotencyKey: key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('7. un Deployment ne peut être lié qu’à une seule allocation (P2002)', async () => {
    const bound = await hosting.bind({
      allocationId: ids.allocation1,
      actorUserId: ids.user1,
      deploymentId: ids.deployment,
    });
    expect(bound.status).toBe(HostingServiceAllocationStatus.BOUND);
    expect(bound.deploymentId).toBe(ids.deployment);
    expect(bound.boundAt).not.toBeNull();

    const other = await hosting.reserve({
      hostingServiceId: ids.service1,
      actorUserId: ids.user1,
      idempotencyKey: `${marker}-res-2`,
    });
    ids.allocation2 = other.id;
    await expect(
      prisma.hostingServiceAllocation.update({
        where: { id: other.id },
        data: { deploymentId: ids.deployment },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('8. un même utilisateur peut posséder plusieurs services', async () => {
    const second = await hosting.create(ids.user1, {
      orderId: ids.order2,
      packId: ids.pack,
      productId: ids.product,
      snapshots: { ...snap, maxAppsSnapshot: 0 },
    });
    ids.service2 = second.id;
    const count = await prisma.hostingService.count({ where: { userId: ids.user1 } });
    expect(count).toBe(2);
  });

  it('9. deux services peuvent référencer le même pack', async () => {
    const rows = await prisma.hostingService.findMany({ where: { userId: ids.user1, packId: ids.pack } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.packId))).toEqual(new Set([ids.pack]));
    expect(rows.filter((row) => row.maxAppsSnapshot === 2)).toHaveLength(1);
    expect(rows.filter((row) => row.maxAppsSnapshot === 0)).toHaveLength(1);
  });

  it('10. un Deployment legacy reste valide avec hostingServiceId = null', async () => {
    const legacy = await prisma.deployment.findUniqueOrThrow({ where: { id: ids.deployment } });
    expect(legacy.hostingServiceId).toBeNull();

    const linked = await prisma.deployment.create({
      data: {
        userId: ids.user1,
        repoFullName: 'e2e/linked',
        status: 'ACTIVE',
        hostingServiceId: ids.service1,
      },
    });
    ids.linkedDeployment = linked.id;
    const reloaded = await prisma.deployment.findUniqueOrThrow({ where: { id: linked.id } });
    expect(reloaded.hostingServiceId).toBe(ids.service1);
  });

  it('11. ClientProject legacy reste valide (NULLS DISTINCT) et la nouvelle unicité s’applique', async () => {
    const projects = await prisma.clientProject.findMany({ where: { serverId: ids.server1 } });
    expect(projects).toHaveLength(2);
    expect(projects.every((project) => project.hostingServiceId === null)).toBe(true);

    const withService = await prisma.clientProject.create({
      data: {
        userId: ids.user2,
        serverId: ids.server2,
        hostingServiceId: ids.service1,
        name: `client-${stamp}-c`,
        projectUuid: `uuid-${stamp}-c`,
      },
    });
    ids.serviceProject = withService.id;

    // même (hostingServiceId, serverId) sur un autre compte → refusé (P2002)
    await expect(
      prisma.clientProject.create({
        data: {
          userId: ids.user1,
          serverId: ids.server2,
          hostingServiceId: ids.service1,
          name: `client-${stamp}-d`,
          projectUuid: `uuid-${stamp}-d`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // l'historique @@unique([userId, serverId]) est toujours active
    await expect(
      prisma.clientProject.create({
        data: {
          userId: ids.user1,
          serverId: ids.server1,
          name: `client-${stamp}-e`,
          projectUuid: `uuid-${stamp}-e`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('12. aucune allocation n’est créée pour un service CANCELLED', async () => {
    await prisma.hostingService.update({
      where: { id: ids.service2 },
      data: { status: HostingServiceStatus.CANCELLED },
    });
    await expect(
      hosting.reserve({
        hostingServiceId: ids.service2,
        actorUserId: ids.user1,
        idempotencyKey: `${marker}-cancelled`,
      }),
    ).rejects.toThrow();
    expect(await prisma.hostingServiceAllocation.count({ where: { hostingServiceId: ids.service2 } })).toBe(0);
  });

  it('13. aucune allocation ne peut pointer vers un service inexistant (P2003)', async () => {
    await expect(
      prisma.hostingServiceAllocation.create({
        data: { hostingServiceId: 'service-inexistant-000', idempotencyKey: `${marker}-orphan` },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    // une allocation est NOT NULL sur son service : jamais « flottante »
    expect(ids.service1).toBeTruthy();
  });

  // ── 14-19 : référentiel fail-closed (ON DELETE RESTRICT) ───────────────────

  it('14. supprimer un Utilisateur possédant un service est refusé (FK RESTRICT)', async () => {
    const user3 = await prisma.user.create({
      data: { email: `${marker}-restricted@example.com`, passwordHash: 'e2e-hash' },
    });
    ids.user3 = user3.id;
    const service3 = await hosting.create(user3.id, { packId: ids.pack, snapshots: snap });
    ids.service3 = service3.id;

    await expect(prisma.user.delete({ where: { id: user3.id } })).rejects.toMatchObject({ code: 'P2003' });

    // ni suppression, ni mise à NULL silencieuse
    expect(await prisma.user.findUnique({ where: { id: user3.id } })).not.toBeNull();
    const reloaded = await prisma.hostingService.findUniqueOrThrow({ where: { id: service3.id } });
    expect(reloaded.userId).toBe(user3.id);
  });

  it('15. supprimer un service portant une allocation est refusé (FK RESTRICT)', async () => {
    const service4 = await hosting.create(ids.user1, { packId: ids.pack, snapshots: snap });
    ids.service4 = service4.id;
    const allocation = await hosting.reserve({
      hostingServiceId: service4.id,
      actorUserId: ids.user1,
      idempotencyKey: `${marker}-restricted-alloc`,
    });
    ids.allocationRestricted = allocation.id;

    await expect(prisma.hostingService.delete({ where: { id: service4.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.hostingService.findUnique({ where: { id: service4.id } })).not.toBeNull();
    expect(
      (await prisma.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocation.id } })).hostingServiceId,
    ).toBe(service4.id);
  });

  it('16. supprimer un service lié à un Deployment est refusé (FK RESTRICT)', async () => {
    const service5 = await hosting.create(ids.user1, { packId: ids.pack, snapshots: snap });
    ids.service5 = service5.id;
    const linked = await prisma.deployment.create({
      data: { userId: ids.user1, repoFullName: 'e2e/restrict-dep', status: 'ACTIVE', hostingServiceId: service5.id },
    });
    ids.restrictDeployment = linked.id;

    await expect(prisma.hostingService.delete({ where: { id: service5.id } })).rejects.toMatchObject({ code: 'P2003' });
    const reloaded = await prisma.deployment.findUniqueOrThrow({ where: { id: linked.id } });
    expect(reloaded.hostingServiceId).toBe(service5.id);
  });

  it('17. supprimer un service lié à un ClientProject est refusé (FK RESTRICT)', async () => {
    const service6 = await hosting.create(ids.user1, { packId: ids.pack, snapshots: snap });
    ids.service6 = service6.id;
    const project = await prisma.clientProject.create({
      data: {
        userId: ids.user1,
        serverId: ids.server2,
        hostingServiceId: service6.id,
        name: `client-${stamp}-restrict`,
        projectUuid: `uuid-${stamp}-restrict`,
      },
    });
    ids.restrictProject = project.id;

    await expect(prisma.hostingService.delete({ where: { id: service6.id } })).rejects.toMatchObject({ code: 'P2003' });
    const reloaded = await prisma.clientProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(reloaded.hostingServiceId).toBe(service6.id);
  });

  it('18. aucune relation n’est silencieusement mise à NULL après les refus', async () => {
    const service3 = await prisma.hostingService.findUniqueOrThrow({ where: { id: ids.service3 } });
    expect(service3.userId).toBe(ids.user3);

    const service4 = await prisma.hostingService.findUniqueOrThrow({ where: { id: ids.service4 } });
    expect(service4.status).not.toBeNull();

    const allocation = await prisma.hostingServiceAllocation.findUniqueOrThrow({ where: { id: ids.allocationRestricted } });
    expect(allocation.hostingServiceId).toBe(ids.service4);
    expect(allocation.status).toBe(HostingServiceAllocationStatus.RESERVED);

    const linked = await prisma.deployment.findUniqueOrThrow({ where: { id: ids.restrictDeployment } });
    expect(linked.hostingServiceId).toBe(ids.service5);

    const project = await prisma.clientProject.findUniqueOrThrow({ where: { id: ids.restrictProject } });
    expect(project.hostingServiceId).toBe(ids.service6);

    // les 4 services du référentiel existent toujours, rattachés
    const idsToCheck = [ids.service3, ids.service4, ids.service5, ids.service6];
    expect(await prisma.hostingService.count({ where: { id: { in: idsToCheck } } })).toBe(4);
    expect(await prisma.deployment.count({ where: { hostingServiceId: { not: null } } })).toBeGreaterThan(0);
    expect(await prisma.clientProject.count({ where: { hostingServiceId: { not: null } } })).toBeGreaterThan(0);
  });

  it('19. suppression possible uniquement après cleanup explicite des dépendances', async () => {
    // (a) service portant une allocation
    await prisma.hostingServiceAllocation.delete({ where: { id: ids.allocationRestricted } });
    await expect(prisma.hostingService.delete({ where: { id: ids.service4 } })).resolves.toBeDefined();
    // (b) service lié à un déploiement
    await prisma.deployment.delete({ where: { id: ids.restrictDeployment } });
    await expect(prisma.hostingService.delete({ where: { id: ids.service5 } })).resolves.toBeDefined();
    // (c) service lié à un projet client
    await prisma.clientProject.delete({ where: { id: ids.restrictProject } });
    await expect(prisma.hostingService.delete({ where: { id: ids.service6 } })).resolves.toBeDefined();
    // (d) utilisateur ne possédant plus aucun service
    await prisma.hostingService.delete({ where: { id: ids.service3 } });
    await expect(prisma.user.delete({ where: { id: ids.user3 } })).resolves.toBeDefined();

    expect(await prisma.hostingService.count({ where: { id: { in: [ids.service3, ids.service4, ids.service5, ids.service6] } } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: ids.user3 } })).toBeNull();
  });

  // ── 20-21 : relations historiques en SET NULL (inchangées) ─────────────────

  it('20. la suppression d’une commande détache le service (SET NULL, service intact)', async () => {
    const order3 = await prisma.order.create({
      data: {
        customerId: ids.customer,
        customerName: 'E2E HostingService',
        customerEmail: `${marker}-owner@example.com`,
        productId: ids.product,
        productName: `${marker}-product`,
        packId: ids.pack,
        status: OrderStatus.ACTIVE,
        amountHtCents: 0,
        taxAmountCents: 0,
        amountTtcCents: 0,
      },
    });
    ids.order3 = order3.id;
    const service7 = await hosting.create(ids.user1, { orderId: order3.id, packId: ids.pack, snapshots: snap });
    ids.service7 = service7.id;
    expect((await prisma.hostingService.findUniqueOrThrow({ where: { id: service7.id } })).orderId).toBe(order3.id);

    await expect(prisma.order.delete({ where: { id: order3.id } })).resolves.toBeDefined();

    const reloaded = await prisma.hostingService.findUniqueOrThrow({ where: { id: service7.id } });
    expect(reloaded.orderId).toBeNull();
    expect(reloaded.userId).toBe(ids.user1);
    expect(reloaded.ramMbSnapshot).toBe(1024);
    expect(reloaded.status).toBe(HostingServiceStatus.PROVISIONING);
  });

  it('21. la suppression d’un abonnement détache le service (SET NULL, service intact)', async () => {
    const subscription2 = await prisma.subscription.create({
      data: { userId: ids.user1, productId: ids.product, status: 'ACTIVE' },
    });
    ids.subscription2 = subscription2.id;
    const service8 = await hosting.create(ids.user1, { subscriptionId: subscription2.id, packId: ids.pack, snapshots: snap });
    ids.service8 = service8.id;

    await expect(prisma.subscription.delete({ where: { id: subscription2.id } })).resolves.toBeDefined();

    const reloaded = await prisma.hostingService.findUniqueOrThrow({ where: { id: service8.id } });
    expect(reloaded.subscriptionId).toBeNull();
    expect(reloaded.userId).toBe(ids.user1);
    expect(reloaded.cpuCoresSnapshot).toBe(1);
  });

  // ── 22 : CPU fini vérifié sur PostgreSQL (contournement du service) ────────

  it('22. le CHECK refuse en base NaN/Infinity/-Infinity/négatif, accepte 0 et le positif', async () => {
    const insertCpu = async (rowId: string, cpuSql: string): Promise<number> =>
      // requête paramétrée (identifiants liés) ; la valeur CPU est un littéral
      // statique du test, jamais interpolée depuis une entrée.
      prisma.$executeRaw`insert into "HostingService" ("id", "userId", "ramMbSnapshot", "cpuCoresSnapshot", "updatedAt") values (${rowId}, ${ids.user1}, 1024, ${cpuSql}::double precision, now())`;

    // acceptés en base : 0 (aucun CPU) et une valeur finie positive
    const accepted = [`${marker}-cpu-zero`, `${marker}-cpu-half`];
    const literals = ['0', '0.5'];
    for (const [index, rowId] of accepted.entries()) {
      await expect(insertCpu(rowId, literals[index])).resolves.toBe(1);
    }
    expect(await prisma.hostingService.count({ where: { id: { in: accepted } } })).toBe(2);

    // refusés en base par le CHECK (contournement du service)
    for (const [index, literal] of ['NaN', 'Infinity', '-Infinity', '-1'].entries()) {
      const rowId = `${marker}-cpu-refus-${index}`;
      let failure: { code?: string; message?: string; meta?: unknown } | undefined;
      try {
        await insertCpu(rowId, literal);
      } catch (error) {
        failure = error as { code?: string; message?: string; meta?: unknown };
      }
      expect(failure).toBeDefined();
      expect(await prisma.hostingService.findUnique({ where: { id: rowId } })).toBeNull();
      // aucun secret ni DSN de base n'est exposé par l'erreur remontée
      expect(String(failure?.message ?? '')).not.toMatch(/password|DATABASE_URL|localhost:5432|icode:/i);
    }

    // nettoyage immédiat des deux lignes acceptées
    await prisma.hostingService.deleteMany({ where: { id: { in: accepted } } });
    expect(await prisma.hostingService.count({ where: { id: { in: accepted } } })).toBe(0);
  });

  it('23. nettoyage des fixtures : plus aucune ligne résiduelle', async () => {
    await cleanup();
    expect(await prisma.hostingService.count()).toBe(0);
    expect(await prisma.hostingServiceAllocation.count()).toBe(0);
    expect(await prisma.hostingServiceAllocation.count({ where: { idempotencyKey: { contains: marker } } })).toBe(0);
    expect(await prisma.clientProject.count({ where: { serverId: { in: [ids.server1, ids.server2] } } })).toBe(0);
    expect(await prisma.deployment.count({ where: { userId: { in: [ids.user1, ids.user2].filter(Boolean) } } })).toBe(0);
    expect(await prisma.order.count({ where: { id: { in: [ids.order1, ids.order2, ids.order3].filter(Boolean) } } })).toBe(0);
    expect(await prisma.subscription.count({ where: { userId: ids.user1 } })).toBe(0);
    expect(await prisma.user.count({ where: { email: { startsWith: `${marker}-` } } })).toBe(0);
  });
});
