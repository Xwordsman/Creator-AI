import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  expertSkillKeys,
  runLimitsSchema,
  runOutputSchema,
  teamResponseSchema,
  type TeamResponse,
  type ContinueRunInput,
  type CreateRunInput,
  type CreationRun,
  type RunHistoryItem,
  type RunSnapshot,
} from '@creator-ai/contracts';
import { AccountEntity, ExpertEntity, OutboxEntity, RunEntity } from '../../database/entities';
import { ApiError } from '../../common/http';
import { hashToken } from '../auth/credentials';
import { resolveSkills, toAccount, toExpert } from '../catalog/catalog.service';
import { ModelService } from '../models/model.service';
import { readExecution, readTeamActions } from '../tasks/runtime-store';

export const toRun = (row: RunEntity): CreationRun => ({
  id: row.id,
  status: row.status,
  revision: row.revision,
  attempts: row.attempts,
  snapshot: row.snapshot,
  output: row.output,
  failureCode: row.failureCode,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  cancelRequested: row.cancelRequested,
  ...(row.parentRunId && row.rootRunId
    ? {
        lineage: {
          parentRunId: row.parentRunId,
          rootRunId: row.rootRunId,
          depth: row.continuationDepth,
        },
      }
    : {}),
});

@Injectable()
export class CreationService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}

  async create(
    ownerId: string,
    input: CreateRunInput,
    key: string | undefined,
  ): Promise<CreationRun> {
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 16-128 位的 Idempotency-Key。');
    }
    const inputHash = hashToken(
      JSON.stringify([
        input.accountId,
        input.expertId,
        input.topic,
        input.brief,
        ...(input.modelConnectionId
          ? [input.modelConnectionId, runLimitsSchema.parse(input.limits ?? {})]
          : []),
        ...(input.teamMode ? ['team-mode', input.teamMode] : []),
        ...(input.accountRevision ? ['account-revision', input.accountRevision] : []),
      ]),
    );
    return this.db.transaction(async (em) => {
      // Serialize a key before checking it; a transaction rollback leaves no partial run/outbox.
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${ownerId}:creation:${key}`,
      ]);
      const existing = await em.findOneBy(RunEntity, { ownerId, idempotencyKey: key });
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同请求标识不能用于不同主题或配置。');
        return toRun(existing);
      }
      const account = await em.findOne(AccountEntity, {
        where: { id: input.accountId, ownerId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!account) throw new ApiError(404, 'CONFIG_NOT_FOUND', '账号或专家不存在，或无权访问。');
      if (input.accountRevision && input.accountRevision !== account.revision)
        throw new ApiError(
          409,
          'ACCOUNT_REVISION_CONFLICT',
          '账号默认配置已变化，请重新读取后确认。',
        );
      const expertId = input.expertId ?? account.defaultExpertId;
      if (!expertId)
        throw new ApiError(
          422,
          'DEFAULT_EXPERT_REQUIRED',
          '此账号尚未设置默认专家，请明确选择专家。',
        );
      const expert = await em.findOne(ExpertEntity, {
        where: { id: expertId, ownerId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!expert) throw new ApiError(404, 'CONFIG_NOT_FOUND', '账号或专家不存在，或无权访问。');
      if (!expert.enabled)
        throw new ApiError(422, 'EXPERT_DISABLED', '专家已停用，请选择已启用的专家。');
      if (input.teamMode && expert.definition.expertType !== 'team')
        throw new ApiError(422, 'TEAM_MODE_REQUIRES_TEAM', '协作模式只适用于专家团。');
      if (expert.definition.expertType === 'team' && !input.modelConnectionId)
        throw new ApiError(
          422,
          'TEAM_RUNTIME_UNAVAILABLE',
          '专家团需要配置模型连接才能运行，不能使用单专家模拟模板代替。',
        );
      const available = expertSkillKeys(expert.definition);
      const skills = await resolveSkills(em, ownerId, available, expert.definition.skillVersions);
      const model = input.modelConnectionId
        ? await new ModelService(this.db).snapshot(em, ownerId, input.modelConnectionId)
        : undefined;
      const snapshot: RunSnapshot = {
        schemaVersion: 1,
        topic: input.topic,
        brief: input.brief,
        account: toAccount(account),
        expert: toExpert(expert),
        skills,
        skillSelection: {
          available,
          preloaded: expert.definition.preloadSkillKeys ?? [],
          loaded: [],
        },
        provider: model ? 'compatible' : 'mock',
        workflow: model
          ? expert.definition.expertType === 'team'
            ? input.teamMode === 'dynamic'
              ? 'team-dynamic-v1'
              : 'team-v1'
            : 'agent-v1'
          : 'mock-article-v1',
        ...(model ? { model, limits: runLimitsSchema.parse(input.limits ?? {}) } : {}),
      };
      const now = new Date();
      const run = await em.save(RunEntity, {
        id: randomUUID(),
        ownerId,
        idempotencyKey: key,
        inputHash,
        status: 'queued',
        revision: 1,
        attempts: 0,
        snapshot,
        output: null,
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await em.insert(OutboxEntity, { runId: run.id, sequence: 0, lastDispatchedAt: null });
      return toRun(run);
    });
  }

  async get(ownerId: string, id: string): Promise<CreationRun> {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      const run = await em.findOneBy(RunEntity, { id, ownerId });
      if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      return {
        ...toRun(run),
        ...(run.snapshot.provider === 'compatible'
          ? { execution: await readExecution(em, run) }
          : {}),
      };
    });
  }

  async continueDraft(
    ownerId: string,
    id: string,
    input: ContinueRunInput,
    key?: string,
  ): Promise<CreationRun> {
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 16-128 位的 Idempotency-Key。');
    const inputHash = hashToken(JSON.stringify(['continue-v1', id, input.instruction]));
    return this.db.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${ownerId}:creation:${key}`,
      ]);
      const existing = await em.findOneBy(RunEntity, { ownerId, idempotencyKey: key });
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            '相同请求标识不能用于不同原稿或修改要求。',
          );
        return toRun(existing);
      }
      const parent = await em.findOneBy(RunEntity, { id, ownerId });
      if (!parent) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      if (parent.snapshot.assistance)
        throw new ApiError(
          422,
          'ASSISTANCE_NOT_ARTICLE',
          '请在原内容编辑台继续对话，而不是从建议生成新稿。',
        );
      const output = runOutputSchema.safeParse(parent.output);
      if (parent.status !== 'succeeded' || !output.success)
        throw new ApiError(
          409,
          'DRAFT_NOT_READY',
          '仅能基于已成功生成的草稿继续创作；未知调用需先核对，不能借此重发。',
        );
      if (parent.continuationDepth >= 100)
        throw new ApiError(
          422,
          'CONTINUATION_LIMIT',
          '该分支已达到 100 层，请从工作台开始新主题。',
        );
      const account = await em.findOneBy(AccountEntity, {
        id: parent.snapshot.account.id,
        ownerId,
      });
      const expert = await em.findOneBy(ExpertEntity, { id: parent.snapshot.expert.id, ownerId });
      if (!account || !expert)
        throw new ApiError(404, 'CONFIG_NOT_FOUND', '原账号或专家已不可用。');
      if (!expert.enabled)
        throw new ApiError(422, 'EXPERT_DISABLED', '原专家已停用，请从工作台选择其他专家。');
      // Availability is checked now, but executable instructions remain the frozen historical versions.
      await resolveSkills(
        em,
        ownerId,
        parent.snapshot.skills.map((s) => s.key),
      );
      if (parent.snapshot.provider === 'compatible') {
        if (!parent.snapshot.model)
          throw new ApiError(422, 'MODEL_NOT_FOUND', '原任务缺少模型快照。');
        await new ModelService(this.db).snapshot(em, ownerId, parent.snapshot.model.id);
      }
      const lineage = {
        parentRunId: id,
        rootRunId: parent.rootRunId ?? id,
        depth: parent.continuationDepth + 1,
      };
      // Copy only the immediate draft, never recursively embed its continuation context or ledgers.
      const base = { ...parent.snapshot };
      delete base.continuation;
      const snapshot: RunSnapshot = {
        ...base,
        ...(base.skillSelection ? { skillSelection: { ...base.skillSelection, loaded: [] } } : {}),
        continuation: { ...lineage, instruction: input.instruction, previousOutput: output.data },
      };
      const now = new Date();
      const run = await em.save(RunEntity, {
        id: randomUUID(),
        ownerId,
        idempotencyKey: key,
        inputHash,
        parentRunId: id,
        rootRunId: lineage.rootRunId,
        continuationDepth: lineage.depth,
        status: 'queued',
        revision: 1,
        attempts: 0,
        snapshot,
        output: null,
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await em.insert(OutboxEntity, { runId: run.id, sequence: 0, lastDispatchedAt: null });
      return toRun(run);
    });
  }

  async history(ownerId: string, id: string, page: number, pageSize: number) {
    const run = await this.db.getRepository(RunEntity).findOneBy({ id, ownerId });
    if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
    // Project metadata only: a history page must not load every draft/context/agent ledger.
    const query = this.db
      .getRepository(RunEntity)
      .createQueryBuilder('r')
      .where('r.owner_id = :ownerId AND COALESCE(r.root_run_id, r.id) = :root', {
        ownerId,
        root: run.rootRunId ?? id,
      });
    const total = await query.getCount();
    const rows: {
      id: string;
      status: CreationRun['status'];
      created_at: Date;
      parent_run_id: string | null;
      root_run_id: string | null;
      continuation_depth: number;
      instruction: string | null;
    }[] = await query
      .select([
        'r.id AS id',
        'r.status AS status',
        'r.created_at AS created_at',
        'r.parent_run_id AS parent_run_id',
        'r.root_run_id AS root_run_id',
        'r.continuation_depth AS continuation_depth',
        "r.snapshot->'continuation'->>'instruction' AS instruction",
      ])
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany();
    const items: RunHistoryItem[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      instruction: r.instruction,
      ...(r.parent_run_id && r.root_run_id
        ? {
            lineage: {
              parentRunId: r.parent_run_id,
              rootRunId: r.root_run_id,
              depth: r.continuation_depth,
            },
          }
        : {}),
    }));
    return { items, total, page, pageSize };
  }

  async cancel(ownerId: string, id: string): Promise<CreationRun> {
    await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      if (!['queued', 'running', 'waiting_user'].includes(run.status)) return;
      // A running invocation is interrupted by the worker; its result may remain unknown.
      await em.update(RunEntity, id, {
        cancelRequested: true,
        ...(run.status !== 'running'
          ? { status: 'cancelled' as const, failureCode: 'CANCELLED' }
          : {}),
        revision: run.revision + 1,
        updatedAt: new Date(),
      });
    });
    return this.get(ownerId, id);
  }
  async respond(
    ownerId: string,
    id: string,
    actionId: string,
    input: TeamResponse,
  ): Promise<CreationRun> {
    const response = teamResponseSchema.parse(input);
    await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      const action = (await readTeamActions(em, id)).find((a) => a.id === actionId);
      if (!action) throw new ApiError(404, 'TEAM_ACTION_NOT_FOUND', '协作动作不存在。');
      if (action.response) {
        if (
          action.response.answer !== response.answer ||
          action.response.approved !== response.approved
        )
          throw new ApiError(
            409,
            'TEAM_RESPONSE_CONFLICT',
            '该动作已答复，不能以不同内容重复提交。',
          );
        return;
      }
      if (run.status !== 'waiting_user' || action.state !== 'waiting')
        throw new ApiError(409, 'TEAM_NOT_WAITING', '任务当前不等待此答复，请刷新状态。');
      const confirmation = ['delegate', 'confirm'].includes(action.directive.action);
      if (confirmation !== (typeof response.approved === 'boolean'))
        throw new ApiError(
          422,
          'TEAM_RESPONSE_INVALID',
          '提案/确认必须明确同意或拒绝；问题只需补充信息。',
        );
      await em.query(
        'UPDATE team_actions SET response=$2::jsonb WHERE id=$1 AND response IS NULL',
        [actionId, JSON.stringify(response)],
      );
      const sources: { agent_id: string }[] = await em.query(
        'SELECT agent_id FROM agent_runs WHERE id=$1 AND run_id=$2',
        [action.sourceAgentRunId, id],
      );
      await em.query(
        'INSERT INTO team_messages(id,run_id,sender,recipient,kind,content) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, 'user', sources[0]!.agent_id, 'answer', JSON.stringify(response)],
      );
      await em.update(RunEntity, id, {
        status: 'queued',
        recoveryAttempts: 0,
        revision: run.revision + 1,
        updatedAt: new Date(),
      });
      await em.update(OutboxEntity, { runId: id }, { lastDispatchedAt: null });
    });
    return this.get(ownerId, id);
  }
  async reconcile(ownerId: string, id: string, note: string): Promise<CreationRun> {
    await this.db.transaction(async (em) => {
      const run = await em.findOne(RunEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      if (run.status !== 'needs_review')
        throw new ApiError(409, 'REVIEW_NOT_REQUIRED', '当前任务不处于待核对状态。');
      await em.query(
        'INSERT INTO invocation_reconciliations(id,run_id,owner_id,note) VALUES($1,$2,$3,$4)',
        [randomUUID(), id, ownerId, note],
      );
      await em.update(RunEntity, id, {
        status: 'cancelled',
        failureCode: 'UNKNOWN_ACKNOWLEDGED',
        revision: run.revision + 1,
        updatedAt: new Date(),
      });
    });
    return this.get(ownerId, id);
  }

  async list(ownerId: string, page: number, pageSize: number) {
    const [rows, total] = await this.db.getRepository(RunEntity).findAndCount({
      where: { ownerId },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });
    return { items: rows.map(toRun), total, page, pageSize };
  }
}
