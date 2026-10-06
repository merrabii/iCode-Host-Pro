import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { Role, User } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { AuthService } from './../src/auth/auth.service';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';

jest.setTimeout(90_000);

/**
 * GO corr. finales P1 — **sérialisation réelle** rotation / révocation sous
 * PostgreSQL (Prisma RÉEL, aucun mock) :
 *
 * La barrière commune est le verrou `SELECT … FOR UPDATE` sur la ligne `User`
 * (identité durable), prise par TOUS les flux avant toute écriture refresh.
 * Sans elle, le `DELETE` d'un logout en cours ne voit pas le successeur inséré
 * par une rotation concurrente (snapshot READ COMMITTED) : le token survit à la
 * révocation. Les scénarios ci-dessous reproduisent les deux ordres d'exécution
 * (rotation d'abord / révocation d'abord) pour logout, reset et changePassword,
 * en prouvant que l'attaquant ATTEND réellement sur la barrière (`done === false`
 * pendant le verrou tenu par une transaction externe), puis vérifient l'invariant
 * « aucun token de la session n'est utilisable ».
 *
 * Le double-refresh légitime (fenêtre de rejeu 10 s) reste servi (T5), et la
 * durée résiduelle des access tokens stateless (15 min) est documentée dans
 * `auth.service.ts` — non révoqués par logout/reset (test existant A1/F).
 */
