import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { AppModule } from './../src/app.module';
import { GlobalPrefix } from './../src/config/constants';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns 200 with status ok (DB reachable)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/health`)
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('ok');
  });
});