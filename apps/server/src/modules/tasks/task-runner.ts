import { DataSource, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { isTerminal, runOutputSchema } from '@creator-ai/contracts';
import { RunEntity } from '../../database/entities';
import type { TextProvider } from '../models/mock-provider';
import { AgentRuntime } from './agent-runtime';
import { activeElapsed, RuntimeStop, RuntimeWait } from './runtime-store';
import { ProviderError } from '../models/compatible-provider';
import { DynamicTeamRuntime } from './dynamic-team-runtime';

export class TaskRunner {
  constructor(
    private readonly db: DataSource,
    private readonly provider: TextProvider,
    private readonly runtime = new AgentRuntime(db),
  ) {}

  async execute(id: string): Promise<void> {
    const token = randomUUID();
    const claimed = await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run || isTerminal(run.status) || run.status === 'waiting_user') return null;
      if (
        run.status === 'running' &&
        run.leaseExpiresAt &&
        run.leaseExpiresAt.getTime() > Date.now()
      )
        return null;
      if (run.snapshot.provider === 'compatible') {
        const unfinished: { id: string }[] = await em.query(
          "SELECT id FROM model_invocations WHERE run_id=$1 AND status IN ('in_flight','unknown')",
          [id],
        );
        if (unfinished.length) {
          await this.stopRun(em, run, 'WORKER_INTERRUPTED_UNKNOWN');
          return null;
        }
      }
      if (
        (run.snapshot.workflow === 'team-dynamic-v1' ? run.recoveryAttempts : run.attempts) >= 3
      ) {
        await this.stopRun(em, run, 'RECOVERY_LIMIT');
        return null;
      }
      run.status = 'running';
      run.attempts += 1;
      run.recoveryAttempts += 1;
      run.revision += 1;
      run.leaseToken = token;
      run.leaseExpiresAt = new Date(Date.now() + 30000);
      run.updatedAt = new Date();
      run.startedAt ??= new Date();
      run.activeStartedAt ??= new Date();
      return em.save(run);
    });
    if (!claimed) return;
    const controller = new AbortController();
    const paid = claimed.snapshot.provider === 'compatible';
    let heartbeat: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let pendingHeartbeat: Promise<void> | undefined;
    if (paid) {
      const tick = async () => {
        try {
          const current = await this.db
            .getRepository(RunEntity)
            .findOneBy({ id, leaseToken: token, status: 'running' });
          if (!current) {
            controller.abort(new RuntimeStop('LEASE_LOST'));
            return;
          }
          if (current.cancelRequested) controller.abort(new RuntimeStop('CANCELLED'));
          await this.db
            .getRepository(RunEntity)
            .update(
              { id, leaseToken: token, status: 'running' },
              { leaseExpiresAt: new Date(Date.now() + 30000) },
            );
        } catch {
          controller.abort(new RuntimeStop('LEASE_LOST'));
        }
      };
      heartbeat = setInterval(() => {
        if (!pendingHeartbeat)
          pendingHeartbeat = tick().finally(() => {
            pendingHeartbeat = undefined;
          });
      }, 1000);
      const remaining = Math.max(
        1,
        (claimed.snapshot.limits?.maxDurationSeconds ?? 600) * 1000 - activeElapsed(claimed),
      );
      deadline = setTimeout(() => controller.abort(new RuntimeStop('TIME_LIMIT')), remaining);
    }
    try {
      const output = runOutputSchema.parse(
        paid
          ? claimed.snapshot.workflow === 'team-dynamic-v1'
            ? await new DynamicTeamRuntime(this.db, this.runtime).execute(
                claimed,
                token,
                controller.signal,
              )
            : await this.runtime.execute(claimed, token, controller.signal)
          : await this.provider.generate(claimed.snapshot),
      );
      if (!paid && !output.isMock) throw new Error('Mock output must be marked as mock');
      // Fencing: a late worker cannot overwrite a result after a new lease was acquired.
      await this.db.query(
        `UPDATE creation_runs SET status = 'succeeded', output = $1::jsonb,
        lease_token = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = now(),
        active_ms=active_ms+CASE WHEN active_started_at IS NULL THEN 0 ELSE GREATEST(0,floor(extract(epoch from (now()-active_started_at))*1000))::integer END,
        active_started_at=NULL
        WHERE id = $2 AND lease_token = $3 AND status = 'running' AND cancel_requested = false`,
        [JSON.stringify(output), id, token],
      );
    } catch (error) {
      if (error instanceof RuntimeWait) {
        await this.pause(id, token);
        return;
      }
      const code = !paid
        ? 'MOCK_GENERATION_FAILED'
        : error instanceof RuntimeStop || error instanceof ProviderError
          ? error.code
          : 'AGENT_EXECUTION_FAILED';
      await this.finishFailure(id, token, code);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
      await pendingHeartbeat;
      // A cancel arriving between the last guard and final commit must still become terminal.
      const current = await this.db
        .getRepository(RunEntity)
        .findOneBy({ id, leaseToken: token, status: 'running' });
      if (current?.cancelRequested) await this.finishFailure(id, token, 'CANCELLED');
    }
  }

  private async pause(id: string, token: string) {
    await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id, leaseToken: token, status: 'running' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) return;
      if (run.cancelRequested) {
        await this.stopRun(em, run, 'CANCELLED');
        return;
      }
      const inFlight: { id: string }[] = await em.query(
        "SELECT id FROM model_invocations WHERE run_id=$1 AND status IN ('in_flight','unknown')",
        [id],
      );
      if (inFlight.length) {
        await this.stopRun(em, run, 'WAIT_WITH_UNKNOWN_CALL');
        return;
      }
      await em.update(RunEntity, id, {
        status: 'waiting_user',
        leaseToken: null,
        leaseExpiresAt: null,
        activeMs: activeElapsed(run),
        activeStartedAt: null,
        revision: run.revision + 1,
        updatedAt: new Date(),
      });
    });
  }

  private async finishFailure(id: string, token: string, code: string) {
    await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id, leaseToken: token, status: 'running' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) return;
      await this.stopRun(em, run, code);
    });
  }

  private async stopRun(em: EntityManager, run: RunEntity, code: string) {
    const id = run.id;
    await em.query(
      "UPDATE model_invocations SET status='unknown',failure_code=$2,completed_at=now() WHERE run_id=$1 AND status='in_flight'",
      [id, code],
    );
    const counts: { count: string }[] = await em.query(
      "SELECT count(*) FROM model_invocations WHERE run_id=$1 AND status='unknown'",
      [id],
    );
    const reservations: { tokens: string }[] = await em.query(
      "SELECT coalesce(sum(reserved_tokens),0) AS tokens FROM model_invocations WHERE run_id=$1 AND status='reserved'",
      [id],
    );
    await em.query(
      "UPDATE model_invocations SET status='rejected',failure_code='NOT_DISPATCHED',completed_at=now() WHERE run_id=$1 AND status='reserved'",
      [id],
    );
    const status =
      Number(counts[0]!.count) > 0
        ? 'needs_review'
        : run.cancelRequested || code === 'CANCELLED'
          ? 'cancelled'
          : 'failed';
    await em.query(
      `UPDATE agent_runs SET status=CASE
        WHEN EXISTS(SELECT 1 FROM model_invocations i WHERE i.agent_run_id=agent_runs.id AND i.status='unknown') THEN 'unknown'
        ELSE $2 END,failure_code=$3 WHERE run_id=$1 AND status IN ('pending','running')`,
      [id, status === 'needs_review' ? 'cancelled' : status, code],
    );
    await em.update(RunEntity, id, {
      status,
      failureCode: code,
      leaseToken: null,
      leaseExpiresAt: null,
      revision: run.revision + 1,
      reservedTokens: Math.max(0, run.reservedTokens - Number(reservations[0]!.tokens)),
      updatedAt: new Date(),
      activeMs: run.snapshot.workflow === 'team-dynamic-v1' ? activeElapsed(run) : run.activeMs,
      activeStartedAt: null,
    });
  }
}
