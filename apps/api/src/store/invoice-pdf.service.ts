import { Injectable, NotFoundException } from '@nestjs/common';
import { Invoice, InvoiceLine, Prisma } from '@prisma/client';
// `import = require` obligatoire : le repo compile SANS esModuleInterop
// (allowSyntheticDefaultImports seul) — un import par défaut exécuterait
// `require('pdfkit').default` → undefined à l'exécution.
import PDFDocument = require('pdfkit');
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

export type InvoiceWithPdf = Invoice & {
  lines: InvoiceLine[];
  order: { productName: string } | null;
};

/** Snapshot figé à l'émission (`Invoice.legalMentionsSnapshot`). */
export interface InvoiceSnapshot {
  companyName?: string | null;
  companyAddress?: string | null;
  companyTaxId?: string | null;
  companyEmail?: string | null;
  mentions?: string[] | null;
  invoiceDueDays?: number;
}

const STATUS_LABEL: Record<string, string> = {
  UNPAID: 'En attente de reglement',
  PAID: 'Reglee',
  CANCELLED: 'Annulee',
  REFUNDED: 'Remboursee',
  CREDITED: 'Avoir',
};

/**
 * GO P7 (lot D1) — PDF de facture.
 *
 * - **Contenu 100 % figé à l'émission** : le rendu ne lit JAMAIS
 *   `BillingSetting` en direct, uniquement la facture + son
 *   `legalMentionsSnapshot` (mentions/entreprise figées) — changer les
 *   paramètres après émission ne modifie jamais une facture émise.
 * - **PDF stable** : `compress:false` (flux lisible, preuve texte), dates
 *   d'info (`CreationDate`/`ModificationDate`) figées sur `issuedAt` →
 *   deux rendus de la même facture sont **octet-identiques**.
 * - **Stockage** : `public/invoices/<invoiceId>.pdf`, chemin relatif écrit dans
 *   `Invoice.pdfPath` (généré à la première demande, régénérable à l'identique
 *   si le fichier disque disparaît).
 * - Aucune écriture de montant : seul `pdfPath` peut être renseigné.
 */
@Injectable()
export class InvoicePdfService {
  constructor(private readonly prisma: PrismaService) {}

  private get dir(): string {
    return path.resolve(process.cwd(), 'public', 'invoices');
  }

