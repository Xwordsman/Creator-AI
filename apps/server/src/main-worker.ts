import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createServer } from 'node:http';
import { InfrastructureModule } from './infrastructure.module';
import type { Environment } from './config/environment';
import { MockTextProvider } from './modules/models/mock-provider';
import { TaskRunner } from './modules/tasks/task-runner';
import { OutboxDispatcher, QUEUE_NAME } from './modules/tasks/outbox-dispatcher';
import { assertDatabaseReady } from './database/readiness';

async function bootstrapWorker() {
  const app = await NestFactory.createApplicationContext(InfrastructureModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  const env = app.get<Environment>('ENV');
  const db = app.get(DataSource);
  const redis = app.get(Redis);
  const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => undefined);
  const queue = new Queue(QUEUE_NAME, { connection: redis });
  const runner = new TaskRunner(db, new MockTextProvider());
  const logger = new Logger('Worker');
  const worker = new Worker<{ runId: string }>(
    QUEUE_NAME,
    (job) => runner.execute(job.data.runId),
    { connection, concurrency: 2 },
  );
  worker.on('error', () => logger.error({ event: 'worker.error' }));
  worker.on('failed', (job) => logger.warn({ event: 'job.failed', runId: job?.data.runId }));
  const dispatcher = new OutboxDispatcher(db, queue);
  await worker.waitUntilReady();
  dispatcher.start();
  const health = createServer((_req, res) => {
    void Promise.all([assertDatabaseReady(db), redis.ping()])
      .then(() => {
        res.writeHead(worker.isRunning() ? 200 : 503).end('ready');
      })
      .catch(() => res.writeHead(503).end('unavailable'));
  }).listen(3001, env.bindHost);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    health.close();
    await dispatcher.stop();
    await worker.close();
    await queue.close();
    connection.disconnect();
    await app.close();
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}

void bootstrapWorker().catch(() => {
  console.error('Worker startup failed. Check environment, migrations and service connectivity.');
  process.exitCode = 1;
});
