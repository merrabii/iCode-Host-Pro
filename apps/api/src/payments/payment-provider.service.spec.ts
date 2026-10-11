import { ConflictException } from '@nestjs/common';
import { PaymentProviderSetting } from '@prisma/client';
import { PaymentProviderService } from './payment-provider.service';
import { StripeConnector } from './stripe-connector';

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
      updateMany: jest.Mock;
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
        // Lecture CLONÉE (photographie, comme une vraie ligne) : une édition
        // concurrente pendant un appel réseau ne doit pas muter le snapshot.
        findUnique: jest.fn(async (args: { where: { code?: string; id?: string } }) => {
          const hit = args.where.code
            ? rows.get(args.where.code)
            : [...rows.values()].find((r) => r.id === args.where.id);
          if (!hit) return null;
          return { ...hit } as PaymentProviderSetting;
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
        // CAS (§2/§3) : id [+ updatedAt + merchantAccount] sur la LIGNE, à
        // valeur égale (les Date sont comparées par valeur, pas par référence).
        updateMany: jest.fn(async (args: {
          where: { id?: string; updatedAt?: Date; merchantAccount?: unknown };
          data: Row;
        }) => {
          const hit = [...rows.values()].find((r) => r.id === args.where.id);
          if (!hit) return { count: 0 };
          if (args.where.updatedAt !== undefined) {
            const same =
              hit.updatedAt instanceof Date && args.where.updatedAt instanceof Date
                ? hit.updatedAt.getTime() === args.where.updatedAt.getTime()
                : hit.updatedAt === args.where.updatedAt;
            if (!same) return { count: 0 };
          }
          if ('merchantAccount' in args.where && hit.merchantAccount !== args.where.merchantAccount) {
            return { count: 0 };
          }
          Object.assign(hit, args.data);
          rows.set(hit.code, hit);
          return { count: 1 };
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

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('resolve : compte déclaré mais JAMAIS vérifié → refus (§3 : la déclaration seule ne suffit plus)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: null }));
    await expect(service.resolve()).rejects.toThrow('Identité marchande non vérifiée');
    await expect(service.resolve()).rejects.toThrow(ConflictException);
  });

  it('resolve : seule la vérification ouvre les opérations (requireMerchantAccount:false reste possible)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: null }));
    const res = await service.resolve({ requireMerchantAccount: false });
    expect(res.code).toBe('stripe');
  });

  it('resolve : identité servie = compte VÉRIFIÉ (primauté sur la déclaration)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_old', lastCheckAccount: 'acct_verified' }));
    // mismatch → refus ; avec le même compte des deux côtés, vérifié prime.
    rows.set('stripe', setting({ merchantAccount: null, lastCheckAccount: 'acct_verified' }));
    const res = await service.resolve();
    expect(res.merchantAccount).toBe('acct_verified');
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

  it('resolveFor : configuration déclaré ≠ vérifié → opération GELÉE (§3)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: 'acct_verifie' }));
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_verifie' }),
    ).rejects.toThrow('reprise gelée');
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

  it('currentIdentity : primauté du compte VÉRIFIÉ sur la déclaration', async () => {
    rows.set('stripe', setting({ merchantAccount: null, lastCheckAccount: 'acct_verified' }));
    await expect(service.currentIdentity('stripe')).resolves.toBe('acct_verified');
  });

  it('currentIdentity : déclaré ≠ vérifié → événement NON acquittable (§3)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: 'acct_verifie' }));
    await expect(service.currentIdentity('stripe')).rejects.toThrow('non acquittable');
  });

  it('currentIdentity : déclaré mais JAMAIS vérifié → événement NON acquittable (§2, aucun repli)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: null }));
    await expect(service.currentIdentity('stripe')).rejects.toThrow('non vérifiée');
    await expect(service.currentIdentity('stripe')).rejects.toThrow(ConflictException);
  });

  // ── GO §2 — reprise d'opération : identité VÉRIFIÉE seule ────────────────

  it('resolveFor : compte déclaré mais JAMAIS vérifié → reprise GELÉE (§2, aucun repli)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: null }));
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_declare' }),
    ).rejects.toThrow('reprise gelée');
    await expect(
      service.resolveFor({ providerCode: 'stripe', merchantAccount: 'acct_declare' }),
    ).rejects.toThrow(ConflictException);
  });

  // ── GO §2 — contrôle de connexion : CAS sur la version AVANT réseau ─────

  it('checkConnection : contrôle vert → identité VÉRIFIÉE écrite par CAS (jamais déclarative)', async () => {
    const spy = jest
      .spyOn(StripeConnector.prototype, 'verifyAccount')
      .mockResolvedValue({ accountId: 'acct_reel', livemode: false });
    const res = await service.checkConnection({ sub: 'u1', email: 'u1@example.test' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rows.get('stripe')!.lastCheckAccount).toBe('acct_reel');
    // Écart déclaré/vérifié RENDU VISIBLE (jamais d'écrasement silencieux).
    expect(res.lastCheckError).toContain('≠ compte vérifié (acct_reel)');
  });

  it('checkConnection : édition PENDANT l’appel réseau → preuve REFUSÉE (CAS sur snapshot)', async () => {
    jest.spyOn(StripeConnector.prototype, 'verifyAccount').mockImplementation(async () => {
      // Édition concurrente pendant le réseau : la ligne change AVANT le CAS.
      const row = rows.get('stripe')!;
      row.updatedAt = new Date(Date.now() + 60_000);
      row.merchantAccount = 'acct_edite';
      return { accountId: 'acct_reel', livemode: false };
    });
    await expect(
      service.checkConnection({ sub: 'u1', email: 'u1@example.test' }),
    ).rejects.toThrow('Configuration modifiée pendant le contrôle de connexion');
    // Aucun attribut de contrôle n'a été écrit sur la version éditée.
    expect(rows.get('stripe')!.lastCheckAccount).toBe('acct_ok');
  });

  it('checkConnection : échec réseau → échec écrit en CAS sur la version AVANT réseau', async () => {
    jest
      .spyOn(StripeConnector.prototype, 'verifyAccount')
      .mockRejectedValue(new Error('réseau indisponible'));
    const res = await service.checkConnection({ sub: 'u1', email: 'u1@example.test' });
    expect(res.lastCheckError).toContain('réseau indisponible');
    expect(rows.get('stripe')!.lastCheckAccount).toBe('acct_ok');
  });

  it('V3 §2 : le connecteur et le CAS partagent EXACTEMENT le snapshot lu AVANT le réseau', async () => {
    const snapshotUpdatedAt = rows.get('stripe')!.updatedAt;
    const reads: unknown[] = [];
    const baseFindUnique = prisma.paymentProviderSetting.findUnique.getMockImplementation()!;
    prisma.paymentProviderSetting.findUnique.mockImplementation(async (args: never) => {
      const row = await baseFindUnique(args);
      reads.push(row);
      return row;
    });
    jest.spyOn(StripeConnector.prototype, 'verifyAccount').mockImplementation(async () => {
      // Édition concurrente pendant le réseau : la LIGNE change, pas le snapshot.
      const row = rows.get('stripe')!;
      row.updatedAt = new Date(Date.now() + 60_000);
      row.merchantAccount = 'acct_edite';
      return { accountId: 'acct_reel', livemode: false };
    });
    await expect(
      service.checkConnection({ sub: 'u1', email: 'u1@example.test' }),
    ).rejects.toThrow('Configuration modifiée pendant le contrôle de connexion');
    // UNE SEULE lecture de configuration (le snapshot) avant le réseau.
    expect(reads).toHaveLength(1);
    // Le CAS soumettait la version OBSERVÉE (avant édition), pas la ligne vivante.
    expect(prisma.paymentProviderSetting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: snapshotUpdatedAt }),
      }),
    );
    expect(rows.get('stripe')!.lastCheckAccount).toBe('acct_ok');
  });

  // ── GO V3 §3 — contexte webhook unifié (secret + identité, 1 lecture) ────

  it('V3 §3 : webhookAuthContext sert secret + identité D’UN MÊME snapshot (1 lecture)', async () => {
    const ctx = await service.webhookAuthContext('stripe');
    expect(ctx.secret).toBe('whsec_1');
    expect(ctx.identity).toEqual({
      settingId: 'set1',
      configVersion: rows.get('stripe')!.updatedAt,
      merchantAccount: 'acct_ok',
    });
    expect(ctx.identityError).toBeNull();
    expect(prisma.paymentProviderSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('V3 §3 : secret présent mais identité non vérifiée → identity null + motif (aucun repli)', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: null }));
    const ctx = await service.webhookAuthContext('stripe');
    expect(ctx.secret).toBe('whsec_1');
    expect(ctx.identity).toBeNull();
    expect(ctx.identityError).toContain('non vérifiée');
  });

  it('V3 §3 : déclaré ≠ vérifié → identity null + incohérence explicite', async () => {
    rows.set('stripe', setting({ merchantAccount: 'acct_declare', lastCheckAccount: 'acct_verifie' }));
    const ctx = await service.webhookAuthContext('stripe');
    expect(ctx.identity).toBeNull();
    expect(ctx.identityError).toContain('incohérente');
  });

  it('V3 §3 : secret absent → refus net (jamais de signature sans secret)', async () => {
    rows.set('stripe', setting({ webhookSecretEnc: null }));
    await expect(service.webhookAuthContext('stripe')).rejects.toThrow(ConflictException);
  });

  // ── GO §4.3 — sweep DURABLE par défaut, désactivation UNIQUEMENT explicite ─

  it('reconcileIntervalMs : 60 s par défaut (durable), 0 = désactivation explicite, env si valide', () => {
    expect(service.reconcileIntervalMs()).toBe(60_000);
    config.get.mockReturnValue('0');
    expect(service.reconcileIntervalMs()).toBe(0);
    config.get.mockReturnValue('30000');
    expect(service.reconcileIntervalMs()).toBe(30_000);
    config.get.mockReturnValue('-5');
    expect(service.reconcileIntervalMs()).toBe(60_000);
    config.get.mockReturnValue('absent');
    expect(service.reconcileIntervalMs()).toBe(60_000);
    config.get.mockReturnValue(undefined);
    expect(service.reconcileIntervalMs()).toBe(60_000);
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
