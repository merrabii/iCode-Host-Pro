import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  OrderStatus,
  RefundKind,
  RefundStatus,
  WalletTransactionType,
} from '@prisma/client';
import { JwtPayload } from '../auth/types';
import {
  RefundService,
  assertRefundIdempotencyKey,
  creditNoteSplit,
  refundCapExceeded,
  refundIdentityMatches,
} from './refund.service';

// GO Q9 — unitaires des fondations remboursements/avoirs :
// A. identité d'idempotence, B. plafond, C. découpage d'avoir,
// D. contrat du header Idempotency-Key, E. interne (wallet + avoir) sous mocks,
// F. rejeu sans second effet, G. externe = PENDING sans wallet (jamais de
//    succès sans confirmation réelle), H. machine d'état de confirmation
//    prestataire = SIMULATION étiquetée (preuve de simulation, distincte
//    d'une validation prestataire réelle).
describe('RefundService (GO Q9 — remboursements et avoirs)', () => {
  const actor: JwtPayload = {
    sub: 'admin-1',
    email: 'admin-recette@icode.test',
    role: 'ADMIN' as JwtPayload['role'],
  };

  const existing = {
    orderId: 'ord-1',
    amountCents: 1000,
    kind: RefundKind.WALLET_CREDIT,
    issueCreditNote: false,
    reason: 'Annulation à la demande',
  };

  function makeTx() {
    return {
      $queryRaw: jest.fn(),
      refund: {
        findUnique: jest.fn(),
        aggregate: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      invoice: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      invoiceLine: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      order: { updateMany: jest.fn() },
      walletTransaction: { findUnique: jest.fn() },
      billingSetting: { findFirst: jest.fn() },
    };
  }

  function makeService() {
    const tx = makeTx();
    const prisma = {
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      refund: { findUnique: jest.fn() },
      order: { findUnique: jest.fn() },
    };
    const wallet = { applyWithClient: jest.fn() };
    const audit = { record: jest.fn() };
    const service = new RefundService(
      prisma as never,
      wallet as never,
      audit as never,
    );
    return { service, tx, prisma, wallet, audit };
  }

  function paidOrderRow() {
    return [
      {
        id: 'ord-1',
        status: OrderStatus.PAID,
        paidAt: new Date('2026-10-01T10:00:00Z'),
        amountTtcCents: 1500,
        currency: 'USD',
        customerId: 'cust-1',
      },
    ];
  }

  function originInvoice() {
    return {
      id: 'inv-1',
      number: '2026-0001',
      status: RefundStatus.PENDING, // valeur quelconque : statut non lu ici
      currency: 'USD',
      taxRatePercent: 15,
      customerId: 'cust-1',
      legalMentionsSnapshot: { legalName: 'ACME' },
    };
  }

  const KEY = 'refund-key-0001';

  // ── A. identité d'idempotence ──────────────────────────────────────────
  describe('refundIdentityMatches (A)', () => {
    it('accepte une intention strictement identique', () => {
      expect(
        refundIdentityMatches(existing, 'ord-1', { ...existing }),
      ).toBe(true);
    });

    it('accepte reason null/undefined comme même intention', () => {
      const base = { ...existing, reason: null as string | null };
      expect(
        refundIdentityMatches(base, 'ord-1', {
          amountCents: 1000,
          kind: RefundKind.WALLET_CREDIT,
          reason: undefined,
        }),
      ).toBe(true);
    });

    it('rejette si la commande d’origine diffère', () => {
      expect(refundIdentityMatches(existing, 'ord-2', { ...existing })).toBe(
        false,
      );
    });

    it.each([
      ['amountCents', 999],
      ['kind', RefundKind.EXTERNAL_CARD],
      ['issueCreditNote', true],
      ['reason', 'Autre motif'],
    ])('rejette si %s diffère', (field, value) => {
      const input = { ...existing, [field]: value } as typeof existing;
      expect(refundIdentityMatches(existing, 'ord-1', input)).toBe(false);
    });
  });

  // ── B. plafond cumulé ──────────────────────────────────────────────────
  describe('refundCapExceeded (B)', () => {
    it('autorise le cumul exact jusqu’à l’encaissé', () => {
      expect(refundCapExceeded(1500, 500, 1000)).toBe(false);
      expect(refundCapExceeded(1500, 0, 1500)).toBe(false);
    });

    it('refuse tout dépassement du montant encaissé', () => {
      expect(refundCapExceeded(1500, 1500, 1)).toBe(true);
      expect(refundCapExceeded(1500, 1000, 501)).toBe(true);
      expect(refundCapExceeded(0, 0, 1)).toBe(true);
    });
  });

  // ── C. découpage HT/taxe d’un avoir ────────────────────────────────────
  describe('creditNoteSplit (C)', () => {
    it('sans taxe : HT = TTC', () => {
      expect(creditNoteSplit(1000, 0)).toEqual({ ht: 1000, tax: 0 });
    });

    it('taxe 15 % : arrondi au centime, HT + taxe = TTC', () => {
      expect(creditNoteSplit(1000, 15)).toEqual({ ht: 870, tax: 130 });
      expect(creditNoteSplit(10000, 15)).toEqual({ ht: 8696, tax: 1304 });
      const s = creditNoteSplit(999, 15);
      expect(s.ht + s.tax).toBe(999);
    });

    it('taxe 19 % : arrondi au centime, HT + taxe = TTC', () => {
      const s = creditNoteSplit(1000, 19);
      expect(s.tax).toBe(160);
      expect(s.ht).toBe(840);
      expect(s.ht + s.tax).toBe(1000);
    });
  });

  // ── D. header Idempotency-Key ──────────────────────────────────────────
  describe('assertRefundIdempotencyKey (D)', () => {
    it('exige un header présent, 8..128 caractères imprimables', () => {
      expect(() => assertRefundIdempotencyKey(undefined)).toThrow(
        BadRequestException,
      );
      expect(() => assertRefundIdempotencyKey('short')).toThrow(
        BadRequestException,
      );
      expect(() => assertRefundIdempotencyKey('a'.repeat(129))).toThrow(
        BadRequestException,
      );
      expect(() => assertRefundIdempotencyKey('ab\x01cd1234')).toThrow(
        BadRequestException,
      );
      expect(assertRefundIdempotencyKey('  refund-key-0001  ')).toBe(KEY);
    });
  });

  // ── E. interne : wallet + avoir dans la même transaction ───────────────
  describe('createRefund — WALLET_CREDIT (E)', () => {
    it('crédite le wallet (type REFUND), émet l’avoir et bascule les statuts sur cumul complet', async () => {
      const { service, tx, wallet, audit } = makeService();
      tx.$queryRaw
        .mockResolvedValueOnce(paidOrderRow()) // verrou commande FOR UPDATE
        .mockResolvedValueOnce([{ next: 42 }]); // UPDATE … RETURNING (séquence)
      tx.billingSetting.findFirst.mockResolvedValue({
        id: 'billing-settings',
        currency: 'USD',
        invoiceSequence: 41,
      });
      tx.refund.findUnique.mockResolvedValue(null);
      tx.refund.aggregate.mockResolvedValue({ _sum: { amountCents: 500 } });
      tx.invoice.findUnique.mockResolvedValue(originInvoice());
      tx.refund.create.mockResolvedValue({ id: 'rf-1' });
      tx.invoice.create.mockResolvedValue({ id: 'inv-av-1' });
      tx.walletTransaction.findUnique.mockResolvedValue({ id: 'wt-1' });
      tx.order.updateMany.mockResolvedValue({ count: 1 });
      tx.invoice.updateMany.mockResolvedValue({ count: 1 });
      tx.refund.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-1',
          ...data,
        }),
      );

      const view = await service.createRefund(
        'ord-1',
        {
          amountCents: 1000, // 500 engagés + 1000 = 1500 = encaissé
          kind: RefundKind.WALLET_CREDIT,
          reason: 'Annulation à la demande',
          issueCreditNote: true,
        },
        KEY,
        actor,
      );

      // wallet : opération indépendante du prestataire, type REFUND, clé refund:<clé>
      expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
      const [, custId, input, direction] = wallet.applyWithClient.mock.calls[0];
      expect(custId).toBe('cust-1');
      expect(direction).toBe('credit');
      expect(input).toMatchObject({
        amountCents: 1000,
        idempotencyKey: `refund:${KEY}`,
        currency: 'USD',
        type: WalletTransactionType.REFUND,
      });

      // avoir : facture AV- liée, statut CREDITED, ligne CREDIT
      expect(tx.invoice.create).toHaveBeenCalledTimes(1);
      expect(tx.invoice.create.mock.calls[0][0].data).toMatchObject({
        number: expect.stringMatching(/^AV-/),
        status: 'CREDITED',
        creditNoteOfId: 'inv-1',
        amountTtcCents: 1000,
        amountHtCents: 870,
        taxAmountCents: 130,
      });
      // l'avoir n'est rattaché à AUCUNE commande (facture de crédit standalone)
      expect(tx.invoice.create.mock.calls[0][0].data).not.toHaveProperty(
        'orderId',
      );
      expect(tx.invoiceLine.create.mock.calls[0][0].data).toMatchObject({
        kind: 'CREDIT',
        totalTtcCents: 1000,
      });

      // cumul complet → origine CREDITED (CAS PAID uniquement), commande REFUNDED
      expect(tx.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status: 'PAID' },
          data: { status: 'CREDITED' },
        }),
      );
      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ord-1', status: OrderStatus.PAID },
          data: { status: OrderStatus.REFUNDED },
        }),
      );

      // remboursement finalisé + audit tracé
      expect(view.status).toBe(RefundStatus.SUCCEEDED);
      expect(view.walletTransactionId).toBe('wt-1');
      expect(view.replayed).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'refund.succeeded' }),
      );
    });

    it('rejette EXTERNAL_CARD + avoir (avoir = wallet uniquement)', async () => {
      const { service } = makeService();
      await expect(
        service.createRefund(
          'ord-1',
          {
            amountCents: 1000,
            kind: RefundKind.EXTERNAL_CARD,
            issueCreditNote: true,
          },
          KEY,
          actor,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── F. rejeu : même clé = AUCUN second effet ───────────────────────────
  describe('createRefund — rejeu idempotent (F)', () => {
    it('même clé + même intention : rejeu sans wallet ni écriture', async () => {
      const { service, tx, wallet, audit } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow());
      tx.refund.findUnique.mockResolvedValue({
        id: 'rf-1',
        ...existing,
        status: RefundStatus.SUCCEEDED,
        idempotencyKey: KEY,
      });

      const view = await service.createRefund(
        'ord-1',
        { ...existing },
        KEY,
        actor,
      );

      expect(view.replayed).toBe(true);
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(tx.refund.create).not.toHaveBeenCalled();
      expect(tx.invoice.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('même clé + intention différente : 409, aucun effet', async () => {
      const { service, tx, wallet } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow());
      tx.refund.findUnique.mockResolvedValue({
        id: 'rf-1',
        ...existing,
        idempotencyKey: KEY,
      });

      await expect(
        service.createRefund(
          'ord-1',
          { ...existing, amountCents: 500 },
          KEY,
          actor,
        ),
      ).rejects.toThrow(ConflictException);
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(tx.refund.create).not.toHaveBeenCalled();
    });

    it('plafond dépassé : 409 explicite, aucun effet', async () => {
      const { service, tx, wallet } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow());
      tx.refund.findUnique.mockResolvedValue(null);
      tx.refund.aggregate.mockResolvedValue({ _sum: { amountCents: 1500 } });

      await expect(
        service.createRefund(
          'ord-1',
          { amountCents: 1, kind: RefundKind.WALLET_CREDIT },
          'refund-key-0002',
          actor,
        ),
      ).rejects.toThrow(ConflictException);
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(tx.refund.create).not.toHaveBeenCalled();
    });

    it('commande non encaissée : 409, aucun remboursement', async () => {
      const { service, tx } = makeService();
      tx.$queryRaw.mockResolvedValue([
        { ...paidOrderRow()[0], paidAt: null, status: 'PENDING_PAYMENT' },
      ]);

      await expect(
        service.createRefund(
          'ord-1',
          { amountCents: 1, kind: RefundKind.WALLET_CREDIT },
          'refund-key-0003',
          actor,
        ),
      ).rejects.toThrow(ConflictException);
      expect(tx.refund.create).not.toHaveBeenCalled();
    });
  });

  // ── G. externe : PENDING, wallet JAMAIS touché, aucun succès ───────────
  describe('createRefund — EXTERNAL_CARD (G)', () => {
    it('enregistre PENDING sans wallet ni providerRef (aucun succès déclaré)', async () => {
      const { service, tx, wallet, audit } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow());
      tx.refund.findUnique.mockResolvedValue(null);
      tx.refund.aggregate.mockResolvedValue({ _sum: { amountCents: null } });
      tx.invoice.findUnique.mockResolvedValue(originInvoice());
      tx.refund.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-ext-1',
          ...data,
          providerRef: null,
          walletTransactionId: null,
          creditNoteInvoiceId: null,
          processedAt: null,
          createdAt: new Date(),
        }),
      );

      const view = await service.createRefund(
        'ord-1',
        { amountCents: 1500, kind: RefundKind.EXTERNAL_CARD },
        'refund-key-ext1',
        actor,
      );

      expect(view.status).toBe(RefundStatus.PENDING);
      expect(view.providerRef).toBeNull();
      expect(view.walletTransactionId).toBeNull();
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(tx.invoice.updateMany).not.toHaveBeenCalled();
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'refund.created',
          details: expect.objectContaining({ provider: 'disabled' }),
        }),
      );
    });

    it('refuse provider-confirmation : refus 409 tracé (adaptateur non configuré)', async () => {
      const { service, prisma, audit } = makeService();
      prisma.refund.findUnique.mockResolvedValue({
        id: 'rf-ext-1',
        kind: RefundKind.EXTERNAL_CARD,
        status: RefundStatus.PENDING,
        orderId: 'ord-1',
      });

      await expect(
        service.refuseProviderConfirmation('rf-ext-1', actor),
      ).rejects.toThrow(ConflictException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'refund.provider_confirmation_refused',
        }),
      );
    });
  });

  // ── H. SIMULATION étiquetée de la machine d’état (jamais appelée par
  //       l’API admin aujourd’hui) — preuve de simulation, distincte d’une
  //       validation prestataire réelle ────────────────────────────────────
  describe('applyExternalConfirmation — SIMULATION (H)', () => {
    it('PENDING → SUCCEEDED (CAS) : la 2e confirmation = 409, aucun effet', async () => {
      const { service, tx } = makeService();
      tx.refund.updateMany.mockResolvedValueOnce({ count: 1 });

      // SIMULATION (spec uniquement) : état transitif d’une confirmation
      // prestataire RÉELLE hypothétique — aucune route admin n’appelle ceci.
      await expect(
        service.applyExternalConfirmation(tx as never, 'rf-ext-1', 'ch_1'),
      ).resolves.toBeUndefined();
      expect(tx.refund.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rf-ext-1', status: RefundStatus.PENDING },
          data: expect.objectContaining({
            status: RefundStatus.SUCCEEDED,
            providerRef: 'ch_1',
          }),
        }),
      );

      // rejeu / double confirmation : CAS perdu → 409, zéro effet
      tx.refund.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.applyExternalConfirmation(tx as never, 'rf-ext-1', 'ch_1'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
