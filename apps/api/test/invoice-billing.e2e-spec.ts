import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request = require('supertest');
import {
  BillingSetting,
  InvoiceStatus,
  OrderStatus,
  PaymentMethodType,
  Prisma,
  Role,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Sweep (timer) OFF : aucune ligne de ce test ne dépend du sweep.
process.env.ORDER_SWEEP_ENABLED = 'false';

/**
 * P7 — Facturation (e2e, lot D1, GO socle) :
 *
 *  A. émission : `dueDate` = `issuedAt + invoiceDueDays` (ms exactes), snapshot
 *     `legalMentionsSnapshot` figé, `pdfPath` nul tant que non téléchargé ;
 *     PATCH post-émmission ne change JAMAIS la facture déjà émise ;
 *  B. PDF : 401 anonyme / 404 non-propriétaire / 200 propriétaire+admin,
 *     `content-disposition` `facture-<num>.pdf`, contenu = snapshot (anciennes
 *     mentions, jamais les nouvelles), régénération disque identique ;
 *  C. stabilité : téléchargements octet-identiques (rendu déterministe) ;
 *  D. unicité réelle sous concurrence PG : singleton `BillingSetting`
 *     recréé + 6 checkouts parallèles → 6 numéros `YYYY-<seq>` distincts,
 *     UNE seule ligne de paramètres ;
 *  E. RBAC + validations des paramètres (401/403/200, 400 bornes, `''`/`[]`
 *     = effacement).
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Facturation & PDF de facture (e2e, P7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p7admin_${stamp}@example.com`;
  const aliceEmail = `p7alice_${stamp}@example.com`;
  const bobEmail = `p7bob_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';

  // Fixtures.
  let productId = '';
  let productSlug = '';
  let virId = '';
  let createdMailId: string | null = null;

  // Paramètres de facturation : snapshot AVANT toute modification (restauration).
  let origRow: BillingSetting | null = null;
  let settingsId = '';

  // Facture d'Alice (A/B/C).
  let aliceOrderId = '';
  let aliceInvoiceId = '';
  let aliceInvoiceNumber = '';
  let alicePdf1: Buffer | null = null;
  const orderIds: string[] = [];
  const guestEmails: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = {
    create: jest.fn().mockReturnValue(mailTransportStub),
  };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  function api(pathName: string, token?: string) {
    const req = request(app.getHttpServer()).get(`/${GlobalPrefix}${pathName}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function patchSettings(body: Record<string, unknown>, token = adminToken) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/store/admin/billing-settings`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function checkout(email: string, name: string, token?: string) {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .send({
        productSlug,
        name,
        email,
        paymentMethodId: virId,
        // P7 : preuve d'acceptation tarifaire obligatoire (préchargée).
        ...(acceptanceFor(productSlug, virId) ?? {}),
      });
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  /** GET PDF : superagent met déjà les types binaires (application/pdf) en Buffer. */
  function getPdf(url: string, token?: string) {
    const req = request(app.getHttpServer()).get(`/${GlobalPrefix}${url}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  /** pdfkit écrit les textes en hexadécimal dans les opérateurs TJ. */
  function pdfText(buf: Buffer): string {
    const hexes = buf.toString('latin1').match(/<([0-9a-fA-F]+)>/g) ?? [];
    return hexes
      .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
      .join('\n');
  }

  /** pdfkit segmente les mots (kerning) : comparaison sans espaces/casse. */
  function norm(s: string): string {
    return s.replace(/[^A-Za-z0-9]+/g, '');
  }

  function fmtUtc(d: Date): string {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  }

  // ── Boot + fixtures ────────────────────────────────────────────────────────
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: {
          email,
          name,
          passwordHash: await bcrypt.hash(password, 10),
          role,
        },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin P7');
    await mkUser(aliceEmail, Role.USER, 'Alice P7');
    await mkUser(bobEmail, Role.USER, 'Bob P7');
    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);

    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-P7-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const product = await prisma.product.create({
      data: {
        name: `p7-invoice-${stamp}`,
        slug: `p7-invoice-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 10000,
      },
    });
    productId = product.id;
    productSlug = product.slug!;

    // Config mail minimale (host + fromEmail requis) : transport stubbé, 0 SMTP.
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P7',
          },
        })
      ).id;
    }

    // Paramètres AVANT toute modification (restauration finale + séquence).
    origRow = await prisma.billingSetting.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    // Valeurs du scénario A : échéance 7 j + mentions figées.
    const patched = await patchSettings({
      companyName: 'Code Diali Recette',
      companyAddress: '2 rue de la Recette',
      companyTaxId: 'FR Recette 000',
      companyEmail: 'facture@recette.local',
      legalMentions: ['MENTION ORIGINALE P7'],
      invoiceDueDays: 7,
    }).expect(200);
    settingsId = (patched.body as { id: string }).id;

    // P7 : preuve d'acceptation préchargée (après toute fixture de tarif).
    await preloadAcceptance(app.getHttpServer(), productSlug, virId);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    const t0 = Date.now();
    const mark = (stage: string) => {
      // eslint-disable-next-line no-console
      console.log(`[afterAll+${Date.now() - t0}ms] ${stage}`);
    };
    // Restauration définitive : identité d'origine, séquence JAMAIS décroissante.
    try {
      const current = await prisma.billingSetting.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      const seq = Math.max(
        origRow?.invoiceSequence ?? 0,
        current?.invoiceSequence ?? 0,
      );
      await prisma.billingSetting.deleteMany();
      if (origRow) {
        await prisma.billingSetting.create({
          data: {
            id: origRow.id,
            currency: origRow.currency,
            companyName: origRow.companyName,
            companyAddress: origRow.companyAddress,
            companyTaxId: origRow.companyTaxId,
            companyEmail: origRow.companyEmail,
            legalMentions:
              origRow.legalMentions === null
                ? Prisma.JsonNull
                : (origRow.legalMentions as Prisma.InputJsonValue),
            invoiceSequence: seq,
            invoiceDueDays: origRow.invoiceDueDays,
            dunningReminderDays: origRow.dunningReminderDays,
            dunningGraceDays: origRow.dunningGraceDays,
            createdAt: origRow.createdAt,
          },
        });
      }
    } catch {
      /* restauration best-effort : le ménage ci-dessous reste exécuté */
    }
    mark('billing-restore');

    await prisma.auditLog
      .deleteMany({
        where: { action: 'billing.settings.update', actorEmail: adminEmail },
      })
      .catch(() => {});
    mark('audit');
    const allEmails = [adminEmail, aliceEmail, bobEmail, ...guestEmails];
    await prisma.walletTransaction
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    mark('wallet');
    await prisma.orderStatusHistory
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    mark('history');
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    mark('invoices');
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    mark('orders');
    await prisma.customer.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    mark('customers-users');
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    mark('fixtures');
    // PDF générés (storage/ Q8 + ancien emplacement public/ nettoyé aussi).
    for (const id of [aliceInvoiceId, ...(await invoiceIdsOfOrders(orderIds))]) {
      for (const dir of ['storage', 'public']) {
        try {
          fs.unlinkSync(path.resolve(process.cwd(), dir, 'invoices', `${id}.pdf`));
        } catch {
          /* déjà absent */
        }
      }
    }
    mark('pdfs');
    delete process.env.ORDER_SWEEP_ENABLED;
    await app.close();
    mark('closed');
  }, 60_000);

  async function invoiceIdsOfOrders(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await prisma.invoice.findMany({
      where: { orderId: { in: ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ── A — émission : échéance + snapshot figé ────────────────────────────────
  describe('A — émission de la facture (dueDate + snapshot)', () => {
    it('A1 — PATCH paramètres (échéance 7 j) → GET echo + audit acteur', async () => {
      const res = await api('/store/admin/billing-settings', adminToken).expect(200);
      const body = res.body as {
        id: string;
        invoiceDueDays: number;
        legalMentions: string[] | null;
        companyName: string;
        companyEmail: string;
      };
      expect(body.id).toBe(settingsId);
      expect(body.invoiceDueDays).toBe(7);
      expect(body.legalMentions).toEqual(['MENTION ORIGINALE P7']);
      expect(body.companyName).toBe('Code Diali Recette');
      expect(body.companyEmail).toBe('facture@recette.local');

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'billing.settings.update',
          actorEmail: adminEmail,
          resourceId: settingsId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
    });

    it('A2 — checkout membre → facture : dueDate = issuedAt + 7 j (ms), snapshot figé, pdfPath nul', async () => {
      // Commande passée PAR ALICE (membre connecté) : la facture lui appartient,
      // ce qui alimente les tests d'isolation PDF (B) côté propriétaire.
      const res = await checkout(aliceEmail, 'Alice P7', aliceToken).expect(201);
      const body = res.body as {
        orderId: string;
        invoiceNumber: string;
        nextStep: string;
      };
      aliceOrderId = body.orderId;
      orderIds.push(aliceOrderId);
      expect(body.nextStep).toBe('payment-pending');
      expect(body.invoiceNumber).toMatch(/^\d{4}-\d{4}$/);

      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { orderId: aliceOrderId },
      });
      aliceInvoiceId = invoice.id;
      aliceInvoiceNumber = invoice.number;
      expect(invoice.number).toBe(body.invoiceNumber);
      expect(invoice.status).toBe(InvoiceStatus.UNPAID);
      expect(invoice.pdfPath).toBeNull();

      // Échéance = émission + 7 j, exactement (ms).
      expect(invoice.dueDate).not.toBeNull();
      expect(invoice.dueDate!.getTime()).toBe(
        invoice.issuedAt.getTime() + 7 * 86_400_000,
      );

      // Snapshot figé à l'émission (aucune relecture des paramètres).
      const snap = invoice.legalMentionsSnapshot as Record<string, unknown>;
      expect(snap.companyName).toBe('Code Diali Recette');
      expect(snap.companyAddress).toBe('2 rue de la Recette');
      expect(snap.companyTaxId).toBe('FR Recette 000');
      expect(snap.companyEmail).toBe('facture@recette.local');
      expect(snap.mentions).toEqual(['MENTION ORIGINALE P7']);
      expect(snap.invoiceDueDays).toBe(7);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: aliceOrderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('A3 — PATCH post-émmission (mentions/entreprise/échéance) → facture INTACTE', async () => {
      await patchSettings({
        companyName: 'Nouvelle Raison SARL',
        legalMentions: ['MENTION MODIFIEE POST EMISSION'],
        invoiceDueDays: 3,
        companyEmail: '',
      }).expect(200);

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: aliceInvoiceId } });
      const snap = invoice.legalMentionsSnapshot as Record<string, unknown>;
      expect(snap.companyName).toBe('Code Diali Recette'); // pas « Nouvelle Raison »
      expect(snap.mentions).toEqual(['MENTION ORIGINALE P7']);
      expect(snap.companyEmail).toBe('facture@recette.local'); // '' non rétroactif
      expect(snap.invoiceDueDays).toBe(7);
      expect(invoice.dueDate!.getTime()).toBe(
        invoice.issuedAt.getTime() + 7 * 86_400_000,
      );
    });
  });

  // ── B — PDF : accès, isolation, contenu figé ───────────────────────────────
  describe('B — téléchargement du PDF', () => {
    it('B1 — 401 anonyme, 404 non-propriétaire, 200 propriétaire (contenu figé)', async () => {
      await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`).expect(401);
      await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, bobToken).expect(404);

      const res = await getPdf(
        `/client/invoices/${aliceInvoiceId}/pdf`,
        aliceToken,
      ).expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain(
        `facture-${aliceInvoiceNumber}.pdf`,
      );
      const buf = res.body as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      alicePdf1 = buf;

      // Contenu = SNAPSHOT (mentions d'origine, jamais les nouvelles).
      const text = norm(pdfText(buf));
      expect(text).toContain(norm(aliceInvoiceNumber));
      expect(text).toContain(norm('Code Diali Recette'));
      expect(text).toContain(norm('MENTION ORIGINALE P7'));
      expect(text).toContain(norm('100.00 USD')); // 10 000 centimes
      expect(text).toContain(norm(`Echeance ${fmtUtc(
        (await prisma.invoice.findUniqueOrThrow({ where: { id: aliceInvoiceId } })).dueDate!,
      )}`));
      expect(text).not.toContain(norm('MENTION MODIFIEE POST EMISSION'));
      expect(text).not.toContain(norm('Nouvelle Raison SARL'));

      // pdfPath renseigné après la 1re demande + fichier disque (Q8 : storage/).
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: aliceInvoiceId } });
      expect(after.pdfPath).toBe(`storage/invoices/${aliceInvoiceId}.pdf`);
      expect(after.pdfRenderedStatus).toBe('UNPAID');
      const abs = path.resolve(process.cwd(), 'storage', 'invoices', `${aliceInvoiceId}.pdf`);
      expect(fs.existsSync(abs)).toBe(true);
      // Q8 — JAMAIS de PDF servable depuis un répertoire public.
      expect(
        fs.existsSync(path.resolve(process.cwd(), 'public', 'invoices', `${aliceInvoiceId}.pdf`)),
      ).toBe(false);
      await request(app.getHttpServer()).get(`/invoices/${aliceInvoiceId}.pdf`).expect(404);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/invoices/${aliceInvoiceId}.pdf`)
        .expect(404);
    });

    it('B2 — admin 200 (flux + détail hasPdf), client détail hasPdf, 404 inconnu, RBAC', async () => {
      // Q8 — téléchargements VÉRIFIÉS avec et sans autorisation.
      await getPdf(`/store/admin/invoices/${aliceInvoiceId}/pdf`).expect(401); // anonyme
      await getPdf(`/store/admin/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(403); // client

      const adminPdf = await getPdf(
        `/store/admin/invoices/${aliceInvoiceId}/pdf`,
        adminToken,
      ).expect(200);
      expect((adminPdf.body as Buffer).subarray(0, 5).toString('ascii')).toBe('%PDF-');

      await getPdf('/store/admin/invoices/p7-nope-pdf/pdf', adminToken).expect(404);
      await getPdf(`/client/invoices/p7-nope-pdf/pdf`, aliceToken).expect(404);

      const detail = await api(`/client/invoices/${aliceInvoiceId}`, aliceToken).expect(200);
      expect(detail.body.hasPdf).toBe(true);
      expect(detail.body.dueDate).toBeTruthy();

      const adminDetail = await api(
        `/store/admin/invoices/${aliceInvoiceId}`,
        adminToken,
      ).expect(200);
      expect(adminDetail.body.hasPdf).toBe(true);
    });

    it('B3 — régénération après suppression disque : même octets, toujours figé', async () => {
      const abs = path.resolve(process.cwd(), 'storage', 'invoices', `${aliceInvoiceId}.pdf`);
      fs.unlinkSync(abs);
      await prisma.invoice.update({
        where: { id: aliceInvoiceId },
        data: { pdfPath: null },
      });

      const res = await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(
        200,
      );
      const buf = res.body as Buffer;
      expect(buf.equals(alicePdf1!)).toBe(true); // rendu déterministe
      expect(fs.existsSync(abs)).toBe(true);
      const text = norm(pdfText(buf));
      expect(text).toContain(norm('MENTION ORIGINALE P7'));
      expect(text).not.toContain(norm('MENTION MODIFIEE POST EMISSION'));
    });
  });

  // ── C — stabilité : téléchargements octet-identiques ───────────────────────
  describe('C — stabilité du PDF (2 téléchargements)', () => {
    it('C1 — deux téléchargements consécutifs → buffers OCTET-IDENTIQUES', async () => {
      const a = await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(200);
      const b = await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(200);
      expect((a.body as Buffer).equals(b.body as Buffer)).toBe(true);
      expect((a.body as Buffer).equals(alicePdf1!)).toBe(true);
    });
  });

  // ── Q8 — politique explicite du statut de paiement sur le PDF ─────────────
  describe('C2 (Q8) — statut de paiement re-stampé, émission toujours figée', () => {
    it('C2.1 — passage UNPAID → PAID : prochain PDF affiche « Réglée », montants/mentions intacts', async () => {
      await prisma.invoice.update({
        where: { id: aliceInvoiceId },
        data: { status: InvoiceStatus.PAID, paidAt: new Date('2026-10-05T10:00:00.000Z') },
      });

      const res = await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(200);
      const buf = res.body as Buffer;
      const text = norm(pdfText(buf));
      expect(text).toContain(norm('Reglee')); // statut ACTUEL
      expect(text).toContain(norm(aliceInvoiceNumber)); // émission figée
      expect(text).toContain(norm('MENTION ORIGINALE P7')); // snapshot figé
      expect(text).toContain(norm('100.00 USD')); // montants figés
      expect(text).not.toContain(norm('En attente de reglement')); // plus l'ancien statut

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: aliceInvoiceId } });
      expect(after.pdfRenderedStatus).toBe('PAID');
      expect(after.pdfPath).toBe(`storage/invoices/${aliceInvoiceId}.pdf`);
      const abs = path.resolve(process.cwd(), 'storage', 'invoices', `${aliceInvoiceId}.pdf`);
      expect(fs.existsSync(abs)).toBe(true);

      // Re-demande dans le même statut → octet-identique.
      const again = await getPdf(`/client/invoices/${aliceInvoiceId}/pdf`, aliceToken).expect(200);
      expect((again.body as Buffer).equals(buf)).toBe(true);
    });
  });

  // ── D — unicité des numéros sous concurrence réelle ────────────────────────
  describe('D — unicité du numéro sous concurrence PG (6 checkouts parallèles)', () => {
    const parEmails = Array.from(
      { length: 6 },
      (_, i) => `p7par${i}_${stamp}@example.com`,
    );

    afterAll(async () => {
      guestEmails.push(...parEmails);
    });

    it('D1 — 6 checkouts parallèles → 6 numéros distincts YYYY-<seq>, 1 seule ligne de paramètres', async () => {
      // Ménage des factures existantes : sur une base neuve la séquence peut
      // être petite (0001…) — on supprime NOTRE facture d'Alice pour éviter
      // toute collision de numéro (unique) pendant le pic parallèle.
      await prisma.invoice.deleteMany({ where: { id: aliceInvoiceId } }).catch(() => {});
      await prisma.billingSetting.deleteMany();

      const results = await Promise.all(
        parEmails.map((email, i) => checkout(email, `Client P7 par ${i}`)),
      );
      for (const r of results) expect(r.status).toBe(201);

      const numbers = results.map(
        (r) => (r.body as { invoiceNumber: string }).invoiceNumber,
      );
      for (const n of numbers) expect(n).toMatch(/^\d{4}-\d{4}$/);
      expect(new Set(numbers).size).toBe(6);

      // Singleton recréé : UNE seule ligne de paramètres, séquence cohérente.
      expect(await prisma.billingSetting.count()).toBe(1);
      const row = await prisma.billingSetting.findFirstOrThrow();
      expect(row.invoiceSequence).toBeGreaterThanOrEqual(6);

      // 6 factures réellement persistées, toutes UNPAID.
      const orders = results.map((r) => (r.body as { orderId: string }).orderId);
      orderIds.push(...orders);
      const invoices = await prisma.invoice.findMany({
        where: { orderId: { in: orders } },
      });
      expect(invoices.length).toBe(6);
      for (const inv of invoices) expect(inv.status).toBe(InvoiceStatus.UNPAID);
    });
  });

  // ── E — RBAC + validations des paramètres ──────────────────────────────────
  describe('E — RBAC & validations /store/admin/billing-settings', () => {
    it('E1 — RBAC : 401 anonyme, 403 client, 200 admin (GET + PATCH)', async () => {
      await api('/store/admin/billing-settings').expect(401);
      await api('/store/admin/billing-settings', aliceToken).expect(403);
      await api('/store/admin/billing-settings', adminToken).expect(200);

      await patchSettings({ companyName: 'X' }, '').expect(401);
      await patchSettings({ companyName: 'X' }, aliceToken).expect(403);
      await patchSettings({ companyName: 'X' }, adminToken).expect(200);
    });

    it('E2 — validations 400 : échéance hors bornes, >10 mentions, email invalide', async () => {
      await patchSettings({ invoiceDueDays: 91 }).expect(400);
      await patchSettings({ invoiceDueDays: -1 }).expect(400);
      await patchSettings({ invoiceDueDays: 'abc' }).expect(400);
      await patchSettings({
        legalMentions: Array.from({ length: 11 }, (_, i) => `m${i}`),
      }).expect(400);
      await patchSettings({ companyEmail: 'pas-un-email' }).expect(400);
    });

    it('E3 — effacement : email \'\' et mentions [] → null en base, audit tracé', async () => {
      await patchSettings({ companyEmail: '' }).expect(200);
      await patchSettings({ legalMentions: [] }).expect(200);

      const res = await api('/store/admin/billing-settings', adminToken).expect(200);
      expect(res.body.companyEmail).toBeNull();
      expect(res.body.legalMentions).toBeNull();

      const row = await prisma.billingSetting.findFirstOrThrow({
        orderBy: { createdAt: 'asc' },
      });
      expect(row.companyEmail).toBeNull();
      expect(row.legalMentions).toBeNull();

      const audits = await prisma.auditLog.count({
        where: { action: 'billing.settings.update', actorEmail: adminEmail },
      });
      expect(audits).toBeGreaterThanOrEqual(3); // A1 + E1 + E3
    });
  });
});
