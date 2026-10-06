import { ConflictException } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { C4ProtocolService } from '../hosting/c4-protocol.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PanelTransportFactory } from '../servers/panel-transport.factory';
import { SuspensionEffectsService } from './suspension-effects.service';

/**
 * Q5 (GO item 5) — moteur d'effets provider de suspension/réactivation :
 *  - arrêt/relance RÉVERSIBLE via `PanelTransport.stop/startApplication`,
 *    JAMAIS `deleteApplication` (aucune suppression de ressources) ;
 *  - capacité provider manquante / jeton illisible / sans cible → blocage
 *    EXPLICITE (`blocked` + audit `suspension.app_*_blocked`), jamais de faux
 *    succès ; échec réseau → `failed` visible ;
 *  - résolution réelle (Q12-P3) : service via `subscriptionId` OU `orderId`
 *    de l'abonnement (lignes legacy sans lien) ; apps via ALLOCATIONS (C2)
 *    en plus des liens directs ;
 *  - C4 (flag relu à l'appel, défaut test ON) : `beginDispatchStandalone(CONFIGURE)` avec
 *    allocation de l'app + scope SERVICE porteur avant le dispatch (refus →
 *    blocage, transport JAMAIS appelé), `settleStandalone` après (SUCCESS /
 *    PERMANENT_FAILURE capacité / UNKNOWN réseau ambigu) ; **succès provider
 *    non consigné → JAMAIS done** ;
 *  - Q12-P3 barrières : sous OFF, **aucun repli direct** (blocage
 *    `protocole_off`, zéro appel, zéro table C4) ; décision live ≠ opération →
 *    `decision_perimee` ; ON→OFF pendant préparation → tentative `REFUSED`,
 *    zéro appel ; réponse après OFF → consignation limitée, aucun appel suivant ;
 *  - aucun réseau dans le scan : seuls les déploiements à `coolifyUuid` non
 *    null et rattachés au SEUL abonnement demandé sont considérés.
 */
