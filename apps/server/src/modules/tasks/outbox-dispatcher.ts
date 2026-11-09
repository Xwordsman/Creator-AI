import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { OutboxEntity } from '../../database/entities';

export const QUEUE_NAME = 'creator-runs';

export class OutboxDispatcher {
  private stopped = false;
  private loop?: Promise<void>;
  private readonly logger = new Logger(OutboxDispatcher.name);
  constructor(
    private readonly db: DataSource,
    private readonly queue: Queue,
  ) {}

  async dispatch(): Promise<number> {
    return this.db.transaction(async (em) => {
      const rows: { run_id: string; sequence: number }[] = await em.query(`
        SELECT o.run_id, o.sequence FROM task_outbox o
        JOIN creation_runs r ON r.id = o.run_id
        WHERE (r.status = 'queued' OR (r.status = 'running' AND r.lease_expires_at < now()))
          AND (o.last_dispatched_at IS NULL OR o.last_dispatched_at < now() - interval '30 seconds')
        ORDER BY r.created_at LIMIT 20 FOR UPDATE OF o SKIP LOCKED
      `);
      for (const row of rows) {
        const sequence = row.sequence + 1;
        await this.queue.add(
          'mock-article',
          { runId: row.run_id },
          {
            jobId: `${row.run_id}-${sequence}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86400, count: 1000 },
          },
        );
        await em.update(
          OutboxEntity,
          { runId: row.run_id },
          { sequence, lastDispatchedAt: new Date() },
        );
      }
      return rows.length;
    });
  }

  start(): void {
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          await this.dispatch();
        } catch {
          this.logger.error({ event: 'outbox.dispatch.failed' });
        }
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
