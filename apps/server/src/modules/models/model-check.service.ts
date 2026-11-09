import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { z } from 'zod';
import type { ModelCheck } from '@creator-ai/contracts';
import { ApiError } from '../../common/http';
import { ModelService } from './model.service';
import { CompatibleProvider, makeModelBody, ProviderError } from './compatible-provider';

interface CheckRow {
  id: string;
  model_id: string;
  status: ModelCheck['status'];
  failure_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  completed_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}
const view = (r: CheckRow): ModelCheck => ({
  id: r.id,
  modelConnectionId: r.model_id,
  status: r.status,
  failureCode: r.failure_code,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  resolutionNote: r.resolution_note,
});
const validReply = z.strictObject({ ok: z.literal(true) });

@Injectable()
export class ModelCheckService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}

  private async owned(em: EntityManager, owner: string, model: string) {
    const rows = await em.query('SELECT id FROM model_connections WHERE id=$1 AND owner_id=$2', [
      model,
      owner,
    ]);
    if (!rows.length) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型连接不存在。');
  }
  private async expire(em: EntityManager, owner: string, model: string) {
    // No retry after a process interruption; an in-flight request may already have been billed.
    await em.query(
      `UPDATE model_checks SET status=CASE WHEN dispatched THEN 'unknown' ELSE 'failed' END,
      failure_code=CASE WHEN dispatched THEN 'MODEL_CHECK_EXPIRED' ELSE 'MODEL_CHECK_INTERRUPTED' END,
      completed_at=now() WHERE model_id=$1 AND owner_id=$2 AND status='running' AND expires_at<=now()`,
      [model, owner],
    );
  }
  async list(owner: string, model: string): Promise<ModelCheck[]> {
    return this.db.transaction(async (em) => {
      await this.owned(em, owner, model);
      await this.expire(em, owner, model);
      const rows: CheckRow[] = await em.query(
        `SELECT * FROM model_checks WHERE model_id=$1 AND owner_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 10`,
        [model, owner],
      );
      return rows.map(view);
    });
  }
  async create(owner: string, model: string, key?: string): Promise<ModelCheck> {
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 16-128 位的 Idempotency-Key。');
    const selected = await this.db.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${owner}:model-check-key:${key}`,
      ]);
      await this.owned(em, owner, model);
      const prior: CheckRow[] = await em.query(
        'SELECT * FROM model_checks WHERE owner_id=$1 AND idempotency_key=$2',
        [owner, key],
      );
      if (prior[0]) {
        if (prior[0].model_id !== model)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '此请求标识已用于其他连接。');
        await this.expire(em, owner, model);
        return { id: prior[0].id, snapshot: null };
      }
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${owner}:model-check:${model}`,
      ]);
      await this.expire(em, owner, model);
      const active = await em.query(
        `SELECT id FROM model_checks WHERE model_id=$1 AND
        (status='running' OR (status='unknown' AND resolved_at IS NULL))`,
        [model],
      );
      if (active.length)
        throw new ApiError(
          409,
          'MODEL_CHECK_UNRESOLVED',
          '此连接仍有检查进行中或结果待核对，请先查看记录。',
        );
      const snapshot = await new ModelService(this.db).snapshot(em, owner, model);
      const id = randomUUID();
      await em.query(
        "INSERT INTO model_checks(id,owner_id,model_id,idempotency_key,status) VALUES($1,$2,$3,$4,'running')",
        [id, owner, model, key],
      );
      return { id, snapshot };
    });
    if (selected.snapshot) {
      const signal = AbortSignal.timeout(20000);
      let dispatched = false;
      let status: ModelCheck['status'] = 'failed',
        failure: string | null = null;
      let input: number | null = null,
        output: number | null = null;
      try {
        const models = new ModelService(this.db);
        const provider = new CompatibleProvider();
        const modelSnapshot = { ...selected.snapshot, maxOutputTokens: 256 };
        const secret = await models.credentials(owner, modelSnapshot);
        const target = await provider.prepare(modelSnapshot);
        signal.throwIfAborted();
        const started = await this.db.query(
          `WITH started AS (UPDATE model_checks SET dispatched=true
          WHERE id=$1 AND status='running' AND expires_at>now() RETURNING id) SELECT * FROM started`,
          [selected.id],
        );
        if (!started.length) return this.get(owner, model, selected.id);
        dispatched = true;
        const reply = await provider.call(
          target,
          secret,
          makeModelBody(
            modelSnapshot,
            [
              {
                role: 'system',
                content:
                  'This is a connection protocol check. Return only the JSON object {"ok":true}, without Markdown, explanations or tools.',
              },
              { role: 'user', content: 'Return {"ok":true}.' },
            ],
            false,
          ),
          selected.id,
          signal,
        );
        input = reply.inputTokens;
        output = reply.outputTokens;
        let valid = false;
        try {
          valid =
            !reply.message.tool_calls?.length &&
            validReply.safeParse(JSON.parse(reply.message.content ?? '')).success;
        } catch {
          /* Invalid output is a completed call, not an invitation to retry. */
        }
        status = valid ? 'passed' : 'failed';
        failure = valid ? null : 'MODEL_CHECK_INVALID_OUTPUT';
      } catch (error) {
        status =
          dispatched && (!(error instanceof ProviderError) || error.ambiguous)
            ? 'unknown'
            : 'failed';
        failure =
          error instanceof ProviderError
            ? error.code
            : error instanceof ApiError
              ? (error.getResponse() as { code: string }).code
              : dispatched
                ? 'PROVIDER_TRANSPORT_UNKNOWN'
                : 'MODEL_CHECK_PREPARATION_FAILED';
      }
      await this.db.query(
        `UPDATE model_checks SET status=$2,failure_code=$3,input_tokens=$4,output_tokens=$5,completed_at=now()
        WHERE id=$1 AND status='running' AND expires_at>now()`,
        [selected.id, status, failure, input, output],
      );
    }
    return this.get(owner, model, selected.id);
  }
  private async get(owner: string, model: string, id: string): Promise<ModelCheck> {
    await this.expire(this.db.manager, owner, model);
    const [row] = await this.db.query<CheckRow[]>(
      'SELECT * FROM model_checks WHERE id=$1 AND owner_id=$2 AND model_id=$3',
      [id, owner, model],
    );
    if (!row) throw new ApiError(404, 'MODEL_CHECK_NOT_FOUND', '检查记录不存在。');
    return view(row);
  }
  async resolve(owner: string, model: string, id: string, note: string): Promise<ModelCheck> {
    return this.db.transaction(async (em) => {
      const [row] = await em.query<CheckRow[]>(
        'SELECT * FROM model_checks WHERE id=$1 AND owner_id=$2 AND model_id=$3 FOR UPDATE',
        [id, owner, model],
      );
      if (!row) throw new ApiError(404, 'MODEL_CHECK_NOT_FOUND', '检查记录不存在。');
      if (row.status !== 'unknown')
        throw new ApiError(409, 'MODEL_CHECK_NOT_UNKNOWN', '仅可核对结果不确定的调用。');
      if (row.resolved_at) {
        if (row.resolution_note !== note)
          throw new ApiError(409, 'MODEL_CHECK_ALREADY_RESOLVED', '核对说明已保存，不能覆盖。');
        return view(row);
      }
      const [saved] = await em.query<CheckRow[]>(
        'WITH saved AS (UPDATE model_checks SET resolved_at=now(),resolution_note=$2 WHERE id=$1 RETURNING *) SELECT * FROM saved',
        [id, note],
      );
      return view(saved!);
    });
  }
}
