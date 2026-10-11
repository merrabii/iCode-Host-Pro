import { evaluatePricingAcceptance, pricingQuoteKey } from './pricing-acceptance';

/**
 * GO revue §5a — le moyen accepté peut être `null` (règlement par solde) :
 * correspondance stricte conservée (null ne valide JAMAIS un moyen externe,
 * ni l'inverse), et la PRESENCE du champ reste exigée (null ≠ omission).
 */

const cond = {
  productSlug: 'offre-test',
  options: [{ optionId: 'opt1', choiceId: 'c1' }],
  addonIds: ['a1'],
  paymentMethodId: null as string | null,
  feeType: null as string | null,
  feePercent: null as number | null,
  feeFixedCents: null as number | null,
  currency: 'USD',
  activePriceHtCents: 4900,
  promoPriceHtCents: null,
  taxRatePercent: 20,
  installationFeeCents: 0,
  amountHtCents: 4900,
  taxAmountCents: 980,
  amountTtcCents: 5880,
};

const server = (pm: string | null) => ({
  currency: 'USD',
  paymentMethodId: pm,
  quoteKey: pricingQuoteKey({ ...cond, paymentMethodId: pm }),
});

const accept = (
  pm: string | null | undefined,
  over: Partial<{
    acceptedTotalTtcCents: number;
    acceptedCurrency: string;
    acceptedQuoteKey: string;
  }> = {},
) => ({
  acceptedTotalTtcCents: 5880,
  acceptedCurrency: 'USD',
  acceptedQuoteKey: pricingQuoteKey({ ...cond, paymentMethodId: pm === undefined ? null : pm }),
  ...(pm === undefined ? {} : { acceptedPaymentMethodId: pm }),
  ...over,
});

describe('§5a — acceptation tarifaire avec moyen null (solde du portefeuille)', () => {
  it('solde (server null) + accepted null → accepté', () => {
    expect(
      evaluatePricingAcceptance({ amountTtcCents: 5880, server: server(null), accepted: accept(null) }),
    ).toBeNull();
  });

  it('solde (server null) + accepted OMISSION (undefined) → ACCEPTANCE_REQUIRED (null ≠ absence)', () => {
    const r = evaluatePricingAcceptance({
      amountTtcCents: 5880,
      server: server(null),
      accepted: accept(undefined),
    });
    expect(r?.reason).toBe('ACCEPTANCE_REQUIRED');
    expect(r?.missing).toEqual(['acceptedPaymentMethodId']);
  });

  it('solde (server null) + accepted moyen externe → PAYMENT_METHOD_MISMATCH (null ne valide jamais carte)', () => {
    const r = evaluatePricingAcceptance({
      amountTtcCents: 5880,
      server: server(null),
      accepted: accept('pm_externe'),
    });
    expect(r?.reason).toBe('PAYMENT_METHOD_MISMATCH');
  });

  it('moyen externe (server pm1) + accepted null → PAYMENT_METHOD_MISMATCH (inverse)', () => {
    const r = evaluatePricingAcceptance({
      amountTtcCents: 5880,
      server: server('pm1'),
      accepted: accept(null),
    });
    expect(r?.reason).toBe('PAYMENT_METHOD_MISMATCH');
  });

  it('gratuit (total 0) + accepted null → accepté (aucune preuve requise)', () => {
    expect(
      evaluatePricingAcceptance({
        amountTtcCents: 0,
        server: server(null),
        accepted: { acceptedPaymentMethodId: null },
      }),
    ).toBeNull();
  });

  it('empreinte solde ≠ empreinte carte (quoteKey distinct → jamais de rejeu croisé)', () => {
    expect(pricingQuoteKey({ ...cond, paymentMethodId: null })).not.toBe(
      pricingQuoteKey({ ...cond, paymentMethodId: 'pm1' }),
    );
  });
});
