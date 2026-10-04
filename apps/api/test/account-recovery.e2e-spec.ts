import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { createHash } from 'crypto';
import { ClosureRequestStatus, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';

/**
 * P3 — Compte client (e2e, GO socle lot A1 + GO Q3 item 3) : reset de mot de
 * passe, édition de profil, changement d'email VÉRIFIÉ, sessions, propriété
 * des dossiers et demande de clôture — base dédiée du chantier.
 *
 *  A. forgot-password : anti-énumération (réponse identique connu/inconnu,
 *     aucun mail ni jeton pour un compte inexistant), jeton sha256 seul au
 *     repos, liens précédents supprimés, rate-limit 5/min.
 *  B. reset-password : parcours complet (mail → lien → nouveau mdp), usage
 *     unique, 400 générique unique inconnu/utilisé/expiré, mdp trop court
 *     AVANT de brûler le jeton, sessions détruites (refresh cookie mort),
 *     ancien mdp refusé / nouveau accepté, audit sans secrets,
 *     + CONSUMPTION CONCURRENTE : deux confirmations simultanées du même
 *     jeton → UNE SEULE réussit (GO : opération conditionnelle atomique).
 *  C. PATCH /users/me : nom appliqué immédiatement, email = PARCOURS DE
 *     VÉRIFICATION (aucune écriture immédiate, mail vers la NOUVELLE adresse,
 *     pendingEmail exposé), 409 email déjà pris par un compte, isolation JWT.
 *  D. POST /auth/confirm-email-change : bascule atomique (usage unique CAS),
 *     double-confirmation → 400, unicité revérifiée sous contrainte → 409,
 *     ancien JWT toujours valable (stateless) mais claims périmés documentés.
 *  E. impersonation = lecture seule sur PATCH /users/me (403).
 *  F. sessions (GO) : double-refresh concurrent toléré + une seule rotation,
 *     logout SUPPRIME la ligne (401 même dans la fenêtre de rejeu 10 s),
 *     changePassword détruit toutes les sessions, isActive bloque le refresh,
 *     access token stateless après logout (documenté).
 *  G. propriété (GO) : deux comptes + dossier invité + ancien JWT + régression
 *     ownedBy (un email ne vole pas le dossier lié à un autre compte),
 *     ensureOwnedCustomer : identité DB (JWT périmé), rattachement concurrent
 *     → un seul dossier.
 *  H. clôture de compte (GO) : demande annulable/réactivable, AUCUNE
 *     suppression automatique des pièces financières, RBAC admin, 409 après
 *     traitement.
 *
 * Coutures (AUCUN réseau réel) : MailTransportFactory stubbé (emails capturés),
 * PanelTransportFactory stubbé. PrismaService RÉEL — base dédiée du chantier.
 */
describe('Compte client — reset mdp, profil, email vérifié, sessions, dossiers, clôture (e2e, P3 / A1 / GO Q3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const aliceEmail = `p3alice_${stamp}@example.com`;
  const aliceNewEmail = `p3alice_new_${stamp}@example.com`;
  const bobEmail = `p3bob_${stamp}@example.com`;
  const adminEmail = `p3admin_${stamp}@example.com`;
  const ghostEmail = `p3ghost_${stamp}@example.com`;
  const password = 'password123';
  const newPassword = 'Nouveau-Mdp-2026';

  let aliceId = '';
  let bobId = '';
  let adminId = '';
  let aliceToken = '';
  let bobToken = '';
  let adminToken = '';
  let aliceResetToken = '';
  let aliceRefreshCookie = '';
  let aliceVerifyToken = '';
  let bobVerifyToken = '';
  let createdMailId: string | null = null;
  let priorMailSnapshot: {
    id: string;
    host: string;
    fromEmail: string;
    fromName: string | null;
    enabled: boolean;
  } | null = null;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const GENERIC_400 = 'Lien de réinitialisation invalide ou expiré.';
  const GENERIC_EC_400 = 'Lien de vérification invalide ou expiré.';

  // ── Helpers ───────────────────────────────────────────────────────────────
  function forgot(email: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/forgot-password`)
      .send({ email });
  }

  function reset(token: string, pw: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/reset-password`)
      .send({ token, password: pw });
  }

  function login(email: string, pw: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password: pw });
  }

  function patchMe(token: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getMe(token: string): request.Test {
    return request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${token}`);
  }

  function refresh(cookie: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/refresh`)
      .set('Cookie', cookie);
  }

  function logout(cookie: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/logout`)
      .set('Cookie', cookie);
  }

  function changePw(token: string, body: Record<string, string>): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function confirmEmailChange(token: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/confirm-email-change`)
      .send({ token });
  }

  function getWallet(token: string): request.Test {
    return request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/wallet`)
      .set('Authorization', `Bearer ${token}`);
  }

  function listOrders(token: string): request.Test {
    return request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/orders`)
      .set('Authorization', `Bearer ${token}`);
  }

  function patchUser(adminTok: string, id: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send(body);
  }

  /** Première valeur `set-cookie` réduite à `name=value`. */
  function cookieOf(res: request.Response): string {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    return String(set?.[0] ?? '').split(';')[0];
  }

  /** Texte du premier email dont le sujet commence par `prefix`. */
  function mailText(prefix: string): string {
    const call = mailTransportStub.sendMail.mock.calls.find((c: unknown[]) =>
      String((c[0] as { subject?: string } | undefined)?.subject ?? '').startsWith(prefix),
    );
    return String((call?.[0] as { text?: string } | undefined)?.text ?? '');
  }

  function extractResetToken(text: string): string {
    const m = /auth\/reset\?token=([A-Za-z0-9_-]+)/.exec(text);
    if (!m) throw new Error(`Aucun jeton de réinitialisation dans le mail: ${text}`);
    return m[1];
  }

  function extractVerifyToken(text: string): string {
    const m = /auth\/verifier-email\?token=([A-Za-z0-9_-]+)/.exec(text);
    if (!m) throw new Error(`Aucun jeton de vérification email dans le mail: ${text}`);
    return m[1];
  }

  const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');

  // ── Boot + fixtures ───────────────────────────────────────────────────────
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

    const hash = await bcrypt.hash(password, 10);
    const alice = await prisma.user.create({
      data: { email: aliceEmail, name: 'Alice P3', role: Role.USER, passwordHash: hash },
    });
    const bob = await prisma.user.create({
      data: { email: bobEmail, name: 'Bob P3', role: Role.USER, passwordHash: hash },
    });
    await prisma.user.create({
      data: { email: adminEmail, name: 'Admin P3', role: Role.ADMIN, passwordHash: hash },
    });
    aliceId = alice.id;
    bobId = bob.id;
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } })).id;

    aliceToken = (await login(aliceEmail, password).expect(201)).body.accessToken as string;
    bobToken = (await login(bobEmail, password).expect(201)).body.accessToken as string;
    expect(aliceToken).toBeTruthy();
    expect(bobToken).toBeTruthy();

    // Config mail minimale : host + fromEmail (getMailConfig) + enabled=true
    // (isEnabled() gates les emails de compte). Transport stubbé, aucun SMTP
    // réel. Snapshot/restore — une row existante est mise à jour puis rendue.
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P3',
            enabled: true,
          },
        })
      ).id;
    } else {
      priorMailSnapshot = {
        id: priorMail.id,
        host: priorMail.host,
        fromEmail: priorMail.fromEmail,
        fromName: priorMail.fromName,
        enabled: priorMail.enabled,
      };
      await prisma.mailSetting.update({
        where: { id: priorMail.id },
        data: {
          host: priorMail.host || 'smtp.test.local',
          fromEmail: priorMail.fromEmail || `noreply-${stamp}@test.local`,
          enabled: true,
        },
      });
    }
  });

  beforeEach(() => {
    limiter.reset();
    mailTransportStub.sendMail.mockClear();
  });

  afterAll(async () => {
    // Journal d'audit APPEND-ONLY laissé en place (même convention que P2 :
    // seuls les comptes/jetons/fixtures sont supprimés, cascade FK comprise).
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: [aliceId, bobId] } } }).catch(() => {});
    await prisma.refreshToken
      .deleteMany({ where: { userId: { in: [aliceId, bobId] } } })
      .catch(() => {});
    // Fixtures GO Q3 : dossiers (→ cascades sur les commandes), puis produit.
    // Tous les emails de fixtures finissent par _${stamp}@… (ou @guest…).
    await prisma.customer
      .deleteMany({
        where: {
          OR: [
            { email: { endsWith: `_${stamp}@example.com` } },
            { email: { endsWith: `_${stamp}@guest.example.com` } },
            { userId: { in: [aliceId, bobId] } },
          ],
        },
      })
      .catch(() => {});
    await prisma.product.deleteMany({ where: { name: `GO-ownership-${uid}` } }).catch(() => {});
    await prisma.user
      .deleteMany({
        where: {
          email: {
            in: [
              aliceEmail,
              aliceNewEmail,
              bobEmail,
              adminEmail,
              `charlie_${stamp}@example.com`,
              `eve_old_${stamp}@example.com`,
              `eve_new_${stamp}@example.com`,
              `conc_${stamp}@example.com`,
            ],
          },
        },
      })
      .catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    } else if (priorMailSnapshot) {
      await prisma.mailSetting
        .update({
          where: { id: priorMailSnapshot.id },
          data: {
            host: priorMailSnapshot.host,
            fromEmail: priorMailSnapshot.fromEmail,
            fromName: priorMailSnapshot.fromName,
            enabled: priorMailSnapshot.enabled,
          },
        })
        .catch(() => {});
    }
    await app?.close();
  });

  // ── A. forgot-password ────────────────────────────────────────────────────
  describe('A. POST /auth/forgot-password (anti-énumération)', () => {
    it('unknown email: 201 {ok:true}, no mail, no token row, audit found:false', async () => {
      const before = await prisma.passwordResetToken.count();
      const res = await forgot(ghostEmail).expect(201);
      expect(res.body).toEqual({ ok: true });
      expect(mailTransportStub.sendMail).not.toHaveBeenCalled();
      expect(await prisma.passwordResetToken.count()).toBe(before);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.password.reset_requested', actorId: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect((audit!.details as { email?: string })?.email).toBe(ghostEmail);
      expect((audit!.details as { found?: boolean })?.found).toBe(false);
    });

    it('known email: identical response either way, sha256-only row, mail carries the raw link, stale links superseded', async () => {
      // Un lien précédent encore inactif pour alice : doit être supprimé.
      const staleHash = sha256(`stale-${uid}`);
      await prisma.passwordResetToken.create({
        data: { tokenHash: staleHash, userId: aliceId, expiresAt: new Date(Date.now() + 3_600_000) },
      });

      const unknownRes = await forgot(ghostEmail).expect(201);
      const knownRes = await forgot(aliceEmail).expect(201);

      // Même statut, même corps : aucune fuite par la réponse.
      expect(knownRes.status).toBe(unknownRes.status);
      expect(knownRes.body).toEqual(unknownRes.body);
      expect(knownRes.body).toEqual({ ok: true });

      // L'ancien lien inactif a été supprimé, un seul actif pour alice.
      expect(await prisma.passwordResetToken.findUnique({ where: { tokenHash: staleHash } })).toBeNull();
      const active = await prisma.passwordResetToken.findMany({
        where: { userId: aliceId, usedAt: null },
      });
      expect(active).toHaveLength(1);
      expect(active[0].tokenHash).toHaveLength(64);
      expect(active[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Email : sujet + lien absolu contenant le jeton brut (jamais en base).
      expect(mailTransportStub.sendMail).toHaveBeenCalledTimes(1);
      const text = mailText('Réinitialisation');
      expect(text).toContain('/auth/reset?token=');
      expect(text).toContain(`expire dans 30 minutes`);
      aliceResetToken = extractResetToken(text);
      expect(aliceResetToken).toBeTruthy();
      expect(active[0].tokenHash).toBe(sha256(aliceResetToken));

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.password.reset_requested', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect((audit!.details as { emailSent?: boolean })?.emailSent).toBe(true);
      // Le jeton brut n'apparaît jamais dans l'audit.
      expect(JSON.stringify(audit)).not.toContain(aliceResetToken);
    });

    it('rate-limit: 5/min per IP — 6th request refused', async () => {
      for (let i = 0; i < 5; i++) {
        await forgot(bobEmail).expect(201);
      }
      const res = await forgot(bobEmail).expect(401);
      expect(String(res.body.message ?? '')).toContain('Trop de tentatives');
    });
  });

  // ── B. reset-password ─────────────────────────────────────────────────────
  describe('B. POST /auth/reset-password (usage unique + sessions détruites)', () => {
    it('issues a fresh link (supersedes A) and captures a live refresh session', async () => {
      // Session d'Alice en vie (cookie refresh) AVANT le reset.
      const loginRes = await login(aliceEmail, password).expect(201);
      const setCookie = loginRes.headers['set-cookie'] as unknown as string[];
      aliceRefreshCookie = String(setCookie[0]).split(';')[0];
      expect(aliceRefreshCookie).toContain('ihp_refresh=');

      await forgot(aliceEmail).expect(201);
      const text = mailText('Réinitialisation');
      aliceResetToken = extractResetToken(text);
      expect(aliceResetToken).toBeTruthy();
    });

    it('short password: 400 BEFORE burning the token', async () => {
      const res = await reset(aliceResetToken, 'court').expect(400);
      // Le DTO (class-validator) tranche avant la couche service — les deux
      // messages parlent de 8 caractères.
      expect(String(res.body.message)).toContain('8');
      const row = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: sha256(aliceResetToken) },
      });
      expect(row).toBeTruthy();
      expect(row!.usedAt).toBeNull(); // le lien est encore bon
    });

    it('valid token: password replaced, token consumed, all active sessions destroyed', async () => {
      await reset(aliceResetToken, newPassword).expect(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(await bcrypt.compare(newPassword, user.passwordHash)).toBe(true);
      expect(await bcrypt.compare(password, user.passwordHash)).toBe(false);
      expect(user.email).toBe(aliceEmail); // mdp seul touché

      const row = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: sha256(aliceResetToken) },
      });
      expect(row!.usedAt).not.toBeNull();

      // Sessions actives détruites (supprimées, pas seulement révoquées).
      const active = await prisma.refreshToken.count({
        where: { userId: aliceId, revokedAt: null },
      });
      expect(active).toBe(0);
    });

    it('reusing the consumed link → the SAME generic 400 (no oracle)', async () => {
      const res = await reset(aliceResetToken, newPassword).expect(400);
      expect(res.body.message).toBe(GENERIC_400);
    });

    it('old password refused / new password accepted', async () => {
      await login(aliceEmail, password).expect(401);
      const res = await login(aliceEmail, newPassword).expect(201);
      aliceToken = res.body.accessToken as string;
      expect(aliceToken).toBeTruthy();
    });

    it('the pre-reset refresh cookie is dead (401, no resurrection)', async () => {
      await refresh(aliceRefreshCookie).expect(401);
    });

    it('unknown AND expired tokens both yield the generic 400', async () => {
      const unknownRes = await reset('jamais-emis-' + uid, newPassword).expect(400);
      expect(unknownRes.body.message).toBe(GENERIC_400);

      const expiredRaw = `expire-${uid}`;
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: sha256(expiredRaw),
          userId: aliceId,
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const expiredRes = await reset(expiredRaw, newPassword).expect(400);
      expect(expiredRes.body.message).toBe(GENERIC_400);
    });

    it('GO Q3: two CONCURRENT consumptions of the same token → exactly ONE wins', async () => {
      await forgot(aliceEmail).expect(201);
      const token = extractResetToken(mailText('Réinitialisation'));
      const before = await prisma.refreshToken.count({ where: { userId: aliceId, revokedAt: null } });
      expect(before).toBeGreaterThan(0); // la session du login précédent est vivante

      const [r1, r2] = await Promise.all([
        reset(token, newPassword),
        reset(token, newPassword),
      ]);
      // Une seule conditionnelle atomique peut obtenir count === 1.
      expect([r1.status, r2.status].sort()).toEqual([201, 400]);

      const row = await prisma.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: sha256(token) },
      });
      expect(row.usedAt).not.toBeNull();
      // Le gagnant a détruit toutes les sessions (le perdant n'a rien écrit).
      expect(
        await prisma.refreshToken.count({ where: { userId: aliceId, revokedAt: null } }),
      ).toBe(0);
      // Et le mot de passe final reste celui du gagnant (identique ici).
      const user = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(await bcrypt.compare(newPassword, user.passwordHash)).toBe(true);
    });

    it('audit: reset + reset_requested journaled, secrets never present', async () => {
      const requested = await prisma.auditLog.findFirst({
        where: { action: 'auth.password.reset_requested', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      const done = await prisma.auditLog.findFirst({
        where: { action: 'auth.password.reset', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect(requested).toBeTruthy();
      expect(done).toBeTruthy();

      const dump = JSON.stringify([requested, done]);
      expect(dump).not.toContain(aliceResetToken);
      expect(dump).not.toContain(newPassword);
      expect(dump).not.toContain(password); // ni l'ancien mot de passe
      expect(dump).not.toContain('passwordHash');
    });
  });

  // ── C. PATCH /users/me — parcours de vérification d'email (GO Q3) ─────────
  describe('C. PATCH /users/me (nom immédiat, email en attente de vérification)', () => {
    it('name applied immediately, email NOT written — verification mail to the NEW address', async () => {
      const res = await patchMe(aliceToken, {
        name: '  Alice Renommée  ',
        email: aliceNewEmail,
      }).expect(200);
      expect(res.body.name).toBe('Alice Renommée');
      // Aucune écriture immédiate de l'email : il change À la confirmation.
      expect(res.body.email).toBe(aliceEmail);
      expect(res.body.pendingEmail).toBe(aliceNewEmail);
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('mfaSecretEnc');
      expect(res.body).not.toHaveProperty('githubTokenEnc');

      // En base : inchangé, seule une demande (jeton sha256) existe.
      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(dbUser.email).toBe(aliceEmail);
      const pending = await prisma.emailChangeToken.findMany({
        where: { userId: aliceId, usedAt: null },
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].tokenHash).toHaveLength(64);
      expect(pending[0].newEmail).toBe(aliceNewEmail);

      // Mail envoyé À LA NOUVELLE adresse, lien de vérification dedans.
      expect(mailTransportStub.sendMail).toHaveBeenCalledTimes(1);
      const text = mailText('Confirmez');
      expect(text).toContain('/auth/verifier-email?token=');
      aliceVerifyToken = extractVerifyToken(text);
      expect(pending[0].tokenHash).toBe(sha256(aliceVerifyToken));

      // getMe expose pendingEmail.
      const me = await getMe(aliceToken).expect(200);
      expect(me.body.email).toBe(aliceEmail);
      expect(me.body.pendingEmail).toBe(aliceNewEmail);

      // Audit : name immédiat + demande de changement séparées.
      const profAudit = await prisma.auditLog.findFirst({
        where: { action: 'auth.profile.update', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect((profAudit!.details as { fields?: string[] })?.fields).toEqual(['name']);
      const reqAudit = await prisma.auditLog.findFirst({
        where: { action: 'auth.email.change_requested', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect((reqAudit!.details as { newEmail?: string })?.newEmail).toBe(aliceNewEmail);
      expect(JSON.stringify(reqAudit)).not.toContain(aliceVerifyToken);
    });

    it("an address held by ANOTHER account → 409 before any verification mail", async () => {
      // aliceEmail appartient encore à alice : refus immédiat côté demande.
      await patchMe(bobToken, { email: aliceEmail }).expect(409);
      const bobDb = await prisma.user.findUniqueOrThrow({ where: { id: bobId } });
      expect(bobDb.email).toBe(bobEmail);
      expect(mailTransportStub.sendMail).not.toHaveBeenCalled();
    });

    it('GO Q3: an address only PENDING for someone else is still claimable — the constraint decides at confirm', async () => {
      // aliceNewEmail n'est encore le compte de PERSONNE (pas confirmé) :
      // la demande de Bob est acceptée, la course se joue à la confirmation.
      const res = await patchMe(bobToken, { email: aliceNewEmail }).expect(200);
      expect(res.body.email).toBe(bobEmail); // pas d'écriture immédiate
      expect(res.body.pendingEmail).toBe(aliceNewEmail);

      expect(mailTransportStub.sendMail).toHaveBeenCalledTimes(1);
      const call = mailTransportStub.sendMail.mock.calls[0][0] as { to?: string; text?: string };
      // Enveloppe : le mail part BIEN vers la nouvelle adresse (le corps ne la
      // contient pas — il ne parle que de l'adresse actuelle, anti-fuite).
      expect(call.to).toBe(aliceNewEmail);
      const text = String(call.text ?? '');
      expect(text).toContain('/auth/verifier-email?token=');
      bobVerifyToken = extractVerifyToken(text);
      expect(bobVerifyToken).toBeTruthy();

      const bobPending = await prisma.emailChangeToken.findMany({
        where: { userId: bobId, usedAt: null },
      });
      expect(bobPending).toHaveLength(1);
      expect(bobPending[0].newEmail).toBe(aliceNewEmail);
    });

    it('anonymous PATCH → 401; empty body → 400; bad email → 400', async () => {
      await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/users/me`)
        .send({ name: 'X' })
        .expect(401);

      const empty = await patchMe(aliceToken, {}).expect(400);
      expect(String(empty.body.message)).toContain('Aucun champ');

      await patchMe(aliceToken, { email: 'pas-un-email' }).expect(400);
    });

    it('requesting the CURRENT email again → no-op (no mail, no pending)', async () => {
      await patchMe(aliceToken, { email: aliceEmail }).expect(200);
      expect(mailTransportStub.sendMail).not.toHaveBeenCalled();
      const me = await getMe(aliceToken).expect(200);
      expect(me.body.pendingEmail).toBe(aliceNewEmail); // seule demande en vie, inchangée
    });
  });

  // ── D. POST /auth/confirm-email-change (GO Q3) ────────────────────────────
  describe('D. POST /auth/confirm-email-change (bascule atomique)', () => {
    it('valid token: email switched inside one transaction, pending cleared, audited', async () => {
      await confirmEmailChange(aliceVerifyToken).expect(201);

      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(dbUser.email).toBe(aliceNewEmail);
      const row = await prisma.emailChangeToken.findUniqueOrThrow({
        where: { tokenHash: sha256(aliceVerifyToken) },
      });
      expect(row.usedAt).not.toBeNull();

      const me = await getMe(aliceToken).expect(200); // ancien JWT : stateless, OK
      expect(me.body.email).toBe(aliceNewEmail);
      expect(me.body.pendingEmail).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.email.change_confirmed', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain(aliceVerifyToken);
    });

    it('second confirmation of the same token → the generic 400 (single-use CAS)', async () => {
      const res = await confirmEmailChange(aliceVerifyToken).expect(400);
      expect(res.body.message).toBe(GENERIC_EC_400);
      // L'email déjà basculé reste inchangé.
      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(dbUser.email).toBe(aliceNewEmail);
    });

    it('GO Q3: the address was taken meanwhile → 409 under constraint, tx rolled back', async () => {
      // aliceNewEmail appartient désormais à alice : la confirmation de Bob
      // échoue sur P2002 dans la transaction, qui se remplit entièrement
      // (le jeton de Bob n'est PAS consommé — rollback).
      const res = await confirmEmailChange(bobVerifyToken).expect(409);
      expect(String(res.body.message)).toContain('existe déjà');

      const bobDb = await prisma.user.findUniqueOrThrow({ where: { id: bobId } });
      expect(bobDb.email).toBe(bobEmail);
      const bobRow = await prisma.emailChangeToken.findUniqueOrThrow({
        where: { tokenHash: sha256(bobVerifyToken) },
      });
      expect(bobRow.usedAt).toBeNull(); // rollback complet
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.email.change_confirmed', actorId: bobId },
      });
      expect(audit).toBeNull();
    });

    it('unknown token → 400 (same generic message)', async () => {
      const res = await confirmEmailChange(`jamais-emis-${uid}`).expect(400);
      expect(res.body.message).toBe(GENERIC_EC_400);
    });

    it('login works with the NEW email, old email refused (same password)', async () => {
      await login(aliceEmail, newPassword).expect(401);
      const res = await login(aliceNewEmail, newPassword).expect(201);
      expect(res.body.accessToken).toBeTruthy();
    });
  });

  // ── E. impersonation = lecture seule ──────────────────────────────────────
  describe("E. session d'impersonation sur PATCH /users/me", () => {
    it('admin "as client" can read (200) but not write (403)', async () => {
      adminToken = (await login(adminEmail, password).expect(201)).body.accessToken as string;
      const imp = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/${aliceId}/impersonate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      const impToken = imp.body.accessToken as string;
      expect(impToken).toBeTruthy();

      await getMe(impToken).expect(200); // lecture OK
      const res = await patchMe(impToken, { name: 'Hacker' }).expect(403);
      expect(String(res.body.message ?? '')).toContain('lecture seule');

      // Le profil n'a pas bougé.
      const me = await getMe(aliceToken).expect(200);
      expect(me.body.name).toBe('Alice Renommée');
    });
  });

  // ── F. sessions (GO Q3) : rotation, logout, changePassword, isActive ──────
  describe('F. sessions — rotation concurrente, logout, changePassword, isActive', () => {
    const charlieEmail = `charlie_${stamp}@example.com`;
    const charliePw = 'Charlie-Mdp-2026';
    let charlieId = '';

    beforeAll(async () => {
      const hash = await bcrypt.hash(password, 10);
      charlieId = (
        await prisma.user.create({
          data: { email: charlieEmail, name: 'Charlie P3', role: Role.USER, passwordHash: hash },
        })
      ).id;
    });

    afterAll(async () => {
      await prisma.refreshToken.deleteMany({ where: { userId: charlieId } }).catch(() => {});
      await prisma.user.delete({ where: { id: charlieId } }).catch(() => {});
    });

    it('double-refresh concurrent: rotation tolerated, the row is revoked exactly once', async () => {
      const loginRes = await login(charlieEmail, password).expect(201);
      const cookie = cookieOf(loginRes);
      const access = loginRes.body.accessToken as string;
      const rowA = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: charlieId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      // Deux renouvellements simultanés du MÊME cookie : aucun 500, aucun 401
      // (fenêtre de rejeu 10 s) — la rotation CAS ne révoque qu'une fois.
      const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
      expect([a.status, b.status].sort()).toEqual([201, 201]);

      const rowAfter = await prisma.refreshToken.findUniqueOrThrow({ where: { id: rowA.id } });
      expect(rowAfter.revokedAt).not.toBeNull();
      expect(
        await prisma.refreshToken.count({ where: { userId: charlieId, revokedAt: null } }),
      ).toBeGreaterThanOrEqual(1);
      expect(access).toBeTruthy();
    });

    it('logout DELETES the row: refresh 401 even inside the 10 s reuse window', async () => {
      const loginRes = await login(charlieEmail, password).expect(201);
      const cookie = cookieOf(loginRes);
      const access = loginRes.body.accessToken as string;
      const rowBefore = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: charlieId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      await logout(cookie).expect(201);
      // Supprimée, pas révoquée : la fenêtre de rejeu ne voit rien à ressusciter.
      expect(await prisma.refreshToken.findUnique({ where: { id: rowBefore.id } })).toBeNull();
      await refresh(cookie).expect(401); // immédiatement, bien avant 10 s

      // Access token stateless (documenté) : encore valable ≤ jwtExpiresIn.
      const me = await getMe(access).expect(200);
      expect(me.body.id).toBe(charlieId);
    });

    it('changePassword destroys EVERY active session of the account', async () => {
      const loginRes = await login(charlieEmail, password).expect(201);
      const cookie = cookieOf(loginRes);

      await changePw(loginRes.body.accessToken as string, {
        currentPassword: password,
        newPassword: charliePw,
      }).expect(201);

      await refresh(cookie).expect(401);
      expect(
        await prisma.refreshToken.count({ where: { userId: charlieId, revokedAt: null } }),
      ).toBe(0);
      await login(charlieEmail, password).expect(401);
      await login(charlieEmail, charliePw).expect(201);

      // Restauration du mot de passe d'origine pour la suite.
      const newLogin = await login(charlieEmail, charliePw).expect(201);
      await changePw(newLogin.body.accessToken as string, {
        currentPassword: charliePw,
        newPassword: password,
      }).expect(201);
    });

    it('isActive=false blocks refresh (admin kill-switch), reactivation restores it', async () => {
      const loginRes = await login(charlieEmail, password).expect(201);
      const cookie = cookieOf(loginRes);

      await patchUser(adminToken, charlieId, { isActive: false }).expect(200);
      await refresh(cookie).expect(401); // la ligne est encore active, le compte ne l'est plus

      await patchUser(adminToken, charlieId, { isActive: true }).expect(200);
      await refresh(cookie).expect(201); // réactivé : la même session repart
    });
  });

  // ── G. propriété des dossiers (GO Q3) ─────────────────────────────────────
  describe('G. deux comptes, dossiers invités, ancien JWT, ownedBy/ensureOwnedCustomer', () => {
    const eveOld = `eve_old_${stamp}@example.com`;
    const eveNew = `eve_new_${stamp}@example.com`;
    const concEmail = `conc_${stamp}@example.com`;
    const guestAtOldAlice = `guestold_${stamp}@guest.example.com`;

    it('ensureOwnedCustomer: stale JWT uses the CURRENT DB identity (no folder theft, no duplicate)', async () => {
      const hash = await bcrypt.hash(password, 10);
      const eve = await prisma.user.create({
        data: { email: eveOld, name: 'Eve P3', role: Role.USER, passwordHash: hash },
      });
      const eveLogin = await login(eveOld, password).expect(201);
      const eveJwt = eveLogin.body.accessToken as string; // claim = eveOld (périmé après suite)

      // Changement d'email confirmé « entre-temps » : la DB passe à eveNew,
      // le JWT émis plus tôt porte encore eveOld.
      await prisma.user.update({ where: { id: eve.id }, data: { email: eveNew } });
      // Un dossier invité existe déjà à la NOUVELLE adresse (rattachable).
      await prisma.customer.create({
        data: { email: eveNew, name: 'Invité Eve', userId: null },
      });

      const res = await getWallet(eveJwt).expect(200);
      // L'identité DB l'emporte sur le claim périmé : dossier invité rattaché…
      expect(res.body.customerEmail).toBe(eveNew);
      const guest = await prisma.customer.findUniqueOrThrow({ where: { email: eveNew } });
      expect(guest.userId).toBe(eve.id);
      // …et AUCUN second dossier créé sous l'email périmé du JWT.
      expect(await prisma.customer.findUnique({ where: { email: eveOld } })).toBeNull();

      await prisma.user.delete({ where: { id: eve.id } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { email: eveNew } }).catch(() => {});
    });

    it('two CONCURRENT wallet fetches of a fresh account → exactly ONE folder', async () => {
      const hash = await bcrypt.hash(password, 10);
      const conc = await prisma.user.create({
        data: { email: concEmail, name: 'Conc P3', role: Role.USER, passwordHash: hash },
      });
      const tok = (await login(concEmail, password).expect(201)).body.accessToken as string;

      const [w1, w2] = await Promise.all([getWallet(tok), getWallet(tok)]);
      expect(w1.status).toBe(200);
      expect(w2.status).toBe(200);
      expect(
        await prisma.customer.count({ where: { userId: conc.id } }),
      ).toBe(1); // jamais deux dossiers concurrents

      await prisma.user.delete({ where: { id: conc.id } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { userId: conc.id } }).catch(() => {});
    });

    it('ownedBy: an email NEVER opens a folder linked to ANOTHER account (linked vs guest)', async () => {
      const prod = await prisma.product.create({
        data: { name: `GO-ownership-${uid}` },
      });
      // Dossier LIÉ à Bob mais portant l'ancien email d'Alice : seul Bob doit
      // le voir (régression ownedBy — l'email seul n'ouvre jamais un dossier lié).
      const linkedToBob = await prisma.customer.create({
        data: { email: aliceEmail, name: 'Dossier Bob @ ancien Alice', userId: bobId },
      });
      // Dossier INVITÉ non rattaché à l'adresse de Bob : Bob le voit aussi
      // (branche guest bornée à userId null).
      const guest = await prisma.customer.create({
        data: { email: bobEmail, name: 'Invité Bob', userId: null },
      });
      for (const [cust, label] of [
        [linkedToBob, 'lié'],
        [guest, 'invité'],
      ] as const) {
        await prisma.order.create({
          data: {
            customerId: cust.id,
            customerName: label,
            customerEmail: cust.email,
            productId: prod.id,
            productName: 'GO ownership',
            amountHtCents: 1000,
            taxAmountCents: 200,
            amountTtcCents: 1200,
          },
        });
      }

      // Alice (ancien JWT, claim = aliceEmail) : 0 commande — son email ne
      // lui donne PAS le dossier lié à Bob (avant fix : total = 1).
      const aliceOldJwt = aliceToken; // jamais ré-émis depuis : claims périmés
      const aliceOrders = await listOrders(aliceOldJwt).expect(200);
      expect(aliceOrders.body.total).toBe(0);

      // Nouveau JWT d'Alice (claim = nouvel email) : toujours 0 (son dossier
      // n'a pas de commande).
      const aliceFresh = (await login(aliceNewEmail, newPassword).expect(201)).body
        .accessToken as string;
      const aliceFreshOrders = await listOrders(aliceFresh).expect(200);
      expect(aliceFreshOrders.body.total).toBe(0);

      // Bob voit les DEUX : le sien (lié) + l'invité à son email.
      const bobOrders = await listOrders(bobToken).expect(200);
      expect(bobOrders.body.total).toBe(2);

      // Nettoyage local de la section.
      await prisma.customer.deleteMany({
        where: { id: { in: [linkedToBob.id, guest.id] } },
      });
      await prisma.product.delete({ where: { id: prod.id } });
    });

    it('ensureOwnedCustomer on Alice: folder bound to her CURRENT account, guest at old email untouched', async () => {
      // Dossier invité à l'ancien email d'Alice (userId null).
      await prisma.customer.create({
        data: { email: guestAtOldAlice, name: 'Invité ancien Alice', userId: null },
      });

      const res = await getWallet(aliceToken).expect(200);
      expect(res.body.customerEmail).toBe(aliceNewEmail);
      const db = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      expect(db.email).toBe(aliceNewEmail);

      // Le dossier invité de l'adresse périmée n'a pas été réutilisé : il lui
      // fallait l'identité ACTUELLE (aliceNewEmail), pas le claim du JWT.
      const aliceCustomers = await prisma.customer.findMany({ where: { userId: aliceId } });
      expect(aliceCustomers).toHaveLength(1);
      expect(aliceCustomers[0].email).toBe(aliceNewEmail);
      const oldGuest = await prisma.customer.findUnique({
        where: { email: guestAtOldAlice },
      });
      expect(oldGuest?.userId).toBeNull(); // jamais détourné sous claim périmé
      await prisma.customer.deleteMany({ where: { email: guestAtOldAlice } });
    });
  });

  // ── H. demande de clôture de compte (GO Q3) ───────────────────────────────
  describe('H. demande de clôture de compte (aucune suppression financière)', () => {
    it('open → PENDING (idempotent), GET exposes it, nothing financial touched', async () => {
      const ordersBefore = await prisma.order.count();
      const invoicesBefore = await prisma.invoice.count();
      const txsBefore = await prisma.walletTransaction.count();

      const nullRes = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      // `null` sérialisé en corps vide (jamais `{}` ni `null` littéral).
      expect(nullRes.text).toBe('');

      const res = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ reason: '  je pars  ' })
        .expect(201);
      expect(res.body.status).toBe(ClosureRequestStatus.PENDING);
      expect(res.body.reason).toBe('je pars');

      // Idempotent : une seule demande en attente par compte.
      const again = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ reason: 'autre' })
        .expect(201);
      expect(again.body.id).toBe(res.body.id);
      expect(again.body.status).toBe(ClosureRequestStatus.PENDING);

      const get = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(get.body.id).toBe(res.body.id);

      // AUCUNE suppression automatique : les pièces financières restent.
      expect(await prisma.order.count()).toBe(ordersBefore);
      expect(await prisma.invoice.count()).toBe(invoicesBefore);
      expect(await prisma.walletTransaction.count()).toBe(txsBefore);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'account.closure_requested', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect((audit!.details as { reason?: string })?.reason).toBe('je pars');
    });

    it('cancel → CANCELLED, reopen → same row PENDING again', async () => {
      const cancel = await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(cancel.body.status).toBe(ClosureRequestStatus.CANCELLED);

      // Plus de demande en attente → 404 sur une nouvelle annulation.
      await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(404);

      const reopen = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ reason: 'réouverture' })
        .expect(201);
      expect(reopen.body.status).toBe(ClosureRequestStatus.PENDING);
      expect(reopen.body.id).toBe(cancel.body.id); // même ligne, contrat @@unique
    });

    it('RBAC: regular client cannot list closure requests (403), admin can', async () => {
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/closure-requests`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(403);

      const list = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/closure-requests`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const row = (list.body as { userId: string }[]).find((r) => r.userId === aliceId);
      expect(row).toBeTruthy();
    });

    it('admin resolves PENDING → COMPLETED; further resolve/reopen → 409; finances still intact', async () => {
      const ordersBefore = await prisma.order.count();
      const invoicesBefore = await prisma.invoice.count();
      const txsBefore = await prisma.walletTransaction.count();

      const pending = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/users/closure-requests`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const target = (list.body as { id: string }[]).find((r) => r.id === pending.body.id);
      expect(target).toBeTruthy();

      const done = await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/users/closure-requests/${pending.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ClosureRequestStatus.COMPLETED, note: 'traité manuellement' })
        .expect(200);
      expect(done.body.status).toBe(ClosureRequestStatus.COMPLETED);
      expect(done.body.resolvedById).toBeTruthy();

      // Déjà traitée → 409 (ni double résolution, ni réouverture).
      await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/users/closure-requests/${pending.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ClosureRequestStatus.CANCELLED })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/me/closure-request`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({})
        .expect(409);

      // RBAC sur l'écriture admin.
      await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/users/closure-requests/${pending.body.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ status: ClosureRequestStatus.CANCELLED })
        .expect(403);

      // Aucune pièce financière supprimée par le parcours complet.
      expect(await prisma.order.count()).toBe(ordersBefore);
      expect(await prisma.invoice.count()).toBe(invoicesBefore);
      expect(await prisma.walletTransaction.count()).toBe(txsBefore);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'account.closure_resolved', actorId: adminId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
    });
  });
});
