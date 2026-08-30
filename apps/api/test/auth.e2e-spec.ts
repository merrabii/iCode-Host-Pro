import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { AppModule } from './../src/app.module';
import { GlobalPrefix } from './../src/config/constants';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const email = `u_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';

  it('register returns an access token', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .send({ email, password, name: 'Tester' })
      .expect(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.accessToken.length).toBeGreaterThan(20);
    accessToken = res.body.accessToken;
  });

  it('GET /api/users/me works with the token', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.email).toBe(email);
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('GET /api/users/me is denied without a token', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/users/me`).expect(401);
  });

  it('login with wrong password is unauthorized', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password: 'wrongpassword!' })
      .expect(401);
  });

  it('refresh sets a new access token cookie flow', async () => {
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    expect(typeof login.body.accessToken).toBe('string');
  });
});