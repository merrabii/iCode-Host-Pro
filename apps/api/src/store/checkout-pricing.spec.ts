import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';

// GO P5 (décision §6-2a) — B2 : prix ACTIF (promo facturée) + arrondi de taxe
// PAR LIGNE. `activeBasePrice` (statique privé) et `buildPricing` (privé) sont
// des fonctions pures sur le produit + le DTO de configuration : aucun réseau,
// aucun Prisma réel — mocks vides comme dans checkout.service.spec.ts.
type Pricing = {
  lines: {
    kind: string;
    label: string;
    unitPriceHtCents: number;
    taxRatePercent: number;
    taxAmountCents: number;
    totalTtcCents: number;
  }[];
  amountHtCents: number;
  taxAmountCents: number;
  amountTtcCents: number;
  taxRatePercent: number;
};

type Svc = {
  buildPricing: (
    product: unknown,
    dto: { options?: { optionId: string; choiceId: string }[]; addonIds?: string[] },
    method?: {
      name: string;
      feeType: string;
      feePercent: number | null;
      feeFixedCents: number | null;
    } | null,
  ) => Pricing;
};

/** Règle promo — accès au statique privé (miroir des tests : même méthode). */
const activeBase = (p: {
  priceHtCents?: number | null;
  promoPriceHtCents?: number | null;
}): number =>
  (
    CheckoutService as unknown as {
      activeBasePrice: (q: typeof p) => number;
    }
  ).activeBasePrice(p);

describe('P5 — règle promo active (§6-2a, activeBasePrice)', () => {
  it('promo STRICTEMENT inférieure au catalogue → prix promo facturé', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: 3900 })).toBe(3900);
  });

  it('promo ÉGALE au catalogue → ignorée (catalogue facturé)', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: 4900 })).toBe(4900);
  });

  it('promo SUPÉRIEURE au catalogue → ignorée (jamais de prix facturé supérieur)', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: 5900 })).toBe(4900);
  });

  it('promo à 0 → gratuit facturé (0 est une promo valide)', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: 0 })).toBe(0);
  });

  it('sans promo (null) → prix catalogue', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: null })).toBe(4900);
  });

  it('promo absente (undefined) → prix catalogue', () => {
    expect(activeBase({ priceHtCents: 4900 })).toBe(4900);
  });

  it('catalogue absent (null) → 0', () => {
    expect(activeBase({ priceHtCents: null, promoPriceHtCents: null })).toBe(0);
  });

  it('promo négative → ignorée (catalogue facturé)', () => {
    expect(activeBase({ priceHtCents: 4900, promoPriceHtCents: -100 })).toBe(4900);
  });

  it('promo active inférieure mais catalogue absent (null) → 0 (cohérent affichage/facturation)', () => {
    expect(activeBase({ priceHtCents: null, promoPriceHtCents: 100 })).toBe(0);
  });
});