describe('SuspensionEffectsService (Q5)', () => {
  let svc: SuspensionEffectsService;
  let prisma: {
    subscription: { findUnique: jest.Mock };
    hostingService: { findMany: jest.Mock };
    hostingServiceAllocation: { findMany: jest.Mock; findFirst: jest.Mock };
    deployment: { findMany: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let crypto: { decrypt: jest.Mock };
  let transport: { stopApplication: jest.Mock; startApplication: jest.Mock; deleteApplication: jest.Mock };
  let factory: { create: jest.Mock };
  let c4: { beginDispatchStandalone: jest.Mock; settleStandalone: jest.Mock };

  const server = {
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'https://panel.fake.test',
    apiTokenEnc: 'enc',
    strictTls: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HOSTING_C4_ENABLED = 'true'; // défaut test : protocole couvrant ON
    prisma = {
      subscription: {
        findUnique: jest.fn(async () => ({ orderId: 'ord-1', status: 'SUSPENDED' })),
      },
      hostingService: { findMany: jest.fn(async () => [{ id: 'hs-1', orderId: 'ord-1' }]) },
      hostingServiceAllocation: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 'alloc-1', hostingServiceId: 'hs-1' })),
      },
      deployment: {
        findMany: jest.fn(async () => [
          { id: 'dep-1', orderId: 'ord-1', coolifyUuid: 'uuid-1', server },
        ]),
      },
    };
    audit = { record: jest.fn(async () => undefined) };
    crypto = { decrypt: jest.fn(() => 'tok-clear') };
    transport = {
      stopApplication: jest.fn(async () => undefined),
      startApplication: jest.fn(async () => undefined),
      deleteApplication: jest.fn(async () => undefined),
    };
    factory = { create: jest.fn(() => transport) };
    c4 = {
      beginDispatchStandalone: jest.fn(async () => ({ attemptId: 'att-1' })),
      settleStandalone: jest.fn(async () => undefined),
    };
    svc = new SuspensionEffectsService(
      prisma as never,
      audit as never,
      crypto as never,
      factory as never,
      c4 as never,
    );
  });

  afterEach(() => {
    delete process.env.HOSTING_C4_ENABLED;
  });

  const params = { subscriptionId: 'sub-1', holder: 'system:renewal-sweep', orderId: 'ord-1' };

  it('aucun service hébergement sur l\u2019abonnement \u2192 résumé vide, zéro appel, z\u00e9ro audit', async () => {
    prisma.hostingService.findMany.mockResolvedValue([]);
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 0, done: 0, blocked: 0, failed: 0, mode: 'c4' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('arrêt confirm\u00e9 \u2192 done + audit apps_stopped ; JAMAIS deleteApplication', async () => {
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(transport.stopApplication).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'COOLIFY', token: 'tok-clear', strictTls: true }),
      'uuid-1',
    );
    expect(transport.startApplication).not.toHaveBeenCalled();
    expect(transport.deleteApplication).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.apps_stopped',
        resourceType: 'subscription',
        resourceId: 'sub-1',
        details: expect.objectContaining({ apps: 1, done: 1, c4: true, mode: 'c4' }),
      }),
    );
  });

  it('réactivation \u2192 startApplication + audit apps_started (aucune \u00e9criture facture)', async () => {
    prisma.subscription.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'ACTIVE' });
    const out = await svc.resumeApps(params);
    expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
    expect(transport.startApplication).toHaveBeenCalledWith(expect.anything(), 'uuid-1');
    expect(transport.stopApplication).not.toHaveBeenCalled();
    expect(transport.deleteApplication).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'suspension.apps_started' }),
    );
  });

  it('sans cible (serveur panneau absent/incomplet) \u2192 bloqu\u00e9 explicite, transport JAMAIS appel\u00e9', async () => {
    prisma.deployment.findMany.mockResolvedValue([
      { id: 'dep-1', orderId: 'ord-1', coolifyUuid: 'uuid-1', server: null },
    ]);
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.app_stop_blocked',
        resourceId: 'dep-1',
        details: expect.objectContaining({ reason: 'sans_cible' }),
      }),
    );
  });

  it('jeton ind\u00e9chiffrable \u2192 bloqu\u00e9 (jamais de faux succ\u00e8s)', async () => {
    crypto.decrypt.mockImplementation(() => {
      throw new Error('Clé de chiffrement manquante (ENCRYPTION_KEY)');
    });
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.app_stop_blocked',
        details: expect.objectContaining({ reason: 'jeton_indefin' }),
      }),
    );
  });

  it('capacit\u00e9 provider manquante \u2192 bloqu\u00e9 capacit\u00e9_absente (poursuite des autres)', async () => {
    transport.stopApplication.mockRejectedValue(
      new Error('Cette opération n\'est pas disponible pour ce fournisseur (Coolify uniquement).'),
    );
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.app_stop_blocked',
        details: expect.objectContaining({ reason: 'capacite_absente' }),
      }),
    );
  });

  it('\u00e9chec r\u00e9seau \u2192 failed visible + audit app_stop_failed (r\u00e9cup\u00e9rable)', async () => {
    transport.stopApplication.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 0, blocked: 0, failed: 1, mode: 'c4' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.app_stop_failed',
        details: expect.objectContaining({ kind: 'failed', detail: 'ECONNREFUSED' }),
      }),
    );
  });

  describe('Q12-P3 — r\u00e9solution r\u00e9elle (services legacy, apps via allocations)', () => {
    it('service legacy SANS subscriptionId \u2192 r\u00e9solu par l\u2019orderId de l\u2019abonnement', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        orderId: 'ord-legacy',
        status: 'SUSPENDED',
      });
      prisma.hostingService.findMany.mockResolvedValue([
        { id: 'hs-legacy', orderId: 'ord-legacy' },
      ]);
      const out = await svc.suspendApps({
        subscriptionId: 'sub-1',
        holder: 'system:renewal-sweep',
        orderId: null,
      });
      expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
      // O\u00f9 que le service a \u00e9t\u00e9 cherch\u00e9 : subscriptionId OU orderId abonnement.
      expect(prisma.hostingService.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ subscriptionId: 'sub-1' }, { orderId: { in: ['ord-legacy'] } }],
          },
        }),
      );
    });

    it('app reli\u00e9e UNIQUEMENT par son allocation (C2, hostingServiceId/orderId null) \u2192 dispatch\u00e9e', async () => {
      prisma.hostingServiceAllocation.findMany.mockResolvedValue([
        { deploymentId: 'dep-legacy' },
      ]);
      prisma.deployment.findMany.mockResolvedValue([
        { id: 'dep-legacy', orderId: null, coolifyUuid: 'uuid-legacy', server },
      ]);
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
      // Le scan demande BIEN les ids issus des allocations.
      expect(prisma.deployment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ id: { in: ['dep-legacy'] } }]),
          }),
        }),
      );
      expect(transport.stopApplication).toHaveBeenCalledWith(expect.anything(), 'uuid-legacy');
    });

    it('apps d\u2019un AUTRE abonnement (autre service/allocation) jamais touch\u00e9es', async () => {
      prisma.hostingService.findMany.mockResolvedValue([{ id: 'hs-1', orderId: 'ord-1' }]);
      prisma.hostingServiceAllocation.findMany.mockResolvedValue([{ deploymentId: 'dep-1' }]);
      prisma.deployment.findMany.mockResolvedValue([
        { id: 'dep-1', orderId: 'ord-1', coolifyUuid: 'uuid-1', server },
      ]);
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
      // Le scan n'interroge QUE les allocations des services de CET abonnement.
      expect(prisma.hostingServiceAllocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { hostingServiceId: { in: ['hs-1'] }, deploymentId: { not: null } },
        }),
      );
      // Aucun id d\u2019app \u00e9tranger (dep-other) n'entre dans le filtre.
      const depWhere = prisma.deployment.findMany.mock.calls[0][0].where as unknown;
      expect(JSON.stringify(depWhere)).not.toContain('dep-other');
      expect(transport.stopApplication).toHaveBeenCalledTimes(1);
      expect(transport.stopApplication).toHaveBeenCalledWith(expect.anything(), 'uuid-1');
    });
  });

  describe('C4 (flag relu \u00e0 l\u2019appel)', () => {
    it('dispatch r\u00e9ussi \u2192 begin CONFIGURE (allocation + scope SERVICE de l\u2019app) puis settle SUCCESS', async () => {
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
      expect(c4.beginDispatchStandalone).toHaveBeenCalledWith({
        nature: 'CONFIGURE',
        scope: { type: 'DEPLOYMENT', id: 'dep-1' },
        allocationId: 'alloc-1',
        holder: 'system:renewal-sweep',
        orderId: 'ord-1',
        serviceId: 'hs-1',
        targetIntent: { type: 'application', op: 'stop', uuid: 'uuid-1' },
        // GO fenêtres R2 : décision portée DANS la transaction de tentative
        // (lecture `FOR UPDATE` sérialisée avec les transitions de l'abonnement).
        freshnessGuard: { subscriptionId: 'sub-1', expected: 'SUSPENDED' },
      });
      expect(transport.stopApplication).toHaveBeenCalledTimes(1);
      expect(c4.settleStandalone).toHaveBeenCalledWith({
        attemptId: 'att-1',
        holder: 'system:renewal-sweep',
        outcome: 'SUCCESS',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.apps_stopped',
          details: expect.objectContaining({ c4: true, mode: 'c4' }),
        }),
      );
    });

    it('refus C4 (Conflit) \u2192 bloqu\u00e9 c4_refuse, transport JAMAIS appel\u00e9', async () => {
      c4.beginDispatchStandalone.mockRejectedValue(new ConflictException('Arrêt opposable.'));
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
      expect(factory.create).not.toHaveBeenCalled();
      expect(transport.stopApplication).not.toHaveBeenCalled();
      expect(c4.settleStandalone).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          details: expect.objectContaining({ reason: 'c4_refuse' }),
        }),
      );
    });

    it('capacit\u00e9 absente sous C4 \u2192 settle PERMANENT_FAILURE + blocage', async () => {
      transport.stopApplication.mockRejectedValue(
        new Error('Opération non disponible pour ce fournisseur (Coolify uniquement).'),
      );
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-1', outcome: 'PERMANENT_FAILURE' }),
      );
    });

    it('timeout ambigu sous C4 \u2192 settle UNKNOWN (incertitude durable) + failed visible', async () => {
      transport.stopApplication.mockRejectedValue(new Error('ETIMEDOUT'));
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 0, failed: 1, mode: 'c4' });
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-1', outcome: 'UNKNOWN' }),
      );
      expect(c4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'FAILED_RETRYABLE' }),
      );
    });

    it('succ\u00e8s provider puis \u00e9chec de consignation \u2192 JAMAIS done (tentative ouverte)', async () => {
      c4.settleStandalone.mockRejectedValueOnce(new Error('pg down'));
      const out = await svc.suspendApps(params);
      // Le transport a R\u00e9USSI mais la consignation a \u00e9chou\u00e9 : aucun
      // requalification `done`, \u00e9chec visible + audit\u00e9.
      expect(transport.stopApplication).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 0, failed: 1, mode: 'c4' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_failed',
          details: expect.objectContaining({ detail: expect.stringContaining('non consign\u00e9') }),
        }),
      );
    });

    it('r\u00e9activation sous C4 \u2192 begin CONFIGURE op=start puis settle SUCCESS', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'ACTIVE' });
      const out = await svc.resumeApps(params);
      expect(out.done).toBe(1);
      expect(c4.beginDispatchStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ targetIntent: { type: 'application', op: 'start', uuid: 'uuid-1' } }),
      );
      expect(transport.startApplication).toHaveBeenCalledTimes(1);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'SUCCESS' }),
      );
    });
  });

  describe('Q12-P3 — barri\u00e8res de d\u00e9cision (OFF, fra\u00eecheur, contournement)', () => {
    it('OFF \u2192 aucun repli direct : z\u00e9ro appel r\u00e9seau, z\u00e9ro table C4, blocage protocole_off audit\u00e9', async () => {
      delete process.env.HOSTING_C4_ENABLED;
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'off' });
      expect(factory.create).not.toHaveBeenCalled();
      expect(c4.beginDispatchStandalone).not.toHaveBeenCalled();
      expect(c4.settleStandalone).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          resourceId: 'dep-1',
          details: expect.objectContaining({ reason: 'protocole_off' }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.apps_stopped',
          details: expect.objectContaining({ c4: false, mode: 'off' }),
        }),
      );
    });

    it('OFF \u00e9galement sur la r\u00e9activation \u2192 aucun start direct (m\u00eame classification)', async () => {
      delete process.env.HOSTING_C4_ENABLED;
      prisma.subscription.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'ACTIVE' });
      const out = await svc.resumeApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'off' });
      expect(transport.startApplication).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_start_blocked',
          details: expect.objectContaining({ reason: 'protocole_off' }),
        }),
      );
    });

    it('d\u00e9cision plus r\u00e9cente (statut live \u2260 op\u00e9ration) \u2192 decision_perimee, z\u00e9ro pr\u00e9paration, z\u00e9ro appel', async () => {
      // L'abonnement est d\u00e9j\u00e0 repass\u00e9 ACTIVE (r\u00e9activation concurrente committ\u00e9e)
      // alors que l'effet de suspension part : aucune action n'est pr\u00e9par\u00e9e.
      prisma.subscription.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'ACTIVE' });
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
      expect(factory.create).not.toHaveBeenCalled();
      expect(c4.beginDispatchStandalone).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          details: expect.objectContaining({ reason: 'decision_perimee' }),
        }),
      );
    });

    it('décision périmee détectée SOUS VERROU dans la tx de tentative → même blocage decision_perimee, zéro appel', async () => {
      // GO fenêtres R2 : la lecture d'entrée a PASSÉ (SUSPENDED) mais la
      // transition concurrente committée avant l'enregistrement de la
      // tentative fait refuser `beginDispatch` sous verrou → aucune tentative
      // n'existe, aucun transport n'est appelé, raison = decision_perimee.
      c4.beginDispatchStandalone.mockRejectedValue(
        new ConflictException(
          'decision_perimee: abonnement ACTIVE ≠ SUSPENDED (transition concurrente) — tentative non enregistrée.',
        ),
      );
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
      expect(factory.create).not.toHaveBeenCalled();
      expect(transport.stopApplication).not.toHaveBeenCalled();
      expect(c4.settleStandalone).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          details: expect.objectContaining({ reason: 'decision_perimee' }),
        }),
      );
    });

    it('ON\u2192OFF pendant la pr\u00e9paration \u2192 tentative consign\u00e9e REFUSED, AUCUN contournement', async () => {
      c4.beginDispatchStandalone.mockImplementation(async () => {
        // Bascule APR\u00c8S l'\u00e9mission du ticket, AVANT l'appel transport.
        process.env.HOSTING_C4_ENABLED = 'false';
        return { attemptId: 'att-1' };
      });
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0, mode: 'c4' });
      expect(factory.create).not.toHaveBeenCalled();
      expect(transport.stopApplication).not.toHaveBeenCalled();
      expect(c4.settleStandalone).toHaveBeenCalledWith({
        attemptId: 'att-1',
        holder: 'system:renewal-sweep',
        outcome: 'REFUSED',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          details: expect.objectContaining({ reason: 'protocole_off' }),
        }),
      );
    });

    it('r\u00e9ponse re\u00e7ue apr\u00e8s passage OFF \u2192 consignation limit\u00e9e, AUCUN appel suivant', async () => {
      prisma.deployment.findMany.mockResolvedValue([
        { id: 'dep-1', orderId: 'ord-1', coolifyUuid: 'uuid-1', server },
        { id: 'dep-2', orderId: 'ord-1', coolifyUuid: 'uuid-2', server },
      ]);
      transport.stopApplication.mockImplementation(async () => {
        // L'OFF arrive PENDANT l'appel : la r\u00e9ponse reste consign\u00e9e...
        process.env.HOSTING_C4_ENABLED = 'false';
      });
      const out = await svc.suspendApps(params);
      // ...mais le dispatch suivant est bloqu\u00e9 : aucun appel suppl\u00e9mentaire.
      expect(out).toEqual({ apps: 2, done: 1, blocked: 1, failed: 0, mode: 'c4' });
      expect(transport.stopApplication).toHaveBeenCalledTimes(1);
      expect(c4.beginDispatchStandalone).toHaveBeenCalledTimes(1);
      expect(c4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-1', outcome: 'SUCCESS' }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'suspension.app_stop_blocked',
          resourceId: 'dep-2',
          details: expect.objectContaining({ reason: 'protocole_off' }),
        }),
      );
    });
  });
});
