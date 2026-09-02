import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role, TicketStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 10 (ADR-027): minimal tickets. A client opens a ticket; L1 replies +
// escalates to L2/L3; access is owner-or-support (roleRank). A non-owner USER
// gets 403; escalation/status are L1+; CLOSED is refused in favor of RESOLVED.
describe('Support tickets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const clientEmail = `tktclient_${stamp}@example.com`;
  const otherEmail = `tktohter_${stamp}@example.com`;
  const l1Email = `tktl1_${stamp}@example.com`;
  const l2Email = `tktl2_${stamp}@example.com`;
  const password = 'password123';
  let clientToken = '';
  let otherToken = '';
  let l1Token = '';
  let l2Token = '';
  let ticketId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    for (const [email, role] of [
      [clientEmail, Role.USER],
      [otherEmail, Role.USER],
      [l1Email, Role.SUPPORT_L1],
      [l2Email, Role.SUPPORT_L2],
    ] as const) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role },
      });
    }
    clientToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientEmail, password })
        .expect(201)
    ).body.accessToken as string;
    otherToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: otherEmail, password })
        .expect(201)
    ).body.accessToken as string;
    l1Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: l1Email, password })
        .expect(201)
    ).body.accessToken as string;
    l2Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: l2Email, password })
        .expect(201)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    // Deleting users cascades tickets and messages.
    await prisma.user
      .deleteMany({ where: { email: { in: [clientEmail, otherEmail, l1Email, l2Email] } } })
      .catch(() => {});
    await app.close();
  });

  it('client opens a ticket → OPEN with the first message', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ subject: 'Impossible de me connecter', body: 'Depuis ce matin mon accès renvoie une erreur.' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe(TicketStatus.OPEN);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toContain('erreur');
    ticketId = res.body.id as string;
  });

  it('client lists own tickets — the ticket is there', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/tickets`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    expect(list.body.some((t: { id: string }) => t.id === ticketId)).toBe(true);
  });

  it('another USER cannot read the ticket (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });

  it('L1 can read the ticket and reply (support access)', async () => {
    const read = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${l1Token}`)
      .expect(200);
    expect(read.body.userId).toBeTruthy();

    const reply = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ body: 'Nous investiguons, merci de patienter.' })
      .expect(201);
    expect(reply.body.body).toContain('investiguons');
  });

  it('the owner can add a message too', async () => {
    const reply = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ body: 'Merci, je reste dispo.' })
      .expect(201);
    expect(reply.body.body).toContain('dispo');
  });

  it('L1 escalates to SUPPORT_L2 (and cannot escalate to an equal/lower rank)', async () => {
    const escalated = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets/${ticketId}/escalate`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ to: Role.SUPPORT_L2 })
      .expect(201);
    expect(escalated.body.escalatedTo).toBe(Role.SUPPORT_L2);
    expect(escalated.body.escalatedAt).toBeTruthy();

    // SUPPORT_L1 is not a valid DTO target → validation 400.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets/${ticketId}/escalate`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ to: Role.SUPPORT_L1 })
      .expect(400);
  });

  it('L1 updates the status (IN_PROGRESS ok, CLOSED refused)', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ status: TicketStatus.IN_PROGRESS })
      .expect(200);
    expect(updated.body.status).toBe(TicketStatus.IN_PROGRESS);

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ status: TicketStatus.CLOSED })
      .expect(400);
  });

  it('L2 can see the escalated ticket in the support queue', async () => {
    const queue = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/support/tickets`)
      .set('Authorization', `Bearer ${l2Token}`)
      .expect(200);
    const found = queue.body.find((t: { id: string }) => t.id === ticketId);
    expect(found).toBeTruthy();
    expect(found.escalatedTo).toBe(Role.SUPPORT_L2);
  });

  it('a plain USER cannot escalate or change status (403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/tickets/${ticketId}/escalate`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ to: Role.SUPPORT_L2 })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ status: TicketStatus.RESOLVED })
      .expect(403);
  });
});
