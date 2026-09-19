import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalPrefix } from './config/constants';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Trust proxy (Express) — parseTrustProxy : false par défaut. Un avertissement
  // au boot rend visible une configuration active ou des entrées rejetées.
  const trustProxy = config.get<boolean | string[]>('trustProxy') ?? false;
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  if (trustProxy === false) {
    console.log('Trust proxy: désactivé (défaut) — X-Forwarded-For ignoré, req.ip = adresse socket.');
  } else {
    console.log(`Trust proxy: pairs approuvés = ${(trustProxy as string[]).join(', ')}.`);
  }

  // Versioned REST prefix (ADR-005).
  app.setGlobalPrefix(GlobalPrefix);

  // Development CORS: allow the web app origin. Tighten before production.
  const webOrigin = config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000';
  app.enableCors({ origin: webOrigin, credentials: true });

  // DTO validation with unknown-property stripping (Phase 1).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Refresh token httpOnly cookie parsing.
  app.use(cookieParser());

  // OpenAPI contract (ADR-005) + Bearer auth scheme (ADR-015).
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Code Diali API')
    .setDescription('Control plane REST contract — Phase 1')
    .setVersion('0.1.0')
    .addTag('auth')
    .addTag('users')
    .addTag('health')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${GlobalPrefix}/docs`, app, document);

  const port = config.getOrThrow<number>('port');
  await app.listen(port);
  console.log(`Code Diali API listening on http://localhost:${port}/${GlobalPrefix}`);
  console.log(`OpenAPI docs on http://localhost:${port}/${GlobalPrefix}/docs`);
}

void bootstrap();
