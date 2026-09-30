import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logger/json-logger.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validateEnv } from './config/env.validation';

async function bootstrap(): Promise<void> {
  // Fail fast on bad config before anything else boots.
  validateEnv(process.env as Record<string, unknown>);

  const logger = new JsonLogger();
  const app = await NestFactory.create(AppModule, {
    logger,
    rawBody: true, // webhook signature verification needs the raw body
  });

  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',').map((s) => s.trim()),
    credentials: true,
  });

  // Global prefix is 'api'; URI versioning appends the version, so production
  // routes are /api/v1/... (matching the documented contract). /health and
  // /ready stay at the root (also VERSION_NEUTRAL, see HealthController).
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`ZenSkil Hub backend listening on :${port}`, 'Bootstrap');
}

void bootstrap();
