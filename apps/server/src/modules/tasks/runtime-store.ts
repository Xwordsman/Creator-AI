import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  AgentDefinition,
  AgentExecution,
  ModelInvocation,
  RunExecution,
  TeamMessage,
  ToolExecution,
  TeamAction,
} from '@creator-ai/contracts';
import { RunEntity } from '../../database/entities';
import type { ChatMessage, ModelReply } from '../models/compatible-provider';

export class RuntimeStop extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export class RuntimeWait extends Error {}
export function activeElapsed(run: RunEntity): number {
  return run.snapshot.workflow === 'team-dynamic-v1'
    ? run.activeMs +
        (run.activeStartedAt ? Math.max(0, Date.now() - run.activeStartedAt.getTime()) : 0)
    : run.startedAt
      ? Math.max(0, Date.now() - run.startedAt.getTime())
      : 0;
}
export interface AgentRow {
  id: string;
  run_id: string;
  agent_id: string;
  name: string;
  role: AgentExecution['role'];
  phase: number;
  task: string;
  dependencies: string[];
  definition: AgentDefinition;
  status: AgentExecution['status'];
  messages: ChatMessage[];
  loaded_skill_keys: string[];
  result: string | null;
  failure_code: string | null;
}
interface InvocationRow {
  id: string;
  agent_run_id: string;
  turn: number;
  status: ModelInvocation['status'];
  reserved_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  response: ModelReply | null;
  provider_request_id: string | null;
  failure_code: string | null;
  request_hash: string;
  created_at: Date;
  completed_at: Date | null;
}
export class RuntimeStore {
  constructor(
    readonly db: DataSource,
    readonly runId: string,
    readonly lease: string,
  ) {}
  async locked<T>(operation: (em: EntityManager, run: RunEntity) => Promise<T>): Promise<T> {
    return this.db.transaction(async (em) => {
      const run = await em.findOneOrFail(RunEntity, {
        where: { id: this.runId },
        lock: { mode: 'pessimistic_write' },
      });
      if (run.leaseToken !== this.lease || run.status !== 'running')
        throw new RuntimeStop('LEASE_LOST');
      return operation(em, run);
    });
  }
  check(run: RunEntity) {
    if (run.cancelRequested) throw new RuntimeStop('CANCELLED');
    if (activeElapsed(run) >= (run.snapshot.limits?.maxDurationSeconds ?? 600) * 1000)
      throw new RuntimeStop('TIME_LIMIT');
  }
  async guard() {
    await this.locked(async (_em, run) => {
      this.check(run);
    });
  }
  async addAgents(agents: AgentRow[]) {
    await this.locked(async (em, run) => {
      this.check(run);
      for (const agent of agents) {
        await em.query(
          `INSERT INTO agent_runs(id,run_id,agent_id,name,role,phase,task,dependencies,definition,messages)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb) ON CONFLICT(run_id,phase,agent_id) DO NOTHING`,
          [
            agent.id,
            this.runId,
            agent.agent_id,
            agent.name,
            agent.role,
            agent.phase,
            agent.task,
            JSON.stringify(agent.dependencies),
            JSON.stringify(agent.definition),
            JSON.stringify(agent.messages),
          ],
        );
      }
      await em.increment(RunEntity, { id: this.runId }, 'revision', 1);
    });
  }
  async agents(): Promise<AgentRow[]> {
    return this.db.query('SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id', [
      this.runId,
    ]);
  }
  async agentState(
    id: string,
    status: AgentExecution['status'],
    result: string | null = null,
    code: string | null = null,
  ) {
    await this.locked(async (em) => {
      await em.query(
        'UPDATE agent_runs SET status=$2,result=$3,failure_code=$4 WHERE id=$1 AND run_id=$5',
        [id, status, result, code, this.runId],
      );
      await em.increment(RunEntity, { id: this.runId }, 'revision', 1);
    });
  }
  async reserve(
    agentId: string,
    turn: number,
    tokens: number,
    hash: string,
  ): Promise<InvocationRow> {
    return this.locked(async (em, run) => {
      this.check(run);
      const existing: InvocationRow[] = await em.query(
        'SELECT * FROM model_invocations WHERE agent_run_id=$1 AND turn=$2',
        [agentId, turn],
      );
      if (existing[0]) {
        if (existing[0].request_hash !== hash) throw new RuntimeStop('REPLAY_CONTEXT_MISMATCH');
        if (!['reserved', 'succeeded'].includes(existing[0].status))
          throw new RuntimeStop('INVOCATION_NOT_REPLAYABLE');
        return existing[0];
      }
      const limits = run.snapshot.limits!;
      if (
        run.invocationCount >= limits.maxCalls ||
        run.chargedTokens + run.reservedTokens + tokens > limits.maxTotalTokens
      )
        throw new RuntimeStop('BUDGET_EXHAUSTED');
      const rows: InvocationRow[] = await em.query(
        `INSERT INTO model_invocations(id,run_id,agent_run_id,turn,status,reserved_tokens,request_hash)
        VALUES($1,$2,$3,$4,'reserved',$5,$6) RETURNING *`,
        [randomUUID(), this.runId, agentId, turn, tokens, hash],
      );
      await em.query(
        'UPDATE creation_runs SET invocation_count=invocation_count+1,reserved_tokens=reserved_tokens+$2,revision=revision+1,updated_at=now() WHERE id=$1',
        [this.runId, tokens],
      );
      return rows[0]!;
    });
  }
  async startInvocation(id: string) {
    await this.locked(async (em, run) => {
      this.check(run);
      await em.query(
        "UPDATE model_invocations SET status='in_flight' WHERE id=$1 AND run_id=$2 AND status='reserved'",
        [id, this.runId],
      );
    });
  }
  async settleInvocation(
    id: string,
    reply: ModelReply | null,
    failure: { code: string; ambiguous: boolean } | null,
  ) {
    await this.locked(async (em) => {
      const rows: InvocationRow[] = await em.query(
        "SELECT * FROM model_invocations WHERE id=$1 AND run_id=$2 AND status='in_flight'",
        [id, this.runId],
      );
      const row = rows[0];
      if (!row) throw new RuntimeStop('INVOCATION_STATE_LOST');
      const status = reply ? 'succeeded' : failure?.ambiguous ? 'unknown' : 'rejected';
      const charged = reply
        ? reply.inputTokens !== null && reply.outputTokens !== null
          ? reply.inputTokens + reply.outputTokens
          : row.reserved_tokens
        : 0;
      const released = status === 'unknown' ? 0 : row.reserved_tokens;
      await em.query(
        `UPDATE model_invocations SET status=$2,response=$3::jsonb,input_tokens=$4,output_tokens=$5,provider_request_id=$6,failure_code=$7,completed_at=now() WHERE id=$1`,
        [
          id,
          status,
          reply ? JSON.stringify(reply) : null,
          reply?.inputTokens ?? null,
          reply?.outputTokens ?? null,
          reply?.requestId ?? null,
          failure?.code ?? null,
        ],
      );
      await em.query(
        'UPDATE creation_runs SET charged_tokens=charged_tokens+$2,reserved_tokens=reserved_tokens-$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [this.runId, charged, released],
      );
    });
  }
  async tool(
    agent: AgentRow,
    callId: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
    success: boolean,
    loaded: string[],
  ) {
    await this.locked(async (em, run) => {
      this.check(run);
      await em.query(
        `INSERT INTO tool_executions(id,run_id,agent_run_id,call_id,name,input,result,status)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(agent_run_id,call_id) DO NOTHING`,
        [
          randomUUID(),
          this.runId,
          agent.id,
          callId,
          name,
          JSON.stringify(input),
          result,
          success ? 'succeeded' : 'denied',
        ],
      );
      await em.query('UPDATE agent_runs SET loaded_skill_keys=$2::jsonb WHERE id=$1', [
        agent.id,
        JSON.stringify(loaded),
      ]);
      await em.increment(RunEntity, { id: this.runId }, 'revision', 1);
    });
  }
  async message(from: string, to: string, kind: TeamMessage['kind'], content: string) {
    await this.locked(async (em) => {
      await em.query(
        `INSERT INTO team_messages(id,run_id,sender,recipient,kind,content)
        SELECT $1::uuid,$2::uuid,$3::varchar(80),$4::varchar(80),$5::varchar(24),$6::text
        WHERE NOT EXISTS(SELECT 1 FROM team_messages WHERE run_id=$2::uuid AND sender=$3::varchar(80) AND recipient=$4::varchar(80) AND kind=$5::varchar(24) AND content=$6::text)`,
        [randomUUID(), this.runId, from, to, kind, content],
      );
      await em.increment(RunEntity, { id: this.runId }, 'revision', 1);
    });
  }
}