describe('Refresh tokens — barrière User : rotation et révocation sérialisées (GO corr. finales P1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const password = 'password123';
  const newPassword = 'Nouveau-Mdp-2026';

  const createdUserIds: string[] = [];

  const mailFactoryStub = { create: jest.fn().mockReturnValue({ sendMail: jest.fn().mockResolvedValue(undefined) }) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Track settlement WITHOUT awaiting (preuve « l'opération ATTEND »). */
  function track<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    p.then(
      (v) => {
        state.done = true;
        state.value = v;
      },
      (e) => {
        state.done = true;
        state.error = e;
      },
    );
    return state;
  }

  async function newUser(seed: string): Promise<User> {
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email: `${seed}_${stamp}@example.com`, name: `P1 ${seed}`, role: Role.USER, passwordHash: hash },
    });
    createdUserIds.push(user.id);
    return user;
  }

  /** New session (login-equivalent) → refresh raw + famille dédiée. */
  async function newSession(user: User): Promise<string> {
    const tokens = await auth.issueTokens(user);
    return tokens.refreshToken;
  }

  /** Hold the User-row barrier from an OUTSIDE transaction (durée ms). */
  function holdBarrier(userId: string, ms: number): Promise<void> {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      await sleep(ms);
    });
  }

  async function rowsOf(userId: string): Promise<{ tokenHash: string; sessionId: string | null }[]> {
    return prisma.refreshToken.findMany({ where: { userId }, select: { tokenHash: true, sessionId: true } });
  }

  /** Invariant central : aucun token de l'utilisateur n'est (encore) utilisable. */
  async function expectNoUsableToken(userId: string, ...raws: (string | undefined)[]): Promise<void> {
    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(0);
    for (const raw of raws) {
      if (!raw) continue;
      await expect(auth.refresh(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  }

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
    auth = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    if (createdUserIds.length) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  // ── T1 : schedule du GO — rotation en file, logout derrière ────────────────
  it('rotation commencée → logout ATTEND sur la barrière → détruit tout : zéro survivant', async () => {
    const u = await newUser('p1t1');
    const raw1 = await newSession(u);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250); // verrou acquis par la transaction externe

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(400);
    expect(rot.done).toBe(false); // la rotation ATTEND réellement sur la barrière User

    const loP = auth.logout(raw1);
    const lo = track(loP);
    await sleep(300);
    expect(lo.done).toBe(false); // le logout ATTEND derrière la rotation

    await Promise.allSettled([hold, rotP, loP]);

    // Invariant : la famille entière (successeur compris) est détruite.
    await expectNoUsableToken(u.id, raw1, rot.value, rot.error ? undefined : rot.value);
    expect(lo.error).toBeUndefined(); // logout toujours idempotent-réussi
  });

  // ── T2 : ordre inverse — logout en file, rotation derrière ─────────────────
  it('logout d’abord → rotation perd sur la barrière → 401, aucune écriture', async () => {
    const u = await newUser('p1t2');
    const raw1 = await newSession(u);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250);

    const loP = auth.logout(raw1);
    const lo = track(loP);
    await sleep(400);
    expect(lo.done).toBe(false); // logout ATTEND (verrou externe tenu)

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(300);
    expect(rot.done).toBe(false); // rotation ATTEND aussi (derrière le logout)

    await Promise.allSettled([hold, loP, rotP]);

    expect(lo.error).toBeUndefined();
    await expectNoUsableToken(u.id, raw1, rot.value);
  });

  // ── T3 : reset de mot de passe concurrent — les deux ordres ────────────────
  async function makeResetToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({
      data: { tokenHash: sha256(raw), userId, expiresAt: new Date(Date.now() + 600_000) },
    });
    return raw;
  }

  it('reset concurrent (rotation d’abord) → la révocation attend puis détruit tout', async () => {
    const u = await newUser('p1t3a');
    const raw1 = await newSession(u);
    const resetRaw = await makeResetToken(u.id);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250);

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(400);
    expect(rot.done).toBe(false); // rotation en attente sur la barrière

    const resetP = auth.resetPassword(resetRaw, newPassword);
    const reset = track(resetP);
    await sleep(300);
    expect(reset.done).toBe(false); // reset ATTEND derrière la rotation

    await Promise.allSettled([hold, rotP, resetP]);

    expect(reset.error).toBeUndefined();
    // TOUTES les lignes de l'utilisateur (toutes familles) détruites.
    await expectNoUsableToken(u.id, raw1, rot.value);
    // Le nouveau mot de passe est bien appliqué (révocation effective).
    await expect(bcrypt.compare(newPassword, (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash)).resolves.toBe(true);
  });

  it('reset concurrent (reset d’abord) → la rotation perd, aucune ressurrection', async () => {
    const u = await newUser('p1t3b');
    const raw1 = await newSession(u);
    const resetRaw = await makeResetToken(u.id);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250);

    const resetP = auth.resetPassword(resetRaw, newPassword);
    const reset = track(resetP);
    await sleep(400);
    expect(reset.done).toBe(false); // reset en attente (bcrypt ~100 ms passé, verrou tenu)

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(300);
    expect(rot.done).toBe(false); // rotation ATTEND

    await Promise.allSettled([hold, resetP, rotP]);

    expect(reset.error).toBeUndefined();
    await expectNoUsableToken(u.id, raw1, rot.value);
  });

  // ── T4 : changement de mot de passe concurrent — les deux ordres ───────────
  it('changePassword concurrent (rotation d’abord) → révocation attend puis détruit tout', async () => {
    const u = await newUser('p1t4a');
    const raw1 = await newSession(u);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250);

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(400);
    expect(rot.done).toBe(false);

    const cpP = auth.changePassword(u.id, password, newPassword);
    const cp = track(cpP);
    await sleep(300);
    expect(cp.done).toBe(false); // changePassword ATTEND derrière la rotation

    await Promise.allSettled([hold, rotP, cpP]);

    expect(cp.error).toBeUndefined();
    await expectNoUsableToken(u.id, raw1, rot.value);
  });

  it('changePassword concurrent (changePassword d’abord) → la rotation perd, aucune ressurrection', async () => {
    const u = await newUser('p1t4b');
    const raw1 = await newSession(u);

    const hold = holdBarrier(u.id, 1500);
    await sleep(250);

    const cpP = auth.changePassword(u.id, password, newPassword);
    const cp = track(cpP);
    await sleep(400);
    expect(cp.done).toBe(false);

    const rotP = auth.refresh(raw1).then((t) => t.refreshToken);
    const rot = track(rotP);
    await sleep(300);
    expect(rot.done).toBe(false);

    await Promise.allSettled([hold, cpP, rotP]);

    expect(cp.error).toBeUndefined();
    await expectNoUsableToken(u.id, raw1, rot.value);
  });

  // ── T5 : le double-refresh LÉGITIME reste servi (fenêtre de rejeu 10 s) ────
  it('double-refresh légitime : les deux émissions vivent dans la même famille, logout coupe tout', async () => {
    const u = await newUser('p1t5');
    const raw1 = await newSession(u);

    // Rotation 1 : rotation normale.
    const t2 = await auth.refresh(raw1);
    // Rejeu (2ᵉ appel avec l'ancien jeton < 10 s) : ré-émission dans la famille.
    const t3 = await auth.refresh(raw1);
    expect(t2.refreshToken).not.toEqual(raw1);
    expect(t3.refreshToken).not.toEqual(raw1);
    expect(t3.refreshToken).not.toEqual(t2.refreshToken);

    // La famille reste vivante : le successeur de la rotation 1 est utilisable.
    const t4 = await auth.refresh(t2.refreshToken);
    expect(t4.refreshToken).toBeTruthy();

    // Un logout sur n'importe quel membre détruit la famille entière.
    await auth.logout(t3.refreshToken);
    await expectNoUsableToken(u.id, raw1, t2.refreshToken, t3.refreshToken, t4.refreshToken);
  });
});
