import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { createHash } from 'crypto';
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';

/**
 * P3 — Compte client (e2e, GO socle lot A1) : reset de mot de passe + édition
 * de profil sur la base dédiée du chantier.
 *
 *  A. forgot-password : anti-énumération (réponse identique connu/inconnu,
 *     aucun mail ni jeton pour un compte inexistant), jeton sha256 seul au
 *     repos, liens précédents supprimés, rate-limit 5/min.
 *  B. reset-password : parcours complet (mail → lien → nouveau mdp), usage
 *     unique, 400 générique unique inconnu/utilisé/expiré, mdp trop court
 *     AVANT de brûler le jeton, sessions détruites (refresh cookie mort),
 *     ancien mdp refusé / nouveau accepté, audit sans secrets.
 *  C. PATCH /users/me : isolation stricte par JWT, trim, 409 email pris,
 *     401 anonyme, 400 corps vide, audit des champs.
 *  D. session d'impersonation = lecture seule sur PATCH /users/me (403).
 *
 * Coutures (AUCUN réseau réel) : MailTransportFactory stubbé (emails capturés),
 * PanelTransportFactory stubbé. PrismaService RÉEL — base dédiée du chantier.
 */
describe('Compte client — reset mdp + profil (e2e, P3 / lot A1)', () => {
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
  let aliceToken = '';
  let bobToken = '';
  let adminToken = '';
  let aliceResetToken = '';
  let aliceRefreshCookie = '';
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
    await prisma.refreshToken.deleteMany({ where: { userId: { in: [aliceId, bobId] } } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [aliceEmail, aliceNewEmail, bobEmail, adminEmail] } } })
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

  // ── C. PATCH /users/me ────────────────────────────────────────────────────
  describe('C. PATCH /users/me (édition profil, isolation par JWT)', () => {
    it('updates my own name + email (trimmed), never leaks secrets', async () => {
      const res = await patchMe(aliceToken, {
        name: '  Alice Renommée  ',
        email: aliceNewEmail,
      }).expect(200);
      expect(res.body.name).toBe('Alice Renommée');
      expect(res.body.email).toBe(aliceNewEmail);
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('mfaSecretEnc');
      expect(res.body).not.toHaveProperty('githubTokenEnc');

      const me = await getMe(aliceToken).expect(200);
      expect(me.body.name).toBe('Alice Renommée');
      expect(me.body.email).toBe(aliceNewEmail);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.profile.update', actorId: aliceId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect((audit!.details as { fields?: string[] })?.fields).toEqual(['name', 'email']);
    });

    it("another account cannot steal the new email (409) and Bob stays untouched", async () => {
      await patchMe(bobToken, { email: aliceNewEmail }).expect(409);

      const bob = await getMe(bobToken).expect(200);
      expect(bob.body.email).toBe(bobEmail);
      expect(bob.body.name).toBe('Bob P3');
      expect(bob.body.id).toBe(bobId);
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

    it('login works with the NEW email afterwards (same password)', async () => {
      const res = await login(aliceNewEmail, newPassword).expect(201);
      expect(res.body.accessToken).toBeTruthy();
    });
  });

  // ── D. impersonation = lecture seule ──────────────────────────────────────
  describe("D. session d'impersonation sur PATCH /users/me", () => {
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
});