describe('P5 — buildPricing : prix actif + taxe ARRONDIE PAR LIGNE (B2)', () => {
  const mockPrisma = {};
  const mockAudit = {};
  const mockLimiter = {};
  const mockMail = {};
  const mockProvisioning = {};
  const mockCloudflare = {};

  let svc: Svc;
  let findPublicBySlug: jest.Mock;

  beforeEach(() => {
    findPublicBySlug = jest.fn();
    const service = new CheckoutService(
      mockPrisma as never,
      { findPublicBySlug } as never,
      mockAudit as never,
      mockLimiter as never,
      mockMail as never,
      mockProvisioning as never,
      mockCloudflare as never,
      { resolveTracking: jest.fn(), operational: jest.fn().mockResolvedValue(false) } as never,
      { applyWithClient: jest.fn() } as never,
    );
    svc = service as unknown as Svc;
  });

  const mkProduct = (over: Record<string, unknown> = {}) =>
    ({
      id: 'p1',
      name: 'Offre test',
      slug: 'offre-test',
      priceHtCents: 4900,
      promoPriceHtCents: null,
      installationFeeCents: 0,
      taxRate: { ratePercent: 20 },
      options: [],
      addons: [],
      ...over,
    }) as unknown;

  it('ligne produit = prix ACTIF promo (miroir du prix affiché boutique)', () => {
    const p = mkProduct({ priceHtCents: 4900, promoPriceHtCents: 3900 });
    const out = svc.buildPricing(p, {});
    expect(out.lines[0].unitPriceHtCents).toBe(3900);
    expect(out.amountHtCents).toBe(3900);
  });

  it('promo ≥ catalogue → ligne produit = catalogue (jamais supérieur)', () => {
    const p = mkProduct({ priceHtCents: 4900, promoPriceHtCents: 5900 });
    expect(svc.buildPricing(p, {}).lines[0].unitPriceHtCents).toBe(4900);
  });

  it('totaux = somme stricte des lignes (HT, taxe et TTC cohérents)', () => {
    const p = mkProduct({
      priceHtCents: 4900,
      installationFeeCents: 1500,
      addons: [{ id: 'a1', name: 'Backup', priceHtCents: 700 }],
    });
    const out = svc.buildPricing(p, { addonIds: ['a1'] });
    expect(out.amountHtCents).toBe(out.lines.reduce((s, l) => s + l.unitPriceHtCents, 0));
    expect(out.taxAmountCents).toBe(out.lines.reduce((s, l) => s + l.taxAmountCents, 0));
    expect(out.amountTtcCents).toBe(out.amountHtCents + out.taxAmountCents);
  });

  it('taxe arrondie PAR LIGNE — impairs 19,6 % : 130 (par ligne) ≠ 131 (arrondi global)', () => {
    const p = mkProduct({
      priceHtCents: 333,
      taxRate: { ratePercent: 19.6 },
      addons: [{ id: 'a1', name: 'Option impaire', priceHtCents: 333 }],
    });
    const out = svc.buildPricing(p, { addonIds: ['a1'] });
    // 333 × 19,6 % = 65,268 → 65 par ligne ; total 666 × 19,6 % = 130,536 → 131.
    expect(out.lines.map((l) => l.taxAmountCents)).toEqual([65, 65]);
    expect(out.taxAmountCents).toBe(130);
    expect(Math.round((out.amountHtCents * 19.6) / 100)).toBe(131);
    expect(out.amountHtCents).toBe(666);
    expect(out.amountTtcCents).toBe(666 + 130);
  });

  it('chaque ligne porte le même taux et totalTtc = unit + taxe', () => {
    const p = mkProduct({
      priceHtCents: 1999,
      taxRate: { ratePercent: 19.6 },
      addons: [{ id: 'a1', name: 'Backup', priceHtCents: 1001 }],
    });
    const out = svc.buildPricing(p, { addonIds: ['a1'] });
    for (const l of out.lines) {
      expect(l.taxRatePercent).toBe(19.6);
      expect(l.taxAmountCents).toBe(Math.round((l.unitPriceHtCents * 19.6) / 100));
      expect(l.totalTtcCents).toBe(l.unitPriceHtCents + l.taxAmountCents);
    }
    expect(out.taxRatePercent).toBe(19.6);
  });

  it('frais d’installation : ligne ADJUSTMENT JAMAIS taxée, incluse dans le HT', () => {
    const p = mkProduct({ priceHtCents: 4900, installationFeeCents: 1500 });
    const out = svc.buildPricing(p, {});
    const adj = out.lines.find((l) => l.kind === 'ADJUSTMENT');
    expect(adj).toBeDefined();
    expect(adj!.taxAmountCents).toBe(0);
    expect(adj!.taxRatePercent).toBe(0);
    expect(adj!.totalTtcCents).toBe(1500);
    expect(out.amountHtCents).toBe(4900 + 1500);
    expect(out.taxAmountCents).toBe(Math.round((4900 * 20) / 100));
    expect(out.amountTtcCents).toBe(4900 + 1500 + 980);
  });

  it('produit SANS taxRate → taux par défaut 0 (aucune taxe inventée)', () => {
    const p = mkProduct({ priceHtCents: 4900, taxRate: null });
    const out = svc.buildPricing(p, {});
    expect(out.taxRatePercent).toBe(0);
    expect(out.taxAmountCents).toBe(0);
    expect(out.amountTtcCents).toBe(4900);
  });

  it('option requise manquante → BadRequest (jamais un total silencieusement faux)', () => {
    const p = mkProduct({
      options: [
        {
          id: 'o1',
          name: 'Système',
          required: true,
          choices: [{ id: 'c1', label: 'Linux', priceDeltaHtCents: 0 }],
        },
      ],
    });
    expect(() => svc.buildPricing(p, { options: [] })).toThrow(BadRequestException);
  });

  it('option inconnue → BadRequest', () => {
    const p = mkProduct({
      options: [
        {
          id: 'o1',
          name: 'Système',
          required: false,
          choices: [{ id: 'c1', label: 'Linux', priceDeltaHtCents: 0 }],
        },
      ],
    });
    expect(() => svc.buildPricing(p, { options: [{ optionId: 'nope', choiceId: 'c1' }] })).toThrow(
      BadRequestException,
    );
  });

  it('choix n’appartenant pas à l’option → BadRequest', () => {
    const p = mkProduct({
      options: [
        {
          id: 'o1',
          name: 'Système',
          required: false,
          choices: [{ id: 'c1', label: 'Linux', priceDeltaHtCents: 0 }],
        },
      ],
    });
    expect(() => svc.buildPricing(p, { options: [{ optionId: 'o1', choiceId: 'bad' }] })).toThrow(
      BadRequestException,
    );
  });

  it('supplément inconnu → BadRequest', () => {
    const p = mkProduct({ addons: [{ id: 'a1', name: 'Backup', priceHtCents: 700 }] });
    expect(() => svc.buildPricing(p, { addonIds: ['ghost'] })).toThrow(BadRequestException);
  });

  it('quote() = buildPricing exactement (le devis ne peut pas différer de la commande)', async () => {
    const p = mkProduct({
      priceHtCents: 4900,
      promoPriceHtCents: 3900,
      installationFeeCents: 500,
      addons: [{ id: 'a1', name: 'Backup', priceHtCents: 701 }],
    });
    findPublicBySlug.mockResolvedValue(p);
    const quote = await (
      svc as unknown as { quote: (d: unknown) => Promise<Pricing & { product: unknown }> }
    ).quote({ productSlug: 'offre-test', options: [], addonIds: ['a1'] });
    const direct = svc.buildPricing(p, { options: [], addonIds: ['a1'] });
    expect(quote.lines).toEqual(direct.lines);
    expect(quote.amountHtCents).toBe(direct.amountHtCents);
    expect(quote.taxAmountCents).toBe(direct.taxAmountCents);
    expect(quote.amountTtcCents).toBe(direct.amountTtcCents);
    expect((quote.product as { activePriceHtCents: number }).activePriceHtCents).toBe(3900);
    expect((quote.product as { priceHtCents: number }).priceHtCents).toBe(4900);
  });
});