  /** Génère (si besoin) et retourne le fichier PDF de la facture. */
  async ensurePdf(
    invoiceId: string,
  ): Promise<{ absPath: string; fileName: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        order: { select: { productName: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');

    const safeId = path.basename(invoice.id);
    const abs = path.join(this.dir, `${safeId}.pdf`);
    if (!fs.existsSync(abs)) {
      const buf = await this.render(invoice);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(abs, buf);
    }

    const rel = `invoices/${safeId}.pdf`;
    if (invoice.pdfPath !== rel) {
      // Seule écriture autorisée : le chemin du fichier (jamais un montant).
      await this.prisma.invoice
        .update({ where: { id: invoice.id }, data: { pdfPath: rel } })
        .catch(() => {});
    }
    return { absPath: abs, fileName: `facture-${invoice.number}.pdf` };
  }

  /** Rendu pur (aucune I/O, aucune lecture de paramètres hors snapshot). */
  async render(invoice: InvoiceWithPdf): Promise<Buffer> {
    const snap = this.snapshot(invoice.legalMentionsSnapshot);
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        compress: false,
        info: {
          Title: `Facture ${invoice.number}`,
          Producer: 'iCode Host Pro',
          Creator: 'iCode Host Pro',
          // Dates figées sur l'émission : deux rendus = octet-identiques.
          CreationDate: invoice.issuedAt,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 50;
      const W = doc.page.width - M * 2; // 495
      const money = (cents: number) =>
        `${(cents / 100).toFixed(2)} ${invoice.currency}`;

      // ── En-tête : émetteur (snapshot figé) à gauche, facture à droite ─────
      let y = M;
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111');
      doc.text(snap.companyName || 'Code Diali', M, y, { width: 300 });
      y += 20;
      doc.font('Helvetica').fontSize(9).fillColor('#444444');
      const emitter = [
        snap.companyAddress,
        snap.companyTaxId ? `TVA/NIF : ${snap.companyTaxId}` : null,
        snap.companyEmail,
      ].filter(Boolean) as string[];
      for (const line of emitter) {
        doc.text(line, M, y, { width: 300 });
        y += 13;
      }

      doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111');
      doc.text('FACTURE', M + W - 200, M, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(11).fillColor('#444444');
      doc.text(`N° ${invoice.number}`, M + W - 200, M + 28, {
        width: 200,
        align: 'right',
      });

      // ── Bloc meta (dates, statut, objet) ───────────────────────────────────
      y = Math.max(y, M + 55) + 18;
      const metaX = M + W - 210;
      const meta: [string, string][] = [
        ['Emise le', this.fmtDate(invoice.issuedAt)],
        ['Echeance', invoice.dueDate ? this.fmtDate(invoice.dueDate) : '—'],
        ['Statut', STATUS_LABEL[invoice.status] ?? invoice.status],
        ['Objet', invoice.order?.productName ?? '—'],
      ];
      doc.font('Helvetica').fontSize(9);
      meta.forEach(([k, v], i) => {
        const my = y + i * 14;
        doc.fillColor('#777777').text(k, metaX, my, { width: 70 });
        doc.fillColor('#111111').text(v, metaX + 74, my, { width: 136 });
      });

      // ── Facturé à ──────────────────────────────────────────────────────────
      let by = y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#777777');
      doc.text('FACTURE A', M, by, { width: 250 });
      by += 14;
      const addr = (invoice.billingAddress ?? {}) as Record<string, unknown>;
      const bto = [
        typeof addr.name === 'string' ? addr.name : null,
        typeof addr.email === 'string' ? addr.email : null,
        typeof addr.phone === 'string' && addr.phone ? String(addr.phone) : null,
      ].filter(Boolean) as string[];
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111');
      doc.text(bto[0] ?? '—', M, by, { width: 250 });
      by += 15;
      doc.font('Helvetica').fontSize(9).fillColor('#444444');
      for (const line of bto.slice(1)) {
        doc.text(line, M, by, { width: 250 });
        by += 13;
      }

      // ── Table des lignes ───────────────────────────────────────────────────
      let ty = Math.max(by, y + meta.length * 14) + 24;
      const cols = {
        label: { x: M, w: 245 },
        qty: { x: M + 245, w: 45 },
        unit: { x: M + 290, w: 75 },
        tax: { x: M + 365, w: 55 },
        total: { x: M + 420, w: 75 },
      };
      doc.rect(M, ty, W, 18).fill('#f2f2f2');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555');
      doc.text('DESIGNATION', cols.label.x + 6, ty + 5, { width: cols.label.w - 12 });
      doc.text('QTE', cols.qty.x, ty + 5, { width: cols.qty.w - 6, align: 'right' });
      doc.text('P.U. HT', cols.unit.x, ty + 5, { width: cols.unit.w - 6, align: 'right' });
      doc.text('TVA', cols.tax.x, ty + 5, { width: cols.tax.w - 6, align: 'right' });
      doc.text('TOTAL TTC', cols.total.x, ty + 5, { width: cols.total.w - 6, align: 'right' });
      ty += 22;

      doc.font('Helvetica').fontSize(9).fillColor('#111111');
      for (const l of invoice.lines) {
        doc.text(l.label, cols.label.x + 6, ty, {
          width: cols.label.w - 12,
          height: 14,
          ellipsis: true,
        });
        doc.text(String(l.qty), cols.qty.x, ty, {
          width: cols.qty.w - 6,
          align: 'right',
        });
        doc.text(money(l.unitPriceHtCents), cols.unit.x, ty, {
          width: cols.unit.w - 6,
          align: 'right',
        });
        doc.text(`${Number(l.taxRatePercent)} %`, cols.tax.x, ty, {
          width: cols.tax.w - 6,
          align: 'right',
        });
        doc.text(money(l.totalTtcCents), cols.total.x, ty, {
          width: cols.total.w - 6,
          align: 'right',
        });
        ty += 16;
      }
      doc.moveTo(M, ty).lineTo(M + W, ty).strokeColor('#dddddd').lineWidth(0.5).stroke();
      ty += 12;

      // ── Totaux ─────────────────────────────────────────────────────────────
      const totals: [string, string, boolean][] = [
        ['Total HT', money(invoice.amountHtCents), false],
        ['Total TVA', money(invoice.taxAmountCents), false],
        ['Total TTC', money(invoice.amountTtcCents), true],
      ];
      totals.forEach(([k, v, strong], i) => {
        const ry = ty + i * 16;
        doc.font(strong ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(strong ? 11 : 9)
          .fillColor(strong ? '#111111' : '#555555')
          .text(k, M + W - 200, ry, { width: 95, align: 'right' });
        doc.fillColor('#111111').text(v, M + W - 100, ry, {
          width: 100,
          align: 'right',
        });
      });

      // ── Mentions figées à l'émission ───────────────────────────────────────
      let fy = ty + totals.length * 16 + 26;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#666666')
        .text(
          `Reglement par virement avec la reference : ${invoice.number}.`,
          M,
          fy,
          { width: W },
        );
      fy += 13;
      const footerCompany = [
        snap.companyName,
        snap.companyAddress,
        snap.companyTaxId,
        snap.companyEmail,
      ].filter(Boolean);
      if (footerCompany.length) {
        doc.text(footerCompany.join(' · '), M, fy, { width: W });
        fy += 12;
      }
      for (const line of snap.mentions ?? []) {
        doc.text(line, M, fy, { width: W });
        fy += 12;
      }

      doc.end();
    });
  }

  private snapshot(json: Prisma.JsonValue | null): InvoiceSnapshot {
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return json as InvoiceSnapshot;
    }
    return {};
  }

  /** Date UTC « dd/MM/yyyy » — stable quel que soit la locale de l'hôte. */
  private fmtDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
}
