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
 *  - C4 (flag relu à l'appel) : `beginDispatchStandalone(CONFIGURE)` avant le
 *    dispatch (refus → blocage, transport JAMAIS appelé), `settleStandalone`
 *    après (SUCCESS / PERMANENT_FAILURE capacité / FAILED_RETRYABLE réseau) ;
 *  - aucun réseau dans le scan : seuls les déploiements à `coolifyUuid` non
 *    null et rattachés au SEUL abonnement demandé sont considérés.
 */
describe('SuspensionEffectsService (Q5)', () => {
  let svc: SuspensionEffectsService;
  let prisma: { hostingService: { findMany: jest.Mock }; deployment: { findMany: jest.Mock } };
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
    delete process.env.HOSTING_C4_ENABLED; // OFF par défaut (fail-closed)
    prisma = {
      hostingService: { findMany: jest.fn(async () => [{ id: 'hs-1', orderId: 'ord-1' }]) },
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
    expect(out).toEqual({ apps: 0, done: 0, blocked: 0, failed: 0 });
    expect(factory.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('arrêt confirm\u00e9 \u2192 done + audit apps_stopped ; JAMAIS deleteApplication', async () => {
    const out = await svc.suspendApps(params);
    expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0 });
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
        details: expect.objectContaining({ apps: 1, done: 1, c4: false }),
      }),
    );
  });

  it('réactivation \u2192 startApplication + audit apps_started (aucune \u00e9criture facture)', async () => {
    const out = await svc.resumeApps(params);
    expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0 });
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
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0 });
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
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0 });
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
    expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0 });
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
    expect(out).toEqual({ apps: 1, done: 0, blocked: 0, failed: 1 });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'suspension.app_stop_failed',
        details: expect.objectContaining({ kind: 'failed', detail: 'ECONNREFUSED' }),
      }),
    );
  });

  describe('C4 (flag relu \u00e0 l\u2019appel)', () => {
    beforeEach(() => {
      process.env.HOSTING_C4_ENABLED = 'true';
    });

    it('dispatch r\u00e9ussi \u2192 begin CONFIGURE puis settle SUCCESS', async () => {
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 1, blocked: 0, failed: 0 });
      expect(c4.beginDispatchStandalone).toHaveBeenCalledWith({
        nature: 'CONFIGURE',
        scope: { type: 'DEPLOYMENT', id: 'dep-1' },
        holder: 'system:renewal-sweep',
        orderId: 'ord-1',
        targetIntent: { type: 'application', op: 'stop', uuid: 'uuid-1' },
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
          details: expect.objectContaining({ c4: true }),
        }),
      );
    });

    it('refus C4 (Conflit) \u2192 bloqu\u00e9 c4_refuse, transport JAMAIS appel\u00e9', async () => {
      c4.beginDispatchStandalone.mockRejectedValue(new ConflictException('Arrêt opposable.'));
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0 });
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
      expect(out).toEqual({ apps: 1, done: 0, blocked: 1, failed: 0 });
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-1', outcome: 'PERMANENT_FAILURE' }),
      );
    });

    it('\u00e9chec r\u00e9seau sous C4 \u2192 settle FAILED_RETRYABLE + failed visible', async () => {
      transport.stopApplication.mockRejectedValue(new Error('ETIMEDOUT'));
      const out = await svc.suspendApps(params);
      expect(out).toEqual({ apps: 1, done: 0, blocked: 0, failed: 1 });
      expect(c4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-1', outcome: 'FAILED_RETRYABLE' }),
      );
    });

    it('r\u00e9activation sous C4 \u2192 begin CONFIGURE op=start puis settle SUCCESS', async () => {
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
});