// Q7 (GO item 7) — frais de paiement APPLIQUÉS au montant (plus seulement
// journalisés côté admin) : ligne ADJUSTMENT jamais taxée, incluse dans le
// HT/TTC, même base que les frais d'installation.
describe('Q7 — buildPricing/quote : frais du moyen de paiement APPLIQUÉS (GO item 7)', () => {
  const mockPrisma = { paymentMethod: { findFirst: jest.fn() } };
  const mockAudit = {};
  const mockLimiter = {};
  const mockMail = {};
  const mockProvisioning = {};
  const mockCloudflare = {};

  let svc: Svc;
  let findPublicBySlug: jest.Mock;

  beforeEach(() => {
    mockPrisma.paymentMethod.findFirst.mockReset();
    findPublicBySlug = jest.fn();
    const service = new CheckoutService(
      mockPrisma as never,
      { findPublicBySlug } as never,
      mockAudit as never,
      mockLimiter as never,
      mockMail as never,
      mockProvisioning as never,
      mockCloudflare as never,
      { resolveTracking: jest.fn(), operational: jest.fn().mockResolvedValue(false) } as never,
      { applyWithClient: jest.fn() } as never,
    );
    svc = service as unknown as Svc;
  });

  const mkProduct = (over: Record<string, unknown> = {}) =>
    ({
      id: 'p1',
      name: 'Offre test',
      slug: 'offre-test',
      priceHtCents: 4900,
      promoPriceHtCents: null,
      installationFeeCents: 0,
      taxRate: { ratePercent: 20 },
      options: [],
      addons: [],
      ...over,
    }) as unknown;

  const fee = (over: Partial<{ feeType: string; feePercent: number | null; feeFixedCents: number | null }> = {}) => ({
    name: 'Carte bancaire',
    feeType: 'NONE',
    feePercent: null,
    feeFixedCents: null,
    ...over,
  });

  it('feeType NONE (ou méthode absente) → AUCUNE ligne de frais', () => {
    const p = mkProduct();
    expect(svc.buildPricing(p, {}).lines).toHaveLength(1);
    expect(svc.buildPricing(p, {}, fee({ feeType: 'NONE', feePercent: 5 })).lines).toHaveLength(1);
    expect(svc.buildPricing(p, {}, fee({ feeType: 'NONE', feeFixedCents: 500 })).lines).toHaveLength(1);
  });

  it('PERCENT 2,5 % → ligne ADJUSTMENT JAMAIS taxée, incluse dans HT et TTC', () => {
    const p = mkProduct({ priceHtCents: 4900, taxRate: { ratePercent: 20 } });
    const out = svc.buildPricing(p, {}, fee({ feeType: 'PERCENT', feePercent: 2.5 }));
    const feeLine = out.lines.find((l) => l.label.startsWith('Frais de paiement'));
    expect(feeLine).toBeDefined();
    expect(feeLine!.unitPriceHtCents).toBe(Math.round((4900 * 2.5) / 100)); // 122,5 → 123
    expect(feeLine!.taxAmountCents).toBe(0);
    expect(feeLine!.taxRatePercent).toBe(0);
    expect(feeLine!.totalTtcCents).toBe(feeLine!.unitPriceHtCents);
    expect(out.lines.map((l) => l.kind)).toEqual(['PRODUCT', 'ADJUSTMENT']);
    // Frais dans le HT (somme stricte) ; taxe du produit inchangée (20 % de 4900).
    expect(out.amountHtCents).toBe(4900 + 123);
    expect(out.taxAmountCents).toBe(980);
    expect(out.amountTtcCents).toBe(4900 + 123 + 980);
    expect(out.amountTtcCents).toBe(out.lines.reduce((s, l) => s + l.totalTtcCents, 0));
  });

  it('FIXED 150 → ligne fixe exactement à 150', () => {
    const p = mkProduct({ priceHtCents: 4900 });
    const out = svc.buildPricing(p, {}, fee({ feeType: 'FIXED', feeFixedCents: 150 }));
    const feeLine = out.lines.find((l) => l.label.startsWith('Frais de paiement'))!;
    expect(feeLine.unitPriceHtCents).toBe(150);
    expect(out.amountTtcCents).toBe(4900 + 150 + 980);
  });

  it('PERCENT_AND_FIXED → parties pourcentage ET fixe CUMULÉES', () => {
    const p = mkProduct({ priceHtCents: 4900 });
    const out = svc.buildPricing(
      p,
      {},
      fee({ feeType: 'PERCENT_AND_FIXED', feePercent: 2.5, feeFixedCents: 150 }),
    );
    const feeLine = out.lines.find((l) => l.label.startsWith('Frais de paiement'))!;
    expect(feeLine.unitPriceHtCents).toBe(123 + 150);
  });

  it('base du pourcentage = HT COURANT (produit + addons + installation)', () => {
    const p = mkProduct({
      priceHtCents: 4900,
      installationFeeCents: 1500,
      addons: [{ id: 'a1', name: 'Backup', priceHtCents: 700 }],
    });
    const out = svc.buildPricing(p, { addonIds: ['a1'] }, fee({ feeType: 'PERCENT', feePercent: 10 }));
    // base = 4900 + 700 + 1500 = 7100 → 10 % = 710.
    const feeLine = out.lines.find((l) => l.label.startsWith('Frais de paiement'))!;
    expect(feeLine.unitPriceHtCents).toBe(710);
    expect(out.amountHtCents).toBe(7100 + 710);
  });

  it('pourcentage nul/null ou fixe nul → pas de ligne vide', () => {
    const p = mkProduct();
    expect(
      svc.buildPricing(p, {}, fee({ feeType: 'PERCENT', feePercent: null })).lines,
    ).toHaveLength(1);
    expect(
      svc.buildPricing(p, {}, fee({ feeType: 'FIXED', feeFixedCents: 0 })).lines,
    ).toHaveLength(1);
  });

  it('quote(±paymentMethodId) : frais inclus IFF moyen fourni (devis = commande)', async () => {
    const p = mkProduct({ priceHtCents: 4900 });
    findPublicBySlug.mockResolvedValue(p);
    mockPrisma.paymentMethod.findFirst.mockResolvedValue(
      fee({ feeType: 'PERCENT', feePercent: 2.5 }),
    );
    const quote = (
      svc as unknown as { quote: (d: unknown) => Promise<Pricing & { product: unknown }> }
    ).quote.bind(svc);

    // Sans moyen (étape /cart) : aucun frais.
    const q1 = await quote({ productSlug: 'offre-test' });
    expect(q1.lines).toHaveLength(1);
    expect(q1.amountTtcCents).toBe(4900 + 980);

    // Avec moyen : mêmes frais que buildPricing direct.
    const q2 = await quote({ productSlug: 'offre-test', paymentMethodId: 'pm1' });
    expect(mockPrisma.paymentMethod.findFirst).toHaveBeenCalledWith({
      where: { id: 'pm1', isActive: true },
      select: { name: true, feeType: true, feePercent: true, feeFixedCents: true },
    });
    const direct = svc.buildPricing(p, {}, fee({ feeType: 'PERCENT', feePercent: 2.5 }));
    expect(q2.lines).toEqual(direct.lines);
    expect(q2.amountTtcCents).toBe(direct.amountTtcCents);
    expect(q2.amountTtcCents).toBe(q1.amountTtcCents + 123);
  });

  it('quote(±paymentMethodId) : moyen INCONNU ou inactif → BadRequest honnête', async () => {
    const p = mkProduct();
    findPublicBySlug.mockResolvedValue(p);
    mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);
    await expect(
      (svc as unknown as { quote: (d: unknown) => Promise<Pricing> }).quote({
        productSlug: 'offre-test',
        paymentMethodId: 'ghost',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