export async function readExecution(
  db: DataSource | EntityManager,
  run: RunEntity,
): Promise<RunExecution> {
  // A transactional EntityManager shares one connection; do not pipeline concurrent queries on it.
  const agents = await db.query<AgentRow[]>(
    'SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id',
    [run.id],
  );
  const invocations = await db.query<InvocationRow[]>(
    'SELECT * FROM model_invocations WHERE run_id=$1 ORDER BY created_at,id',
    [run.id],
  );
  const tools = await db.query<
    {
      id: string;
      agent_run_id: string;
      name: string;
      input: Record<string, unknown>;
      result: string;
      status: ToolExecution['status'];
      created_at: Date;
    }[]
  >('SELECT * FROM tool_executions WHERE run_id=$1 ORDER BY created_at,id', [run.id]);
  const messages = await db.query<
    {
      id: string;
      sender: string;
      recipient: string;
      kind: TeamMessage['kind'];
      content: string;
      created_at: Date;
    }[]
  >('SELECT * FROM team_messages WHERE run_id=$1 ORDER BY created_at,id', [run.id]);
  const reconciliations = await db.query<{ id: string; note: string; created_at: Date }[]>(
    'SELECT id,note,created_at FROM invocation_reconciliations WHERE run_id=$1 ORDER BY created_at,id',
    [run.id],
  );
  return {
    ...(run.snapshot.workflow === 'team-dynamic-v1'
      ? { collaboration: await readTeamActions(db, run.id) }
      : {}),
    agents: agents.map((a) => ({
      id: a.id,
      agentId: a.agent_id,
      name: a.name,
      role: a.role,
      phase: a.phase,
      task: a.task,
      dependencies: a.dependencies,
      status: a.status,
      loadedSkillKeys: a.loaded_skill_keys,
      result: a.result,
      failureCode: a.failure_code,
    })),
    invocations: invocations.map((i) => ({
      id: i.id,
      agentRunId: i.agent_run_id,
      turn: i.turn,
      status: i.status,
      reservedTokens: i.reserved_tokens,
      inputTokens: i.input_tokens,
      outputTokens: i.output_tokens,
      providerRequestId: i.provider_request_id,
      failureCode: i.failure_code,
      createdAt: i.created_at.toISOString(),
      completedAt: i.completed_at?.toISOString() ?? null,
    })),
    tools: tools.map((t) => ({
      id: t.id,
      agentRunId: t.agent_run_id,
      name: t.name,
      input: t.input,
      result: t.result,
      status: t.status,
      createdAt: t.created_at.toISOString(),
    })),
    messages: messages.map((m) => ({
      id: m.id,
      from: m.sender,
      to: m.recipient,
      kind: m.kind,
      content: m.content,
      createdAt: m.created_at.toISOString(),
    })),
    reconciliations: reconciliations.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.created_at.toISOString(),
    })),
    usage: {
      calls: run.invocationCount,
      chargedTokens: run.chargedTokens,
      reservedTokens: run.reservedTokens,
      reportedInputTokens: invocations.reduce((n, i) => n + (i.input_tokens ?? 0), 0),
      reportedOutputTokens: invocations.reduce((n, i) => n + (i.output_tokens ?? 0), 0),
      hasEstimatedUsage: invocations.some(
        (i) => i.status === 'unknown' || (i.status === 'succeeded' && i.input_tokens === null),
      ),
    },
  };
}

export async function readTeamActions(
  db: DataSource | EntityManager,
  runId: string,
): Promise<TeamAction[]> {
  const rows: {
    id: string;
    source_agent_run_id: string;
    directive: TeamAction['directive'];
    state: TeamAction['state'];
    response: TeamAction['response'];
    spawned_agent_ids: string[];
    created_at: Date;
  }[] = await db.query('SELECT * FROM team_actions WHERE run_id=$1 ORDER BY created_at,id', [
    runId,
  ]);
  return rows.map((r) => ({
    id: r.id,
    sourceAgentRunId: r.source_agent_run_id,
    directive: r.directive,
    state: r.state,
    response: r.response,
    spawnedAgentIds: r.spawned_agent_ids,
    createdAt: r.created_at.toISOString(),
  }));
}
