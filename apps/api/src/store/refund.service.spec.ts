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
  allocateCreditLines,
  assertRefundIdempotencyKey,
  refundCapExceeded,
  refundIdentityMatches,
} from './refund.service';

// GO Q9 — unitaires des fondations remboursements/avoirs :
// A. identité d'idempotence, B. plafond, C. allocation d'une pièce d'avoir
//    sur les lignes source (GO P5 : taxe par ligne, restes exacts), D. contrat
//    du header Idempotency-Key, E. interne (wallet + avoir) sous mocks,
//    F. rejeu sans second effet, G. externe = PENDING sans wallet (jamais de
//    succès sans confirmation réelle), H. machine d'état de confirmation
//    prestataire = SIMULATION étiquetée (preuve de simulation, distincte
//    d'une validation prestataire réelle), E2. GO P4/P5 : statuts sur le
//    cumul RÉUSSI, une PIÈCE par remboursement (aucun cumul sur pièce émise).
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
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      invoiceLine: {
        create: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn(),
      },
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
      billingAddress: { name: 'Membre Q9', email: 'member@test.local' },
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

  // ── C. GO P5 : allocation d’une pièce sur les lignes source ────────────
  describe('allocateCreditLines (C — GO P5)', () => {
    const mixedLines = [
      {
        id: 'src-prod',
        label: 'Produit',
        taxRatePercent: 20,
        taxAmountCents: 20,
        totalTtcCents: 120,
        sortOrder: 0,
      },
      {
        id: 'src-frais',
        label: 'Frais de dossier',
        taxRatePercent: 0,
        taxAmountCents: 0,
        totalTtcCents: 20,
        sortOrder: 1,
      },
    ];
    const none = new Map<string, { ttc: number; tax: number }>();

    it('GO P5 : intégral 140 (HT 100 + taxe 20 + frais 20) → taxe 20, PAS 23,33', () => {
      const out = allocateCreditLines(mixedLines, none, 140);
      expect(out.ttc).toBe(140);
      expect(out.tax).toBe(20);
      expect(out.ht).toBe(120);
      expect(out.ht + out.tax).toBe(out.ttc);
      expect(out.lines).toHaveLength(2);
      expect(out.lines[0]).toMatchObject({
        sourceLineId: 'src-prod',
        taxRatePercent: 20,
        unitPriceHtCents: 100,
        taxAmountCents: 20,
        totalTtcCents: 120,
      });
      expect(out.lines[1]).toMatchObject({
        sourceLineId: 'src-frais',
        taxRatePercent: 0,
        unitPriceHtCents: 20,
        taxAmountCents: 0,
        totalTtcCents: 20,
      });
      // Un taux global (20 % de 140 TTC = 23,33) serait FAUSSE : les frais
      // ne sont pas taxés. Plus aucun découpage par taux global (GO P5).
      expect(out.tax).not.toBe(23);
    });

    it('fractions successives : somme des pièces = totaux source (zéro dérive)', () => {
      const first = allocateCreditLines(mixedLines, none, 70);
      expect(first.ttc).toBe(70);
      expect(first.lines[0]).toMatchObject({
        totalTtcCents: 70,
        taxAmountCents: 12, // round(20 × 70 / 120)
        unitPriceHtCents: 58,
      });
      // 2e pièce : restes (ligne 1 = 50 TTC / 8 taxe, puis frais 20)
      const credited = new Map([['src-prod', { ttc: 70, tax: 12 }]]);
      const second = allocateCreditLines(mixedLines, credited, 70);
      expect(second.ttc).toBe(70);
      expect(second.ht + second.tax).toBe(70);
      expect(first.ht + second.ht).toBe(120);
      expect(first.tax + second.tax).toBe(20);
      expect(first.ttc + second.ttc).toBe(140);
    });

    it('couverture totale après arrondi partiel : reste EXACT (taxe 196)', () => {
      const line = [
        {
          id: 'src-15',
          label: 'Licence',
          taxRatePercent: 15,
          taxAmountCents: 196,
          totalTtcCents: 1500,
          sortOrder: 0,
        },
      ];
      const first = allocateCreditLines(line, none, 1000);
      expect(first.tax).toBe(131); // round(196 × 1000 / 1500)
      expect(first.ht).toBe(869);
      const credited = new Map([['src-15', { ttc: 1000, tax: 131 }]]);
      const second = allocateCreditLines(line, credited, 500);
      expect(second.ttc).toBe(500);
      expect(second.tax).toBe(65); // reste EXACT 196 − 131
      expect(second.ht).toBe(435);
      expect(first.tax + second.tax).toBe(196);
      expect(first.ht + second.ht).toBe(1304);
    });

    it('montant supérieur aux lignes restantes : ConflictException', () => {
      expect(() => allocateCreditLines(mixedLines, none, 141)).toThrow(
        ConflictException,
      );
      const creditedAll = new Map([
        ['src-prod', { ttc: 120, tax: 20 }],
        ['src-frais', { ttc: 20, tax: 0 }],
      ]);
      expect(() => allocateCreditLines(mixedLines, creditedAll, 1)).toThrow(
        ConflictException,
      );
    });

    it('lignes intégralement recréditées sautées, tri sortOrder respecté', () => {
      const credited = new Map([['src-prod', { ttc: 120, tax: 20 }]]);
      const out = allocateCreditLines(mixedLines, credited, 20);
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toMatchObject({
        sourceLineId: 'src-frais',
        totalTtcCents: 20,
        taxAmountCents: 0,
        sortOrder: 0,
      });
      const shuffled = [mixedLines[1], mixedLines[0]];
      const out2 = allocateCreditLines(shuffled, none, 140);
      expect(out2.lines.map((l) => l.sourceLineId)).toEqual([
        'src-prod',
        'src-frais',
      ]);
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
      tx.invoiceLine.findMany.mockResolvedValue([
        {
          id: 'il-1',
          label: 'Licence Q9',
          taxRatePercent: 15,
          taxAmountCents: 196,
          totalTtcCents: 1500,
          sortOrder: 0,
        },
      ]);
      tx.invoiceLine.groupBy.mockResolvedValue([]); // rien de recrédité encore
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

      // avoir : UNE PIÈCE AV- liée (GO P5), montants depuis la ligne source
      expect(tx.invoice.create).toHaveBeenCalledTimes(1);
      expect(tx.invoice.create.mock.calls[0][0].data).toMatchObject({
        number: expect.stringMatching(/^AV-/),
        status: 'CREDITED',
        creditNoteOfId: 'inv-1',
        amountTtcCents: 1000,
        // fraction 1000/1500 de la ligne (taxe 196) : round → 131, HT = 869
        amountHtCents: 869,
        taxAmountCents: 131,
        billingAddress: { name: 'Membre Q9', email: 'member@test.local' },
      });
      // l'avoir n'est rattaché à AUCUNE commande (facture de crédit standalone)
      expect(tx.invoice.create.mock.calls[0][0].data).not.toHaveProperty(
        'orderId',
      );
      expect(tx.invoiceLine.create.mock.calls[0][0].data).toMatchObject({
        kind: 'CREDIT',
        totalTtcCents: 1000,
        sourceLineId: 'il-1', // pièce LIÉE à sa ligne source (GO P5)
        taxRatePercent: 15,
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

  // ── E2. GO P4 : « fullyRefunded » = cumul des RÉUSSIS seulement ────────
  describe('createRefund — cumul réussi vs engagé (P4)', () => {
    it('intention externe PENDING ne bascule ni commande ni facture', async () => {
      const { service, tx, wallet, audit } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow()); // encaissé 1500
      tx.refund.findUnique.mockResolvedValue(null);
      // 1er appel (plafond) : engagé = PENDING 500 + SUCCEEDED 0 = 500
      // 2e appel (statuts) : RÉUSSIS seuls = 0 (l'externe reste PENDING)
      tx.refund.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 500 } })
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } });
      tx.invoice.findUnique.mockResolvedValue(originInvoice());
      tx.refund.create.mockResolvedValue({ id: 'rf-p4' });
      tx.walletTransaction.findUnique.mockResolvedValue({ id: 'wt-p4' });
      tx.refund.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-p4',
          ...data,
        }),
      );

      const view = await service.createRefund(
        'ord-1',
        {
          amountCents: 1000, // wallet réussi → cumul réussi 1000 < 1500
          kind: RefundKind.WALLET_CREDIT,
          reason: 'Moitié remboursée, moitié en attente prestataire',
        },
        'refund-key-p4-0001',
        actor,
      );

      // le wallet est crédité (effet interne réel)…
      expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
      expect(view.status).toBe(RefundStatus.SUCCEEDED);
      // …mais la commande reste PAID et la facture reste PAID : seul un
      // cumul des RÉUSSIS égal à l'encaissé autorise la bascule.
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.invoice.updateMany).not.toHaveBeenCalled();
      const succ = audit.record.mock.calls.find(
        (c) => c[0]?.action === 'refund.succeeded',
      );
      expect(succ?.[0].details).toMatchObject({
        usedAfter: 1500, // engagé : 500 PENDING + 1000 wallet (plafond)
        succeededAfter: 1000, // réussi : wallet seul
        captured: 1500,
        fullyRefunded: false,
      });
    });

    it('cumul RÉUSSI exact = encaissé → bascule commande et facture', async () => {
      const { service, tx } = makeService();
      tx.$queryRaw.mockResolvedValue(paidOrderRow()); // encaissé 1500
      tx.refund.findUnique.mockResolvedValue(null);
      // plafond : 500 déjà engagés ; réussi : 500 déjà réellement remboursés
      tx.refund.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 500 } })
        .mockResolvedValueOnce({ _sum: { amountCents: 500 } });
      tx.invoice.findUnique.mockResolvedValue(originInvoice());
      tx.refund.create.mockResolvedValue({ id: 'rf-p4b' });
      tx.walletTransaction.findUnique.mockResolvedValue({ id: 'wt-p4b' });
      tx.order.updateMany.mockResolvedValue({ count: 1 });
      tx.invoice.updateMany.mockResolvedValue({ count: 1 });
      tx.refund.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-p4b',
          ...data,
        }),
      );

      await service.createRefund(
        'ord-1',
        { amountCents: 1000, kind: RefundKind.WALLET_CREDIT },
        'refund-key-p4-0002',
        actor,
      );

      expect(tx.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status: 'PAID' },
        }),
      );
      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ord-1', status: OrderStatus.PAID },
          data: { status: OrderStatus.REFUNDED },
        }),
      );
    });
  });

  // ── E3. GO P5 : UNE PIÈCE par remboursement, pièce émise intacte ───────
  describe('createRefund — pièces d’avoir distinctes (P5)', () => {
    function setupSecondRefund() {
      const { service, tx, audit } = makeService();
      tx.$queryRaw
        .mockResolvedValueOnce(paidOrderRow()) // verrou commande FOR UPDATE
        .mockResolvedValueOnce([{ next: 51 }]); // UPDATE … RETURNING (séquence)
      tx.billingSetting.findFirst.mockResolvedValue({
        id: 'billing-settings',
        currency: 'USD',
        invoiceSequence: 50,
      });
      tx.refund.findUnique.mockResolvedValue(null);
      tx.refund.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 1000 } }) // engagé
        .mockResolvedValueOnce({ _sum: { amountCents: 1000 } }); // réussi
      tx.invoice.findUnique.mockResolvedValue(originInvoice());
      tx.invoiceLine.findMany.mockResolvedValue([
        {
          id: 'il-1',
          label: 'Licence Q9',
          taxRatePercent: 15,
          taxAmountCents: 196,
          totalTtcCents: 1500,
          sortOrder: 0,
        },
      ]);
      // 1re pièce (1000 TTC, taxe 131) déjà émise sur la ligne source.
      tx.invoiceLine.groupBy.mockResolvedValue([
        {
          sourceLineId: 'il-1',
          _sum: { totalTtcCents: 1000, taxAmountCents: 131 },
        },
      ]);
      tx.refund.create.mockResolvedValue({ id: 'rf-p5-2' });
      tx.invoice.create.mockResolvedValue({ id: 'inv-av-p5-2' });
      tx.walletTransaction.findUnique.mockResolvedValue({ id: 'wt-p5-2' });
      tx.order.updateMany.mockResolvedValue({ count: 1 });
      tx.invoice.updateMany.mockResolvedValue({ count: 1 });
      tx.refund.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-p5-2',
          ...data,
        }),
      );
      return { service, tx, audit };
    }

    it('2e remboursement : NOUVELLE pièce AV- liée, montants = restes EXACTS', async () => {
      const { service, tx } = setupSecondRefund();

      const view = await service.createRefund(
        'ord-1',
        {
          amountCents: 500,
          kind: RefundKind.WALLET_CREDIT,
          issueCreditNote: true,
          reason: 'Solde',
        },
        'refund-key-p5-0001',
        actor,
      );

      expect(view.creditNoteInvoiceId).toBe('inv-av-p5-2');
      expect(view.creditNoteInvoiceId).not.toBe('inv-av-1'); // pièce DISTINCTE
      expect(tx.invoice.create).toHaveBeenCalledTimes(1);
      expect(tx.invoice.create.mock.calls[0][0].data).toMatchObject({
        number: expect.stringMatching(/^AV-/),
        creditNoteOfId: 'inv-1',
        // restes : TTC 1500−1000 = 500, taxe 196−131 = 65, HT 1304−869 = 435
        amountTtcCents: 500,
        amountHtCents: 435,
        taxAmountCents: 65,
        billingAddress: { name: 'Membre Q9', email: 'member@test.local' },
      });
      // AUCUNE mutation d'un avoir déjà émis : makeTx n'expose même plus
      // invoice.update/invoice.updateMany de PIÈCE — un appel = crash.
      expect(tx.invoiceLine.create.mock.calls[0][0].data).toMatchObject({
        kind: 'CREDIT',
        sourceLineId: 'il-1',
        totalTtcCents: 500,
        taxAmountCents: 65,
      });
      // cumul RÉUSSI = encaissé → origine CREDITED + commande REFUNDED
      expect(tx.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status: 'PAID' },
          data: { status: 'CREDITED' },
        }),
      );
      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: OrderStatus.REFUNDED },
        }),
      );
    });

    it('groupBy cible les lignes SOURCE de la facture (restes recalculés)', async () => {
      const { service, tx } = setupSecondRefund();

      await service.createRefund(
        'ord-1',
        { amountCents: 500, kind: RefundKind.WALLET_CREDIT, issueCreditNote: true },
        'refund-key-p5-0002',
        actor,
      );

      expect(tx.invoiceLine.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['sourceLineId'],
          where: { sourceLineId: { in: ['il-1'] } },
        }),
      );
      expect(tx.invoiceLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { invoiceId: 'inv-1', sourceLineId: null },
        }),
      );
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
