import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  contentAssistanceLimits,
  contentTurnInputSchema,
  validateAnnotations,
  type ContentTurn,
  type ContentTurnDetail,
  type ContentTurnInput,
  type ContentAssistanceContext,
  type RunSnapshot,
  type ContentWritingProfiles,
} from '@creator-ai/contracts';
import { ApiError } from '../../common/http';
import { AccountEntity, ExpertEntity, OutboxEntity, RunEntity } from '../../database/entities';
import { hashToken } from '../auth/credentials';
import { resolveSkills, toAccount } from '../catalog/catalog.service';
import { ModelService } from '../models/model.service';

interface ContentRow {
  revision: number;
  current_version: number;
  source_run_id: string;
}
const toTurn = (run: RunEntity): ContentTurn => {
  const context = run.snapshot.assistance!;
  return {
    id: run.id,
    contentId: context.contentId,
    baseRevision: context.baseRevision,
    baseVersion: context.baseVersion,
    mode: context.mode,
    message: context.message,
    annotations: context.annotations,
    status: run.status,
    modelName: run.snapshot.model?.name ?? '本地模拟（未调用 AI）',
    isMock: run.snapshot.provider === 'mock',
    result: run.output?.assistance ?? null,
    failureCode: run.failureCode,
    historyTruncated: context.historyTruncated,
    createdAt: run.createdAt.toISOString(),
    ...(context.writingProfile ? { writingProfile: context.writingProfile } : {}),
  };
};

