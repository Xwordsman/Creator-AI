import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { ErrorFilter, type AuthRequest } from './common/http';
import type { Environment } from './config/environment';

export async function bootstrapApi(port?: number) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: true }),
    bodyParser: false,
  });
  const env = app.get<Environment>('ENV');
  app.use(helmet());
  app.use((req: AuthRequest, res: import('express').Response, next: () => void) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Account references and content definitions need more space than ordinary requests.
  app.use(
    ['/api/v1/accounts', '/api/v1/experts', '/api/v1/skills', '/api/v1/contents'],
    json({ limit: '2mb' }),
  );
  app.useBodyParser('json', { limit: '64kb' });
  app.useBodyParser('raw', { type: 'application/zip', limit: '2mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  await app.listen(port ?? env.port, env.bindHost);
  return app;
}

if (require.main === module)
  void bootstrapApi().catch(() => {
    console.error('API startup failed. Check environment, migrations and service connectivity.');
    process.exitCode = 1;
  });
