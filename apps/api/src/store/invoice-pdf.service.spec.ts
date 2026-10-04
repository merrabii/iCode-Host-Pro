import * as fs from 'node:fs';
import * as path from 'node:path';
import { InvoiceLineKind, InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvoicePdfService,
  InvoiceWithPdf,
} from './invoice-pdf.service';

/**
 * GO P7 (lot D1) — PDF de facture :
 *  - header `%PDF`, contenu figé (snapshot d'mentions, pas de lecture live) ;
 *  - stabilité : deux rendus de la même facture sont OCTET-IDENTIQUES
 *    (dates d'info figées sur issuedAt, flux non compressés) ;
 *  - `ensurePdf` : écrit le fichier + renseigne `pdfPath` une seule fois.
 *
 * pdfkit écrit le texte en **hexadécimal** dans les opérateurs TJ : on décode
 * les chaînes `<…>` pour pouvoir chercher le contenu (flux non compressés).
 */
function pdfText(buf: Buffer): string {
  const hexes = buf.toString('latin1').match(/<([0-9a-fA-F]+)>/g) ?? [];
  return hexes
    .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
    .join('\n');
}

/** pdfkit segmente les mots en plusieurs chaînes (kerning) : on normalise. */
function norm(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '');
}
describe('InvoicePdfService (D1)', () => {
  function makeInvoice(id: string): InvoiceWithPdf {
    return {
      id,
      number: '2026-0042',
      orderId: 'ord-spec',
      customerId: 'cus-spec',
      status: InvoiceStatus.UNPAID,
      currency: 'USD',
      taxRatePercent: new Prisma.Decimal(20),
      amountHtCents: 10_000,
      taxAmountCents: 2_000,
      amountTtcCents: 12_000,
      issuedAt: new Date('2026-10-03T10:00:00.000Z'),
      dueDate: new Date('2026-10-17T10:00:00.000Z'),
      dunningRemindedAt: null,
      paidAt: null,
      walletTransactionId: null,
      subscriptionId: null,
      pdfPath: null,
      creditNoteOfId: null,
      legalMentionsSnapshot: {
        companyName: 'Code Diali SARL',
        companyAddress: '1 rue de l Exemple',
        companyTaxId: 'FR123456789',
        companyEmail: 'billing@test.local',
        mentions: ['Facture generee par Code Diali - mentions D1 figees'],
        invoiceDueDays: 14,
      },
      billingAddress: {
        name: 'Alice Spec',
        email: 'alice@test.local',
        phone: '555-0100',
      },
      lines: [
        {
          id: 'l1',
          invoiceId: id,
          kind: InvoiceLineKind.PRODUCT,
          label: 'Hebergement Pro',
          qty: 1,
          unitPriceHtCents: 8_000,
          taxRatePercent: new Prisma.Decimal(20),
          taxAmountCents: 1_600,
          totalTtcCents: 9_600,
          sortOrder: 0,
        },
        {
          id: 'l2',
          invoiceId: id,
          kind: InvoiceLineKind.ADJUSTMENT,
          label: 'Installation',
          qty: 1,
          unitPriceHtCents: 2_000,
          taxRatePercent: new Prisma.Decimal(0),
          taxAmountCents: 0,
          totalTtcCents: 2_000,
          sortOrder: 1,
        },
      ],
      order: { productName: 'Hebergement Pro' },
    };
  }

  const findUnique = jest.fn();
  const update = jest.fn().mockResolvedValue({});
  const service = new InvoicePdfService({
    invoice: { findUnique, update },
  } as unknown as PrismaService);

  beforeEach(() => {
    findUnique.mockReset();
    update.mockClear();
  });

  it('rend un PDF valide (header %PDF) avec numéro, montants et mentions figées', async () => {
    const buf = await service.render(makeInvoice('inv-spec-basic'));
    expect(buf.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-1\.[34]$/);
    expect(buf.length).toBeGreaterThan(2000);
    const text = norm(pdfText(buf));
    expect(text).toContain(norm('2026-0042')); // numéro
    expect(text).toContain(norm('120.00 USD')); // total TTC (12 000 centimes)
    expect(text).toContain(norm('Alice Spec')); // client
    expect(text).toContain(norm('17/10/2026')); // échéance (UTC)
    expect(text).toContain(norm('mentions D1 figees')); // mention figée
    expect(text).toContain(norm('Code Diali SARL')); // émetteur figé
  });

  it('deux rendus de la même facture sont octet-identiques (PDF stable)', async () => {
    const inv = makeInvoice('inv-spec-stable');
    const a = await service.render(inv);
    const b = await service.render(inv);
    expect(a.equals(b)).toBe(true);
  });

  it('le rendu ne dépend QUE du snapshot : modifier les paramètres après émission ne change rien', async () => {
    // Le service ne lit jamais BillingSetting : on le prouve en rendant deux
    // factures dont seule la ligne snapshot diffère — le contenu suit la
    // facture, pas l'environnement.
    const frozen = makeInvoice('inv-spec-frozen');
    const changed = makeInvoice('inv-spec-frozen');
    changed.legalMentionsSnapshot = {
      ...(changed.legalMentionsSnapshot as Record<string, unknown>),
      mentions: ['MENTIONS MODIFIEES POST EMISSION'],
    };
    const a = await service.render(frozen);
    const b = await service.render(changed);
    expect(a.equals(b)).toBe(false);
    expect(pdfText(a)).not.toContain('MODIFIEES');
    expect(pdfText(b)).toContain('MENTIONS');
    expect(pdfText(b)).toContain('MODIFIEES');
  });

  it('ensurePdf : écrit le fichier disque + renseigne pdfPath (une seule écriture)', async () => {
    const id = `inv-spec-file-${Date.now().toString(36)}`;
    const abs = path.resolve(process.cwd(), 'public', 'invoices', `${id}.pdf`);
    findUnique.mockResolvedValue(makeInvoice(id));
    try {
      const first = await service.ensurePdf(id);
      expect(first.absPath).toBe(abs);
      expect(first.fileName).toBe('facture-2026-0042.pdf');
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs).subarray(0, 8).toString('ascii')).toMatch(
        /^%PDF-1\.[34]$/,
      );
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toEqual({
        where: { id },
        data: { pdfPath: `invoices/${id}.pdf` },
      });

      // Fichier déjà présent + pdfPath déjà renseigné → aucune écriture.
      findUnique.mockResolvedValue({
        ...makeInvoice(id),
        pdfPath: `invoices/${id}.pdf`,
      });
      await service.ensurePdf(id);
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  });

  it('ensurePdf : facture inconnue → 404', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.ensurePdf('inv-nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});