@Injectable()
export class ContentAssistanceService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}

  private async owned(em: EntityManager, ownerId: string, id: string, lock = false) {
    const [row] = await em.query<ContentRow[]>(
      `SELECT revision,current_version,source_run_id FROM content_items
       WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, ownerId],
    );
    if (!row) throw new ApiError(404, 'CONTENT_NOT_FOUND', '内容不存在。');
    return row;
  }

  async writingProfiles(ownerId: string, id: string): Promise<ContentWritingProfiles> {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      const item = await this.owned(em, ownerId, id);
      const source = await em.findOneByOrFail(RunEntity, { id: item.source_run_id, ownerId });
      const current = await em.findOneBy(AccountEntity, {
        id: source.snapshot.account.id,
        ownerId,
      });
      if (!current) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '原账号不存在。');
      return { original: source.snapshot.account, current: toAccount(current) };
    });
  }

  async create(
    ownerId: string,
    id: string,
    raw: ContentTurnInput,
    key?: string,
  ): Promise<ContentTurn> {
    const input = contentTurnInputSchema.parse(raw);
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 16-128 位的 Idempotency-Key。');
    const hash = hashToken(JSON.stringify(['content-assist-v1', id, input]));
    return this.db.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${ownerId}:creation:${key}`,
      ]);
      const item = await this.owned(em, ownerId, id, true);
      const existing = await em.findOneBy(RunEntity, { ownerId, idempotencyKey: key });
      if (existing) {
        if (existing.inputHash !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同稿件或要求。');
        return toTurn(existing);
      }
      if (item.revision !== input.baseRevision)
        throw new ApiError(
          409,
          'CONTENT_CONFLICT',
          '服务器稿件已更新，请保留本地稿并核对最新版本。',
        );
      try {
        validateAnnotations(input, input.annotations);
      } catch (error) {
        throw new ApiError(422, 'ANNOTATION_STALE', (error as Error).message);
      }
      const active = await em.query<{ run_id: string }[]>(
        `SELECT t.run_id FROM content_turns t JOIN creation_runs r ON r.id=t.run_id
         WHERE t.content_id=$1 AND r.status IN ('queued','running','waiting_user','needs_review') LIMIT 1`,
        [id],
      );
      if (active.length)
        throw new ApiError(
          409,
          'ASSISTANCE_IN_PROGRESS',
          '此稿仍有进行中或结果待核对的对话，请先处理该轮。',
        );
      const source = await em.findOneByOrFail(RunEntity, { id: item.source_run_id, ownerId });
      const account = await em.findOne(AccountEntity, {
        where: { id: source.snapshot.account.id, ownerId },
        lock: { mode: 'pessimistic_read' },
      });
      const expert = await em.findOneBy(ExpertEntity, { id: source.snapshot.expert.id, ownerId });
      if (!account || !expert || !expert.enabled)
        throw new ApiError(422, 'CONFIG_UNAVAILABLE', '原账号或专家已不可用，请先恢复配置。');
      if (
        input.accountProfileRevision !== undefined &&
        account.revision !== input.accountProfileRevision
      )
        throw new ApiError(
          409,
          'ACCOUNT_REVISION_CONFLICT',
          '账号写作资料已变化，请刷新资料并重新确认本轮选择。',
        );
      const writingAccount =
        input.accountProfileRevision === undefined ? source.snapshot.account : toAccount(account);
      // Preserve the article's frozen methods; a team contributes its lead, not a new full team run.
      const editor = structuredClone(source.snapshot.expert);
      const lead = editor.team?.members.find((m) => m.agentId === editor.team!.leadAgent);
      if (lead)
        Object.assign(editor, lead, {
          instructions: `${editor.instructions}\n${lead.instructions}`,
          preloadSkillKeys: lead.preloadSkillKeys ?? [],
        });
      delete editor.team;
      editor.expertType = 'agent';
      editor.maxTurns = Math.min(editor.maxTurns ?? 4, 4);
      const skills = source.snapshot.skills.filter((s) => editor.skillKeys.includes(s.key));
      await resolveSkills(
        em,
        ownerId,
        skills.map((s) => s.key),
      );
      const model = input.modelConnectionId
        ? await new ModelService(this.db).snapshot(em, ownerId, input.modelConnectionId)
        : undefined;
      const previous = await em.query<{ context: ContentAssistanceContext; reply: string }[]>(
        `SELECT (r.snapshot->'assistance') - 'document' - 'history' AS context,
         r.output->'assistance'->>'reply' AS reply
         FROM content_turns t JOIN creation_runs r ON r.id=t.run_id
         WHERE t.content_id=$1 AND r.status='succeeded' AND r.snapshot->>'provider'='compatible'
         ORDER BY t.created_at DESC,t.run_id DESC LIMIT 7`,
        [id],
      );
      const history: ContentAssistanceContext['history'] = [];
      let remaining = 12000,
        historyTruncated = previous.length > 6;
      for (const p of previous.slice(0, 6)) {
        const user = JSON.stringify({
          mode: p.context.mode,
          message: p.context.message,
          annotations: p.context.annotations.map((a) => ({
            kind: a.kind,
            note: a.note,
            quote: a.quote,
          })),
        });
        const reply = p.reply ?? '';
        if (user.length + reply.length > remaining) {
          historyTruncated = true;
          break;
        }
        remaining -= user.length + reply.length;
        history.unshift({ role: 'user', content: user }, { role: 'assistant', content: reply });
      }
      const snapshot: RunSnapshot = {
        schemaVersion: 1,
        topic: input.title,
        brief: '',
        account: writingAccount,
        expert: editor,
        skills,
        provider: model ? 'compatible' : 'mock',
        workflow: 'content-assist-v1',
        limits: { ...contentAssistanceLimits },
        ...(model ? { model } : {}),
        skillSelection: {
          available: skills.map((s) => s.key),
          preloaded: editor.preloadSkillKeys ?? [],
          loaded: [],
        },
        assistance: {
          contentId: id,
          baseRevision: item.revision,
          baseVersion: item.current_version,
          title: input.title,
          document: input.document,
          mode: input.mode,
          message: input.message,
          annotations: input.annotations,
          history,
          historyTruncated,
          writingProfile: {
            source: input.accountProfileRevision === undefined ? 'original' : 'current',
            accountRevision: writingAccount.revision ?? null,
            cards: (writingAccount.writingCards ?? [])
              .filter((c) => c.enabled)
              .map(({ id, kind, title }) => ({ id, kind, title })),
          },
        },
      };
      const now = new Date();
      const run = await em.save(RunEntity, {
        id: randomUUID(),
        ownerId,
        idempotencyKey: key,
        inputHash: hash,
        snapshot,
        status: 'queued',
        revision: 1,
        attempts: 0,
        output: null,
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await em.query('INSERT INTO content_turns(run_id,content_id,base_version) VALUES($1,$2,$3)', [
        run.id,
        id,
        item.current_version,
      ]);
      await em.insert(OutboxEntity, { runId: run.id, sequence: 0, lastDispatchedAt: null });
      return toTurn(run);
    });
  }

  async list(ownerId: string, id: string, page: number, requestedSize: number) {
    const pageSize = Math.min(requestedSize, 20);
    return this.db.transaction('REPEATABLE READ', async (em) => {
      await this.owned(em, ownerId, id);
      const [count] = await em.query<{ total: number }[]>(
        'SELECT count(*)::int AS total FROM content_turns WHERE content_id=$1',
        [id],
      );
      // Do not load every manuscript, skill package or invocation ledger in a history page.
      const rows = await em.query<{ turn: ContentTurn }[]>(
        `SELECT jsonb_build_object('id',r.id,'contentId',t.content_id,
          'baseRevision',r.snapshot->'assistance'->'baseRevision','baseVersion',t.base_version,
          'mode',r.snapshot->'assistance'->'mode','message',r.snapshot->'assistance'->'message',
          'annotations',r.snapshot->'assistance'->'annotations','status',r.status,
          'modelName',COALESCE(r.snapshot->'model'->>'name','本地模拟（未调用 AI）'),
          'isMock',r.snapshot->>'provider'='mock','result',r.output->'assistance',
          'failureCode',r.failure_code,'historyTruncated',r.snapshot->'assistance'->'historyTruncated',
          'createdAt',r.created_at) || CASE WHEN r.snapshot->'assistance' ? 'writingProfile'
          THEN jsonb_build_object('writingProfile',r.snapshot->'assistance'->'writingProfile')
          ELSE '{}'::jsonb END AS turn
         FROM content_turns t JOIN creation_runs r ON r.id=t.run_id
         WHERE t.content_id=$1 AND r.owner_id=$2 ORDER BY t.created_at DESC,t.run_id DESC LIMIT $3 OFFSET $4`,
        [id, ownerId, pageSize, (page - 1) * pageSize],
      );
      return { items: rows.map((r) => r.turn), total: count!.total, page, pageSize };
    });
  }

  async get(ownerId: string, id: string, runId: string): Promise<ContentTurnDetail> {
    const run = await this.db.getRepository(RunEntity).findOneBy({ id: runId, ownerId });
    if (run?.snapshot.assistance?.contentId !== id)
      throw new ApiError(404, 'TURN_NOT_FOUND', '对话不存在。');
    const { title, document } = run.snapshot.assistance;
    return { ...toTurn(run), manuscript: { title, document } };
  }
}
