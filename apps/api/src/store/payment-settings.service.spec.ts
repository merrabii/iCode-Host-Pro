import { ConflictException } from '@nestjs/common';
import { PaymentMethodType } from '@prisma/client';
import { JwtPayload } from '../auth/types';
import { PaymentSettingsService } from './payment-settings.service';

// Lot « paiement direct des commandes » — les interrupteurs des PARCOURS de
// paiement (règlement par solde / règlement de commande par carte / recharge
// par carte) vivent EN BASE et ne sont jamais éditables via env.
// Preuves : lecture/création du singleton, GATE serveur (409
// `PAYMENT_METHOD_DISABLED` + capability), indépendance des trois parcours,
// audit ancienne/nouvelle valeur, et état ADMIN d'un moyen carte (jamais de
// secret).
describe('PaymentSettingsService (réglages des parcours de paiement)', () => {
  const actor: JwtPayload = {
    sub: 'admin-1',
    email: 'admin-recette@icode.test',
    role: 'ADMIN' as JwtPayload['role'],
  };

  function makeService(
    row?: Partial<Record<string, unknown>> | null,
    providers?: Record<string, unknown>[],
    cardMethod?: { isActive: boolean } | null,
  ) {
    const base = {
      id: 'singleton',
      walletPaymentEnabled: true,
      cardOrderPaymentEnabled: false,
      cardTopupEnabled: true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    };
    const prisma = {
      paymentSettings: {
        findUnique: jest.fn(async () =>
          row === undefined ? base : (row as never),
        ),
        create: jest.fn(async () => base),
        update: jest.fn(async ({ data }: { data: Record<string, boolean> }) => ({
          ...base,
          ...data,
        })),
      },
      paymentProviderSetting: {
        // GO revue §5b — lecture par CODE (même accès que resolve()).
        findUnique: jest.fn(
          async ({ where }: { where: { code: string } }) =>
            ((providers ?? []).find((r) => (r as { code?: string }).code ===
              where.code) ?? null) as never,
        ),
        findMany: jest.fn(async () => (providers ?? []) as never[]),
      },
      // §5b — ligne CARTE (null = aucune ligne, donc active par défaut).
      paymentMethod: {
        findFirst: jest.fn(async () => cardMethod ?? null),
      },
      // GO §5.1 — le PATCH et son audit partagent LA MÊME transaction.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    const audit = { record: jest.fn() };
    const service = new PaymentSettingsService(prisma as never, audit as never);
    return { service, prisma, audit, base };
  }

  afterEach(() => {
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
  });

  // ── singleton ──────────────────────────────────────────────────────────
  it('capabilities() lit le singleton SANS le réinitialiser (aucun reset silencieux)', async () => {
    const { service, prisma, audit } = makeService();
    const caps = await service.capabilities();
    expect(caps).toEqual({
      walletPaymentEnabled: true,
      cardOrderPaymentEnabled: false,
      cardTopupEnabled: true,
    });
    expect(prisma.paymentSettings.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' },
    });
    expect(prisma.paymentSettings.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('capabilities() crée le singleton aux DÉFAUTS de migration s\'il manque', async () => {
    const { service, prisma } = makeService(null);
    const caps = await service.capabilities();
    expect(prisma.paymentSettings.create).toHaveBeenCalledWith({
      data: { id: 'singleton' },
    });
    // défauts : solde activé, règlement de commande par carte ÉTEINT, recharge activée
    expect(caps.walletPaymentEnabled).toBe(true);
    expect(caps.cardOrderPaymentEnabled).toBe(false);
    expect(caps.cardTopupEnabled).toBe(true);
  });

  // ── gate serveur ───────────────────────────────────────────────────────
  it('assertEnabled refuse 409 PAYMENT_METHOD_DISABLED avec la capability exacte', async () => {
    const { service } = makeService();
    const err = await service.assertEnabled('cardOrder').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'PAYMENT_METHOD_DISABLED',
      capability: 'cardOrder',
    });
    expect(String((err as ConflictException).message)).toContain('aucun débit');
  });

  it('assertEnabled laisse passer un parcours activé', async () => {
    const { service } = makeService(); // wallet activé par défaut
    await expect(service.assertEnabled('wallet')).resolves.toBeUndefined();
  });

  it('les TROIS parcours sont indépendants (couper la recharge ne coupe pas le règlement carte)', async () => {
    const { service } = makeService();
    await expect(service.assertEnabled('wallet')).resolves.toBeUndefined();
    await expect(service.assertEnabled('cardOrder')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.assertEnabled('cardTopup')).resolves.toBeUndefined();

    // position inverse : recharge coupée, règlement carte ouvert
    const { service: alt } = makeService({
      id: 'singleton',
      walletPaymentEnabled: false,
      cardOrderPaymentEnabled: true,
      cardTopupEnabled: false,
    });
    await expect(alt.assertEnabled('cardOrder')).resolves.toBeUndefined();
    await expect(alt.assertEnabled('cardTopup')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(alt.assertEnabled('wallet')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // ── mise à jour admin ──────────────────────────────────────────────────
  it('update() écrit le champ, renvoie l\'état frais et AUDITE from → to', async () => {
    const { service, prisma, audit } = makeService();
    const caps = await service.update({ cardOrderPaymentEnabled: true }, actor);

    expect(prisma.paymentSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { cardOrderPaymentEnabled: true },
    });
    expect(caps.cardOrderPaymentEnabled).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.settings.update',
        resourceType: 'paymentSettings',
        resourceId: 'singleton',
        details: {
          changes: [
            {
              field: 'cardOrderPaymentEnabled',
              from: false,
              to: true,
            },
          ],
        },
      }),
      // L'audit partage LA transaction du PATCH (GO §5.1 — atomique).
      expect.objectContaining({ paymentSettings: prisma.paymentSettings }),
    );
  });

  it('update() sans changement réel : AUCUNE écriture, AUCUN audit', async () => {
    const { service, prisma, audit } = makeService();
    await service.update({ cardOrderPaymentEnabled: false, walletPaymentEnabled: true }, actor);
    expect(prisma.paymentSettings.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('update() ignore une valeur non booléenne (dto trafiqué) au lieu d\'écrire n\'importe quoi', async () => {
    const { service, prisma, audit } = makeService();
    await service.update(
      { cardOrderPaymentEnabled: 'yes' } as unknown as { cardOrderPaymentEnabled?: boolean },
      actor,
    );
    expect(prisma.paymentSettings.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  // ── état ADMIN d'un moyen carte (aucun secret) ─────────────────────────
  const cardMethod = {
    type: PaymentMethodType.CARD,
    isActive: true,
    config: {},
    configEnc: null,
  };

  it('methodState CARD : moyen INACTIF → « désactivé » (aucun appel prestataire)', async () => {
    const { service, prisma } = makeService();
    const view = await service.methodState({ ...cardMethod, isActive: false });
    expect(view.state).toBe('disabled');
    expect(view.stateReason).toContain('Désactivé');
    expect(prisma.paymentProviderSetting.findMany).not.toHaveBeenCalled();
  });

  it('methodState CARD : les DEUX parcours carte éteints → « désactivé »', async () => {
    const { service } = makeService({
      id: 'singleton',
      walletPaymentEnabled: true,
      cardOrderPaymentEnabled: false,
      cardTopupEnabled: false,
    });
    const view = await service.methodState(cardMethod);
    expect(view.state).toBe('disabled');
    expect(view.stateReason).toContain('parcours carte');
  });

  it('methodState CARD : simulateur de recette activé → « opérationnel » (jamais de secret)', async () => {
    const { service } = makeService({
      id: 'singleton',
      walletPaymentEnabled: true,
      cardOrderPaymentEnabled: true,
      cardTopupEnabled: true,
    });
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    const view = await service.methodState(cardMethod);
    expect(view.state).toBe('operational');
    expect(view.stateReason).toContain('simulateur');
    expect(JSON.stringify(view)).not.toMatch(/whsec|sk_test|secret/i);
  });

  it('methodState carte (hors carte) : sans coordonnées d\'affichage → « incomplet »', async () => {
    const { service } = makeService();
    const view = await service.methodState({
      type: PaymentMethodType.BANK_TRANSFER,
      isActive: true,
      config: {},
      configEnc: null,
    });
    expect(view.state).toBe('incomplete');
    expect(view.stateReason).toContain('Configuration incomplète');
  });

  // ── disponibilité technique du traitement carte (GO §5 sans simulateur
  //    + GO §3 identité VÉRIFIÉE + GO revue §5b ALIGNÉE sur resolve()) ───
  const stripeRow = (over: Record<string, unknown> = {}) => ({
    code: 'stripe',
    isActive: true,
    environment: 'test',
    liveEnabled: false,
    // §5b — déclaré = vérifié (sinon incohérence, refusée par resolve()).
    merchantAccount: 'acct_verifie',
    lastCheckAccount: 'acct_verifie',
    secretKeyEnc: 'enc:sk_test_x',
    allowedCurrencies: ['USD', 'EUR'],
    ...over,
  });

  it('cardProviderStatus : simulateur activé SANS Stripe actif → « simulator » (repli de resolve())', async () => {
    const { service, prisma } = makeService(undefined, []);
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    await expect(service.cardProviderStatus()).resolves.toEqual({ kind: 'simulator' });
    // §5b — une lecture par code reste faite (Stripe d'abord, comme resolve()).
    expect(prisma.paymentProviderSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'stripe' } }),
    );
  });

  it('cardProviderStatus : Stripe test configuré ET identité vérifiée → « configured » (SANS simulateur, GO §5)', async () => {
    const { service } = makeService(undefined, [stripeRow()]);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    await expect(service.cardProviderStatus()).resolves.toEqual({
      kind: 'configured',
      currencies: ['USD', 'EUR'],
    });
  });

  it('cardProviderStatus : compte marchand DÉclaré mais JAMAIS vérifié → « unavailable » (GO §3)', async () => {
    const { service } = makeService(undefined, [
      stripeRow({ lastCheckAccount: null }),
    ]);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const status = await service.cardProviderStatus();
    expect(status.kind).toBe('unavailable');
    expect(String((status as { reason: string }).reason)).toContain(
      'identité marchande non vérifiée',
    );
  });

  it('§5b : identité déclarée ≠ vérifiée → « unavailable » (MÊME refus que resolve(), jamais « configured »)', async () => {
    const { service } = makeService(undefined, [
      stripeRow({ merchantAccount: 'acct_A', lastCheckAccount: 'acct_B' }),
    ]);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const status = await service.cardProviderStatus();
    expect(status.kind).toBe('unavailable');
    expect(String((status as { reason: string }).reason)).toContain(
      'identité marchande incohérente',
    );
  });

  it('§5b : Stripe ACTIF mais inutilisable + simulateur activé → « unavailable » (AUCUN repli, comme resolve())', async () => {
    const { service } = makeService(undefined, [
      stripeRow({ secretKeyEnc: null }),
    ]);
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    const status = await service.cardProviderStatus();
    expect(status.kind).toBe('unavailable');
    expect(String((status as { reason: string }).reason)).toContain('clé secrète');
  });

  it('cardProviderStatus : aucun prestataire actif → « unavailable » (aucun repli automatique)', async () => {
    const { service } = makeService(undefined, []);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const status = await service.cardProviderStatus();
    expect(status.kind).toBe('unavailable');
  });

  // ── capacités EFFECTIVES (GO revue §5b) ────────────────────────────────
  it('effectiveCapabilities : interrupteurs BRUTS + carte opérationnelle (Stripe vérifié)', async () => {
    const { service } = makeService(undefined, [stripeRow()]);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    await expect(service.effectiveCapabilities()).resolves.toEqual({
      walletPaymentEnabled: true,
      cardOrderPaymentEnabled: false,
      cardTopupEnabled: true,
      cardAvailable: true,
      cardCurrencies: ['USD', 'EUR'],
      cardUnavailableReason: null,
    });
  });

  it('effectiveCapabilities : ligne CARTE désactivée → carte indisponible (même connecteur vert)', async () => {
    const { service } = makeService(undefined, [stripeRow()], { isActive: false });
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const caps = await service.effectiveCapabilities();
    expect(caps.cardAvailable).toBe(false);
    expect(caps.cardCurrencies).toEqual([]);
    expect(caps.cardUnavailableReason).toContain('désactivé');
    // interrupteurs intacts (BRUTS, jamais masqués)
    expect(caps.cardOrderPaymentEnabled).toBe(false);
    expect(caps.cardTopupEnabled).toBe(true);
    expect(caps.walletPaymentEnabled).toBe(true);
  });

  it('effectiveCapabilities : simulateur → devises de la ligne simulated (défaut grille sinon)', async () => {
    const { service } = makeService(undefined, []);
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    const caps = await service.effectiveCapabilities();
    expect(caps.cardAvailable).toBe(true);
    expect(caps.cardCurrencies).toEqual(['USD', 'EUR']);
    expect(caps.cardUnavailableReason).toBeNull();
  });

  it('effectiveCapabilities : Stripe incohérent → cardAvailable=false + raison honnête (sans secret)', async () => {
    const { service } = makeService(undefined, [
      stripeRow({ merchantAccount: 'acct_A', lastCheckAccount: 'acct_B' }),
    ]);
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const caps = await service.effectiveCapabilities();
    expect(caps.cardAvailable).toBe(false);
    expect(caps.cardCurrencies).toEqual([]);
    expect(caps.cardUnavailableReason).toContain('identité marchande incohérente');
    expect(JSON.stringify(caps)).not.toMatch(/enc:|sk_test|whsec/i);
  });

  it('methodState CARD : Stripe vérifié sans simulateur → « opérationnel » (parcours actif)', async () => {
    const { service } = makeService(
      {
        id: 'singleton',
        walletPaymentEnabled: true,
        cardOrderPaymentEnabled: true,
        cardTopupEnabled: true,
      },
      [stripeRow()],
    );
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const view = await service.methodState(cardMethod);
    expect(view.state).toBe('operational');
    expect(view.stateReason).toContain('prestataire configuré');
    expect(JSON.stringify(view)).not.toMatch(/whsec|sk_test|enc:/);
  });

  it('methodState CARD : Stripe non vérifié sans simulateur → « incomplet » (jamais « opérationnel »)', async () => {
    const { service } = makeService(
      {
        id: 'singleton',
        walletPaymentEnabled: true,
        cardOrderPaymentEnabled: true,
        cardTopupEnabled: true,
      },
      [stripeRow({ lastCheckAccount: null })],
    );
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    const view = await service.methodState(cardMethod);
    expect(view.state).toBe('incomplete');
    expect(view.stateReason).toContain('identité marchande non vérifiée');
  });
});
