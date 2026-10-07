import { ConflictException } from '@nestjs/common';
import { PaymentProviderSetting } from '@prisma/client';
import { PaymentProviderService } from './payment-provider.service';

// GO Stripe P1/P4/P3 — résolution du prestataire : JAMAIS de repli silencieux,
// jamais de configuration live, identité marchande exigée, activation du
// simulateur explicite et désactivable. Aucun appel réseau dans ces tests.

type Row = Record<string, unknown>;

const setting = (over: Row = {}): PaymentProviderSetting =>
  ({
    id: 'set1',
    code: 'stripe',
    displayName: 'Stripe (test)',
    isActive: true,
    environment: 'test',
    liveEnabled: false,
    secretKeyEnc: 'enc:sk_test_1',
    webhookSecretEnc: 'enc:whsec_1',
    merchantAccount: 'acct_ok',
    lastCheckAccount: 'acct_ok',
    publishableKey: 'pk_test_1',
    allowedCurrencies: ['USD', 'EUR'],
    webhookEndpointUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as PaymentProviderSetting;

describe('PaymentProviderService (GO P1/P4/P3 — pas de repli, mode test)', () => {
  let rows: Map<string, PaymentProviderSetting>;
  let prisma: {
    paymentProviderSetting: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };
  let config: { get: jest.Mock };
  let service: PaymentProviderService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    rows = new Map([['stripe', setting()]]);
    prisma = {
      paymentProviderSetting: {
        findUnique: jest.fn(async (args: { where: { code: string } }) => {
          const hit = rows.get(args.where.code);
          if (!hit) return null;
          // Clé de lecture par `code` ET par `id` (création du simulateur).
          return hit;
        }),
        create: jest.fn(async (args: { data: Row }) => {
          const row = setting({ ...(args.data as Row), id: 'sim1' });
          rows.set(String(args.data.code), row);
          return row;
        }),
        update: jest.fn(async (args: { where: { id: string }; data: Row }) => {
          const current = [...rows.values()].find((r) => r.id === args.where.id) ?? setting();
          const merged = { ...current, ...args.data } as PaymentProviderSetting;
          rows.set(merged.code, merged);
          return merged;
        }),
      },
    };
    crypto = {
      encrypt: jest.fn((v: string) => `enc:${v}`),
      decrypt: jest.fn((v: string) => String(v).replace(/^enc:/, '')),
    };
    config = { get: jest.fn(() => undefined) };
    service = new PaymentProviderService(prisma as never, crypto as never, config as never);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  // ── GO P1 — aucun fournisseur = refus net, jamais un faux bouton ────────

  it('resolve : sans Stripe actif ET simulateur désactivé → refus net (aucun repli)', async () => {
    rows.clear();
    await expect(service.resolve()).rejects.toThrow(ConflictException);
    await expect(service.resolve()).rejects.toThrow('Aucun prestataire de paiement configuré');
  });

  it('resolve : configuration LIVE refusée (mode test uniquement)', async () => {
    rows.set('stripe', setting({ environment: 'live' }));
    await expect(service.resolve()).rejects.toThrow('Configuration live refusée');
  });

  it('resolve : identité déclarée ≠ identité vérifiée → refus (compte incohérent)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: 'acct_verifie' }));
    await expect(service.resolve()).rejects.toThrow('identité marchande incohérente');
  });

  it('resolve : simulateur activé → simulateur local, jamais de clé réelle', async () => {
    rows.clear();
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    const res = await service.resolve();
    expect(res.code).toBe('simulated');
    expect(res.environment).toBe('test');
    expect(res.merchantAccount).toBe('sim_merchant_local');
  });

  // ── GO P4 — résolution par identité d'origine : zéro substitution ───────

  it('resolveFor : fournisseur inconnu → refus, JAMAIS de bascule simulateur', async () => {
    rows.clear();
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    await expect(
      service.resolveFor({ providerCode: 'paypal', merchantAccount: 'acct_ok' }),
    ).rejects.toThrow('aucune reprise');
  });

  it('resolveFor : opération LIVE → refus net', async () => {
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_ok', environment: 'live' }),
    ).rejects.toThrow('mode test uniquement');
  });

  it('resolveFor : fournisseur d’origine retiré de la configuration → aucune reprise', async () => {
    rows.clear();
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_ok' }),
    ).rejects.toThrow('aucune reprise');
  });

  it('resolveFor : compte marchand MODIFIÉ pendant l’opération → reprise refusée', async () => {
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_ancien' }),
    ).rejects.toThrow('reprise refusée');
  });

  it('resolveFor : même compte (rotation de clés) → reprise acceptée', async () => {
    const res = await service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_ok' });
    expect(res.code).toBe('stripe');
    expect(res.merchantAccount).toBe('acct_ok');
    expect(res.environment).toBe('test');
  });

  // ── GO P1 — identité marchande courante (signature webhook) ─────────────

  it('currentIdentity : fournisseur non configuré → identité absente (503 chez l’appelant)', async () => {
    rows.clear();
    await expect(service.currentIdentity('stripe')).rejects.toThrow('identité absente');
  });

  it('currentIdentity : fournisseur sans identité établie → refus (aucun repli)', async () => {
    rows.set('stripe', setting({ merchantAccount: null, lastCheckAccount: null }));
    await expect(service.currentIdentity('stripe')).rejects.toThrow('Identité marchande non établie');
  });

  it('currentIdentity : identité déclarée servie telle quelle', async () => {
    await expect(service.currentIdentity('stripe')).resolves.toBe('acct_ok');
  });

  // ── GO P3 — période du sweep : activée UNIQUEMENT par env explicite ─────

  it('reconcileIntervalMs : 0 par défaut (sweep désactivé), valeur env si > 0', () => {
    expect(service.reconcileIntervalMs()).toBe(0);
    config.get.mockReturnValue('60000');
    expect(service.reconcileIntervalMs()).toBe(60000);
    config.get.mockReturnValue('-5');
    expect(service.reconcileIntervalMs()).toBe(0);
    config.get.mockReturnValue('absent');
    expect(service.reconcileIntervalMs()).toBe(0);
  });

  // ── GO P1 — le simulateur est interdit en production (toute porte) ──────

  it('assertSimulatorUsable : production → refus AVANT toute écriture de configuration', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    rows.clear(); // aucun Stripe : le seul relais possible serait le simulateur
    expect(() => service.assertSimulatorUsable()).toThrow('interdit en production');
    await expect(service.resolve()).rejects.toThrow('Aucun prestataire');
    await expect(service.webhookSecretFor('simulated')).rejects.toThrow('interdit en production');
    await expect(service.currentIdentity('simulated')).rejects.toThrow('interdit en production');
    expect(prisma.paymentProviderSetting.create).not.toHaveBeenCalled();
  });

  it('assertSimulatorUsable : env désactivé → refus net (aucune ligne créée)', async () => {
    expect(() => service.assertSimulatorUsable()).toThrow('désactivé');
    expect(prisma.paymentProviderSetting.create).not.toHaveBeenCalled();
  });
});
