import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request = require('supertest');
import { Role, WalletTxStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import { WalletService } from './../src/wallet/wallet.service';

// Sweep (timer) OFF : aucune ligne de ce test ne dépend du sweep.
process.env.ORDER_SWEEP_ENABLED = 'false';

/**
 * P6 — Portefeuille & recharge par virement (e2e, lots C2 + C3a) :
 *
 *  A. solde client + isolation (401, dossiers séparés) ;
 *  B. dépôt de recharge : justificatif OBLIGATOIRE (type/taille/montant 400),
 *     ligne PENDING, référence RCH, SOLDE INCHANGÉ ;
 *  C. validation admin : crédit EXACTEMENT 1 fois (revalidation → 409),
 *     justificatif flux ADMIN (403 client), audit acteur ;
 *  D. rejet : 0 crédit (solde inchangé), motif conservé, re-rejet → 409 ;
 *  E. concurrence PG réelle : 5 débits parallèles (2 OK / 3 refus, jamais
 *     négatif) + rejeu idempotent d'un crédit (1 seul crédit) ;
 *  F. RBAC + audit ;
 *  G. Q8 : contenu RÉEL des justificatifs (magic bytes, pas le MIME déclaré),
 *     bankRef de rapprochement obligatoire et UNIQUE (un encaissement = un
 *     crédit), justificatif stocké HORS répertoire public, téléchargements
 *     vérifiés avec et sans autorisation.
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Portefeuille & recharge virement (e2e, P6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let wallet: WalletService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p6admin_${stamp}@example.com`;
  const aliceEmail = `p6alice_${stamp}@example.com`;
  const bobEmail = `p6bob_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';

  let aliceRecharge1 = ''; // validée (C)
  let aliceRecharge2 = ''; // rejetée (D)
  let bobRecharge1 = ''; // concurrence (E)
  const rechargeIds: string[] = [];
  const proofPaths: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = {
    create: jest.fn().mockReturnValue(mailTransportStub),
  };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function uploadRecharge(
    token: string,
    fields: Record<string, string>,
    attach?: { buffer: Buffer; filename: string },
  ) {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/wallet/recharges`)
      .set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    if (attach) req.attach('proof', attach.buffer, attach.filename);
    return req;
  }

  const PDF = { buffer: Buffer.from('%PDF-1.4 recette P6'), filename: 'virement.pdf' };
  // Vrai PNG (1×1) — les tests Q8 vérifient la SIGNATURE, pas le nom de fichier.
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  async function balanceOf(email: string): Promise<number> {
    const c = await prisma.customer.findUnique({ where: { email } });
    return c?.walletBalanceCents ?? -1;
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
    wallet = moduleRef.get(WalletService);
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
    await mkUser(adminEmail, Role.ADMIN, 'Admin P6');
    await mkUser(aliceEmail, Role.USER, 'Alice P6');
    await mkUser(bobEmail, Role.USER, 'Bob P6');
    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    await prisma.auditLog
      .deleteMany({
        where: {
          action: { in: ['wallet.recharge.create', 'wallet.recharge.validate', 'wallet.recharge.reject'] },
          actorEmail: { in: [aliceEmail, bobEmail, adminEmail] },
        },
      })
      .catch(() => {});
    await prisma.walletTransaction.deleteMany({
      where: { customer: { email: { in: [aliceEmail, bobEmail] } } },
    }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: [aliceEmail, bobEmail] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [aliceEmail, bobEmail, adminEmail] } } }).catch(() => {});
    const dir = path.resolve(process.cwd(), 'storage', 'wallet-proofs');
    for (const f of proofPaths) {
      try {
        fs.unlinkSync(path.join(dir, path.basename(f)));
      } catch {
        /* déjà absent */
      }
    }
    delete process.env.ORDER_SWEEP_ENABLED;
    await app.close();
  });

  // ── A — solde & isolation ──────────────────────────────────────────────────
  describe('A — solde client & isolation', () => {
    it('A1 — 401 anonyme ; solde à 0 pour chaque membre (dossier auto-créé)', async () => {
      await request(app.getHttpServer()).get(`/${GlobalPrefix}/client/wallet`).expect(401);

      const alice = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(alice.body.balanceCents).toBe(0);
      expect(alice.body.currency).toBe('USD');
      expect(alice.body.customerEmail).toBe(aliceEmail);

      const bob = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
      expect(bob.body.balanceCents).toBe(0);

      // Dossiers distincts.
      const ca = await prisma.customer.findUnique({ where: { email: aliceEmail } });
      const cb = await prisma.customer.findUnique({ where: { email: bobEmail } });
      expect(ca?.id).not.toBe(cb?.id);
      expect(ca?.userId).toBeTruthy();
    });

    it('A2 — historique paginé & isolé (Bob vide même après recharge d’Alice)', async () => {
      const alice = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet/transactions`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(alice.body.total).toBe(0);
      expect(alice.body.page).toBe(1);

      const bob = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet/transactions`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
      expect(bob.body.total).toBe(0);

      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet/transactions`)
        .expect(401);
    });
  });

  // ── B — dépôt de recharge (0 crédit) ───────────────────────────────────────
  describe('B — dépôt de recharge par virement', () => {
    it('B1 — validations : justificatif requis, type refusé, montants bornés', async () => {
      // Sans justificatif.
      await uploadRecharge(aliceToken, { amountCents: '2500' }).expect(400);
      // Type hors PNG/JPEG/WebP/PDF.
      await uploadRecharge(
        aliceToken,
        { amountCents: '2500' },
        { buffer: Buffer.from('hello'), filename: 'note.txt' },
      ).expect(400);
      // Montants : sous le minimum, au-delà du maximum, non entier.
      await uploadRecharge(
        aliceToken,
        { amountCents: '50' },
        PDF,
      ).expect(400);
      await uploadRecharge(
        aliceToken,
        { amountCents: '10000001' },
        PDF,
      ).expect(400);
      await uploadRecharge(
        aliceToken,
        { amountCents: 'abc' },
        PDF,
      ).expect(400);

      // Rien n'a été écrit.
      expect(await balanceOf(aliceEmail)).toBe(0);
      expect(
        await prisma.walletTransaction.count({
          where: { customer: { email: aliceEmail } },
        }),
      ).toBe(0);
    });

    it('B2 — dépôt valide → PENDING + référence RCH + justificatif disque, SOLDE 0', async () => {
      const res = await uploadRecharge(
        aliceToken,
        { amountCents: '2500', note: 'virement octobre' },
        PDF,
      ).expect(201);
      aliceRecharge1 = res.body.id;
      rechargeIds.push(res.body.id);
      expect(res.body.status).toBe(WalletTxStatus.PENDING);
      expect(res.body.reference).toMatch(/^RCH-[0-9A-F]{10}$/);
      expect(res.body.amountCents).toBe(2500);
      expect(res.body.proofFileName).toBeTruthy();

      const row = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: aliceRecharge1 },
      });
      expect(row.status).toBe(WalletTxStatus.PENDING);
      expect(row.proofPath).toBeTruthy();
      expect(row.reference).toBe(res.body.reference);
      proofPaths.push(row.proofPath!);

      const abs = path.resolve(process.cwd(), 'storage', 'wallet-proofs');
      expect(fs.existsSync(path.join(abs, path.basename(row.proofPath!)))).toBe(true);
      // Q8 — le justificatif n'est JAMAIS dans un répertoire public.
      expect(
        fs.existsSync(
          path.join(
            path.resolve(process.cwd(), 'public', 'wallet-proofs'),
            path.basename(row.proofPath!),
          ),
        ),
      ).toBe(false);
      await request(app.getHttpServer())
        .get(`/wallet-proofs/${path.basename(row.proofPath!)}`)
        .expect(404); // aucun statique servi

      // AUCUN crédit avant validation.
      expect(await balanceOf(aliceEmail)).toBe(0);
    });

    it('B3 — liste admin : PENDING visible, filtre statut, RBAC 401/403', async () => {
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(403);

      const pending = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges?status=PENDING`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const ids = (pending.body.items as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(aliceRecharge1);
      const row = (pending.body.items as { id: string; customer: { email: string } }[]).find(
        (r) => r.id === aliceRecharge1,
      );
      expect(row?.customer.email).toBe(aliceEmail);

      const done = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges?status=SUCCEEDED`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((done.body.items as { id: string }[]).map((r) => r.id)).not.toContain(
        aliceRecharge1,
      );
    });
  });

  // ── C — validation admin : crédit exactement une fois ──────────────────────
  describe('C — validation admin (crédit unique)', () => {
    it('C1 — validate (bankRef obligatoire) → solde crédité 1 fois + rapprochement + audit', async () => {
      const res = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge1}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: `BANK-C1-${stamp}` })
        .expect(201);
      expect(res.body.balanceCents).toBe(2500);
      expect(res.body.bankRef).toBe(`BANK-C1-${stamp}`);
      expect(res.body.amountCents).toBe(2500);
      expect(res.body.currency).toBe('USD');
      expect(await balanceOf(aliceEmail)).toBe(2500);

      const row = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: aliceRecharge1 },
      });
      expect(row.status).toBe(WalletTxStatus.SUCCEEDED);
      expect(row.adminActorEmail).toBe(adminEmail);
      expect(row.bankRef).toBe(`BANK-C1-${stamp}`); // fonds constatés (Q8)
      expect(row.processedAt).not.toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'wallet.recharge.validate', resourceId: aliceRecharge1 },
      });
      expect(audit?.actorEmail).toBe(adminEmail);
      // Q8 — l'audit conserve référence, montant et devise de l'encaissement.
      const details = audit?.details as Record<string, unknown> | undefined;
      expect(details?.bankRef).toBe(`BANK-C1-${stamp}`);
      expect(details?.amountCents).toBe(2500);
      expect(details?.currency).toBe('USD');
    });

    it('C2 — revalidation → 409, solde TOUJOURS 2500 (crédit unique)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge1}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: `BANK-C2-${stamp}` })
        .expect(409);
      expect(await balanceOf(aliceEmail)).toBe(2500);
    });

    it('C3 — justificatif : anonyme 401, admin 200 (application/pdf), client 403, inconnu 404', async () => {
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge1}/proof`)
        .expect(401);
      const proof = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge1}/proof`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(proof.headers['content-type']).toContain('application/pdf');

      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge1}/proof`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges/p6-nope-${stamp}/proof`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // ── D — rejet : 0 crédit ───────────────────────────────────────────────────
  describe('D — rejet admin (0 crédit)', () => {
    it('D1 — reject → CANCELED, solde inchangé, motif conservé, re-rejet 409', async () => {
      const created = await uploadRecharge(
        aliceToken,
        { amountCents: '1500', note: 'à vérifier' },
        PDF,
      ).expect(201);
      aliceRecharge2 = created.body.id;
      rechargeIds.push(aliceRecharge2);
      const row2 = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: aliceRecharge2 },
      });
      proofPaths.push(row2.proofPath!);
      expect(await balanceOf(aliceEmail)).toBe(2500); // toujours 2500

      const reject = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge2}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'preuve illisible' })
        .expect(201);
      expect(reject.body.ok).toBe(true);

      // 0 crédit.
      expect(await balanceOf(aliceEmail)).toBe(2500);
      const after = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: aliceRecharge2 },
      });
      expect(after.status).toBe(WalletTxStatus.CANCELED);
      expect(after.note).toContain('REJET : preuve illisible');
      expect(after.processedAt).not.toBeNull();

      // Re-rejet → 409 (CAS), solde toujours intact.
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${aliceRecharge2}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'encore' })
        .expect(409);
      expect(await balanceOf(aliceEmail)).toBe(2500);

      // La ligne rejetée reste visible côté client (historique, statut CANCELED).
      const history = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet/transactions`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      const seen = (history.body.items as { id: string; status: string }[]).find(
        (t) => t.id === aliceRecharge2,
      );
      expect(seen?.status).toBe(WalletTxStatus.CANCELED);
    });

    it('D2 — recharge introuvable → 404 (validate & reject)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/p6-nope-${stamp}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: `BANK-D2-${stamp}` })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/p6-nope-${stamp}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // ── E — concurrence PG réelle + idempotence ────────────────────────────────
  describe('E — concurrence & idempotence (service réel, base PG)', () => {
    it('E1 — 5 débits parallèles : 2 OK / 3 refus, solde final 200, jamais négatif', async () => {
      // Solde de Bob = 1000 via recharge validée (parcours normal).
      const created = await uploadRecharge(
        bobToken,
        { amountCents: '1000' },
        PDF,
      ).expect(201);
      bobRecharge1 = created.body.id;
      rechargeIds.push(bobRecharge1);
      const row = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: bobRecharge1 },
      });
      proofPaths.push(row.proofPath!);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${bobRecharge1}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: `BANK-E1-${stamp}` })
        .expect(201);
      expect(await balanceOf(bobEmail)).toBe(1000);

      const customer = await prisma.customer.findUniqueOrThrow({
        where: { email: bobEmail },
      });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          wallet.debit(customer.id, {
            amountCents: 400,
            idempotencyKey: `p6-race-${stamp}-${i}`,
            note: 'concurrence recette',
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const ko = results.filter((r) => r.status === 'rejected');
      expect(ok.length).toBe(2);
      expect(ko.length).toBe(3);

      const finalBalance = await balanceOf(bobEmail);
      expect(finalBalance).toBe(200);
      expect(finalBalance).toBeGreaterThanOrEqual(0);

      // 2 lignes DEBIT réussies + la recharge = 3 lignes (les refus n'écrivent rien).
      const debits = await prisma.walletTransaction.count({
        where: { customerId: customer.id, type: 'DEBIT' },
      });
      expect(debits).toBe(2);
    });

    it('E2 — rejeu idempotent d’un crédit : même clé → 1 seul crédit', async () => {
      const customer = await prisma.customer.findUniqueOrThrow({
        where: { email: bobEmail },
      });
      const before = customer.walletBalanceCents;
      const key = `p6-dup-${stamp}`;
      const first = await wallet.credit(customer.id, { amountCents: 500, idempotencyKey: key });
      expect(first.replayed).toBe(false);
      const second = await wallet.credit(customer.id, { amountCents: 500, idempotencyKey: key });
      expect(second.replayed).toBe(true);
      expect(second.balanceCents).toBe(before + 500);
      expect(await balanceOf(bobEmail)).toBe(before + 500);

      const rows = await prisma.walletTransaction.count({
        where: { customerId: customer.id, idempotencyKey: key },
      });
      expect(rows).toBe(1);
    });
  });

  // ── G — Q8 : contenu réel des preuves + encaissement bancaire unique ──────
  describe('G — Q8 : justificatifs réels & encaissement unique', () => {
    it('G1 — validate sans bankRef (absent ou < 3 car.) → 400, AUCUN crédit', async () => {
      const created = await uploadRecharge(aliceToken, { amountCents: '500' }, PDF).expect(201);
      rechargeIds.push(created.body.id);
      const createdRow = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      proofPaths.push(createdRow.proofPath!);
      const before = await balanceOf(aliceEmail);

      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${created.body.id}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400); // corps absent
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${created.body.id}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: 'ab' })
        .expect(400); // trop court

      const row = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(row.status).toBe(WalletTxStatus.PENDING); // toujours juste un dépôt
      expect(row.bankRef).toBeNull();
      expect(await balanceOf(aliceEmail)).toBe(before);
    });

    it('G2 — contenu RÉEL du justificatif : signatures fausses → 400, rien stocké', async () => {
      const countBefore = await prisma.walletTransaction.count({
        where: { customer: { email: aliceEmail } },
      });
      // GIF bidon déclaré image/png (le nom de fichier ne fait pas foi).
      await uploadRecharge(
        aliceToken,
        { amountCents: '300' },
        { buffer: Buffer.from('GIF89a-bidon-'), filename: 'faux.png' },
      ).expect(400);
      // Contenu PNG mais déclaré image/jpeg.
      await uploadRecharge(
        aliceToken,
        { amountCents: '300' },
        { buffer: PNG_1PX, filename: 'faux.jpg' },
      ).expect(400);
      expect(
        await prisma.walletTransaction.count({
          where: { customer: { email: aliceEmail } },
        }),
      ).toBe(countBefore);
    });

    it('G3 — même encaissement bancaire → UN seul crédit (409 clair, ligne suivante intacte)', async () => {
      const r1 = await uploadRecharge(aliceToken, { amountCents: '700' }, PDF).expect(201);
      const r2 = await uploadRecharge(aliceToken, { amountCents: '800' }, PDF).expect(201);
      rechargeIds.push(r1.body.id, r2.body.id);
      for (const id of [r1.body.id, r2.body.id]) {
        const row = await prisma.walletTransaction.findUniqueOrThrow({ where: { id } });
        proofPaths.push(row.proofPath!);
      }
      const before = await balanceOf(aliceEmail);
      const shared = `BANK-SHARED-${stamp}`;

      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${r1.body.id}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: shared })
        .expect(201);
      expect(await balanceOf(aliceEmail)).toBe(before + 700);

      const dup = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${r2.body.id}/validate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bankRef: shared })
        .expect(409);
      expect((dup.body as { message: string }).message).toContain('déjà utilisé');
      // Aucun second crédit — la transaction a été avortée par l'unicité PG.
      expect(await balanceOf(aliceEmail)).toBe(before + 700);
      const row2 = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: r2.body.id },
      });
      expect(row2.status).toBe(WalletTxStatus.PENDING);
      expect(row2.bankRef).toBeNull();

      // L'admin voit le rapprochement bancaire sur la recharge créditée.
      const detail = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/wallet/recharges/${r1.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((detail.body as { bankRef: string }).bankRef).toBe(shared);
      // Le client, lui, ne voit JAMAIS la référence interne de rapprochement.
      const history = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/wallet/transactions`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      const mine = (history.body.items as Record<string, unknown>[]).find(
        (t) => t.id === r1.body.id,
      );
      expect(mine).toBeTruthy();
      expect(mine!.bankRef).toBeUndefined();
    });
  });
});
