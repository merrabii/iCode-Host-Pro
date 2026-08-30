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
    .setTitle('iCode Host Pro API')
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
  console.log(`iCode Host Pro API listening on http://localhost:${port}/${GlobalPrefix}`);
  console.log(`OpenAPI docs on http://localhost:${port}/${GlobalPrefix}/docs`);
}

void bootstrap();