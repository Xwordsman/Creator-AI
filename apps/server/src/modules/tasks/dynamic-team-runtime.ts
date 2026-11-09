import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import {
  teamDirectiveSchema,
  type AgentDefinition,
  type RunOutput,
  type TeamAction,
  type TeamDirective,
} from '@creator-ai/contracts';
import type { RunEntity } from '../../database/entities';
import { AgentRuntime, textOutput } from './agent-runtime';
import {
  readTeamActions,
  RuntimeStop,
  RuntimeStore,
  RuntimeWait,
  type AgentRow,
} from './runtime-store';
import { ProviderError, type ChatMessage } from '../models/compatible-provider';

const PLANNER_PROTOCOL = `动态团队协议：只输出一个严格 JSON 对象，不要代码围栏，不调用技能工具。
你是负责人，基于已确认交付和用户答复规划工作，配置阶段仅作为参考，不冒充成员工作。
可用动作：
{"action":"delegate","summary":"为什么这样分工","tasks":[{"memberId":"已有非负责人成员ID","task":"具体交付要求","dependencies":["已交付任务的UUID"]}]}
{"action":"ask_user","question":"需要用户提供的信息"}
{"action":"confirm","question":"需要用户确认的取舍"}
{"action":"finalize","summary":"如何汇总已有交付"}
所有 delegate 提案必须等待用户批准；拒绝后应根据反馈重规划。每个提案同一成员至多一个任务。
只能引用已 deliver 的任务 UUID，不能引用未来任务，不新增成员。每轮可继续派工补充审校。
最多 6 次规划、24 次成员任务、4 次同伴追问、8 次用户交互；还受总调用/Token/时间预算限制。
至少有一份成员交付才能 finalize；finalize 后另一次负责人调用生成完整正文。`;
const MEMBER_PROTOCOL = `动态成员协议：最终只输出一个严格 JSON 对象，不要代码围栏。可按权限使用技能工具。
完成交付：{"action":"deliver","content":"完整交付正文"}
需要同伴补充：{"action":"request_peer","memberId":"已有非负责人成员ID（不能是自己）","question":"具体追问"}
需要用户资料：{"action":"ask_user","question":"具体问题"}
request_peer 会真实调用该成员，然后以独立新任务将答复交回给你，不能伪造成员发言。`;
const PEER_PROTOCOL =
  '同伴答复协议：你在回答一位成员的追问。只输出 {"action":"deliver","content":"完整答复"}，不再追问或派工；不确定事项明确标注。可以按权限使用技能。';

export class DynamicTeamRuntime {
  constructor(
    private readonly db: DataSource,
    private readonly runtime: AgentRuntime,
  ) {}

  async execute(run: RunEntity, lease: string, signal: AbortSignal): Promise<RunOutput> {
    const store = new RuntimeStore(this.db, run.id, lease);
    if (!(await store.agents()).length) await this.nextPlanner(run, store);
    // Sequential dispatch intentionally avoids leaving another request in flight at a human pause.
    for (;;) {
      await store.guard();
      const agents = await store.agents();
      const actions = await readTeamActions(this.db, run.id);
      const waiting = actions.find((a) => a.state === 'waiting');
      if (waiting) {
        if (!waiting.response) throw new RuntimeWait();
        await this.applyResponse(run, store, waiting);
        continue;
      }
      const peer = actions.find(
        (a) =>
          a.state === 'peer_wait' &&
          actions.some(
            (result) =>
              result.sourceAgentRunId === a.spawnedAgentIds[0] &&
              result.directive.action === 'deliver',
          ),
      );
      if (peer) {
        await this.resumePeer(run, store, peer);
        continue;
      }
      const unprocessed = agents.find(
        (a) =>
          a.status === 'succeeded' &&
          a.role !== 'lead' &&
          !actions.some((action) => action.sourceAgentRunId === a.id),
      );
      if (unprocessed) {
        await this.record(run, store, unprocessed);
        continue;
      }
      const final = agents.find((a) => a.role === 'lead' && a.status === 'succeeded');
      if (final?.result) return textOutput(run.snapshot, final.result);
      const next = agents.find((a) => a.status === 'pending' || a.status === 'running');
      if (next) {
        const deps = agents.filter((a) => next.dependencies.includes(a.id));
        if (deps.length !== next.dependencies.length || deps.some((a) => a.status !== 'succeeded'))
          throw new RuntimeStop('DEPENDENCY_NOT_READY');
        try {
          const result = await this.runtime.executeAgent(run, next, deps, store, signal);
          await store.agentState(next.id, 'succeeded', result);
          await store.message(
            next.agent_id,
            run.snapshot.expert.team!.leadAgent,
            'report',
            `任务 ${next.id}：${result}`,
          );
        } catch (error) {
          await store.agentState(
            next.id,
            error instanceof ProviderError && error.ambiguous ? 'unknown' : 'failed',
            null,
            error instanceof ProviderError || error instanceof RuntimeStop
              ? error.code
              : 'AGENT_EXECUTION_FAILED',
          );
          throw error;
        }
        continue;
      }
      if (
        agents.some((a) => a.status !== 'succeeded') ||
        actions.some((a) => a.state !== 'applied')
      )
        throw new RuntimeStop('TEAM_DEPENDENCY_BLOCKED');
      await this.nextPlanner(run, store);
    }
  }

  private row(
    run: RunEntity,
    agents: AgentRow[],
    definition: AgentDefinition,
    role: AgentRow['role'],
    task: string,
    dependencies: string[],
    messages: ChatMessage[],
  ): AgentRow {
    return {
      id: randomUUID(),
      run_id: run.id,
      agent_id: definition.agentId,
      name: definition.name,
      role,
      phase: Math.max(-1, ...agents.map((a) => a.phase)) + 1,
      task,
      dependencies,
      definition,
      status: 'pending',
      messages,
      loaded_skill_keys: [],
      result: null,
      failure_code: null,
    };
  }
  private member(run: RunEntity, id: string): AgentDefinition {
    const team = run.snapshot.expert.team!;
    const member = team.members.find((m) => m.agentId === id && id !== team.leadAgent);
    if (!member) throw new RuntimeStop('TEAM_MEMBER_OUT_OF_SCOPE');
    return member;
  }
  private async insert(em: EntityManager, run: RunEntity, rows: AgentRow[]) {
    const counts: { count: string }[] = await em.query(
      "SELECT count(*) FROM agent_runs WHERE run_id=$1 AND role='member'",
      [run.id],
    );
    if (Number(counts[0]!.count) + rows.filter((a) => a.role === 'member').length > 24)
      throw new RuntimeStop('TEAM_TASK_LIMIT');
    for (const a of rows) {
      await em.query(
        `INSERT INTO agent_runs(id,run_id,agent_id,name,role,phase,task,dependencies,definition,messages)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
        [
          a.id,
          run.id,
          a.agent_id,
          a.name,
          a.role,
          a.phase,
          a.task,
          JSON.stringify(a.dependencies),
          JSON.stringify(a.definition),
          JSON.stringify(a.messages),
        ],
      );
      await this.message(
        em,
        run.id,
        run.snapshot.expert.team!.leadAgent,
        a.agent_id,
        'assignment',
        `任务 ${a.id}：${a.task}`,
      );
    }
    await em.query('UPDATE creation_runs SET revision=revision+1,updated_at=now() WHERE id=$1', [
      run.id,
    ]);
  }
  private async message(
    em: EntityManager,
    id: string,
    from: string,
    to: string,
    kind: string,
    content: string,
  ) {
    await em.query(
      'INSERT INTO team_messages(id,run_id,sender,recipient,kind,content) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), id, from, to, kind, content],
    );
  }
  private history(actions: TeamAction[]): ChatMessage {
    return {
      role: 'user',
      content: JSON.stringify({
        collaborationHistory: actions.map((a) => ({
          sourceTaskId: a.sourceAgentRunId,
          directive: a.directive.action === 'deliver' ? { action: 'deliver' } : a.directive,
          response: a.response,
        })),
      }),
    };
  }
  private completed(actions: TeamAction[]) {
    return actions.filter((a) => a.directive.action === 'deliver').map((a) => a.sourceAgentRunId);
  }
  private async nextPlanner(run: RunEntity, store: RuntimeStore) {
    await store.locked(async (em, current) => {
      store.check(current);
      const agents: AgentRow[] = await em.query(
        'SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id',
        [run.id],
      );
      if (agents.some((a) => a.status !== 'succeeded'))
        throw new RuntimeStop('TEAM_DEPENDENCY_BLOCKED');
      if (agents.filter((a) => a.role === 'planner').length >= 6)
        throw new RuntimeStop('TEAM_PLAN_LIMIT');
      const actions = await readTeamActions(em, run.id);
      const lead = run.snapshot.expert.team!.members.find(
        (m) => m.agentId === run.snapshot.expert.team!.leadAgent,
      )!;
      const definition = { ...lead, skillKeys: [], preloadSkillKeys: [], maxTurns: 1 };
      await this.insert(em, run, [
        this.row(
          run,
          agents,
          definition,
          'planner',
          '根据当前交付、用户反馈和剩余预算决定下一步协作。',
          this.completed(actions),
          [
            { role: 'system', content: PLANNER_PROTOCOL },
            {
              role: 'user',
              content: JSON.stringify({
                roster: run.snapshot.expert.team!.members.map((m) => ({
                  memberId: m.agentId,
                  name: m.name,
                  description: m.description,
                  profession: m.profession,
                })),
                configuredPhases: run.snapshot.expert.team!.phases ?? [],
                budget: { calls: current.invocationCount, limits: current.snapshot.limits },
              }),
            },
            this.history(actions),
          ],
        ),
      ]);
    });
  }

  private async record(run: RunEntity, store: RuntimeStore, agent: AgentRow) {
    let directive: TeamDirective;
    try {
      directive = teamDirectiveSchema.parse(JSON.parse(agent.result!));
    } catch {
      throw new RuntimeStop('TEAM_PROTOCOL_INVALID');
    }
    const allowed =
      agent.role === 'planner'
        ? ['delegate', 'ask_user', 'confirm', 'finalize']
        : ['deliver', 'ask_user', 'request_peer'];
    if (
      !allowed.includes(directive.action) ||
      (agent.messages[0]?.content === PEER_PROTOCOL && directive.action !== 'deliver')
    )
      throw new RuntimeStop('TEAM_ACTION_NOT_ALLOWED');
    await store.locked(async (em, current) => {
      store.check(current);
      const actions = await readTeamActions(em, run.id);
      if (actions.some((a) => a.sourceAgentRunId === agent.id)) return;
      const agents: AgentRow[] = await em.query(
        'SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id',
        [run.id],
      );
      let state: TeamAction['state'] = 'applied';
      const spawned: AgentRow[] = [];
      if (['delegate', 'ask_user', 'confirm'].includes(directive.action)) {
        if (
          actions.filter((a) => ['delegate', 'ask_user', 'confirm'].includes(a.directive.action))
            .length >= 8
        )
          throw new RuntimeStop('TEAM_INTERACTION_LIMIT');
        state = 'waiting';
      }
      if (directive.action === 'delegate') {
        const delivered = new Set(this.completed(actions));
        if (new Set(directive.tasks.map((t) => t.memberId)).size !== directive.tasks.length)
          throw new RuntimeStop('TEAM_DUPLICATE_MEMBER');
        for (const task of directive.tasks) {
          this.member(run, task.memberId);
          if (
            new Set(task.dependencies).size !== task.dependencies.length ||
            task.dependencies.some((id) => !delivered.has(id))
          )
            throw new RuntimeStop('TEAM_INVALID_DEPENDENCY');
        }
        if (agents.filter((a) => a.role === 'member').length + directive.tasks.length > 24)
          throw new RuntimeStop('TEAM_TASK_LIMIT');
      }
      if (directive.action === 'finalize') {
        const deps = this.completed(actions);
        if (!deps.length) throw new RuntimeStop('TEAM_NO_DELIVERABLE');
        const lead = run.snapshot.expert.team!.members.find(
          (m) => m.agentId === run.snapshot.expert.team!.leadAgent,
        )!;
        spawned.push(
          this.row(
            run,
            agents,
            lead,
            'lead',
            `汇总完整候选正文，不只输出说明。负责人汇总要求：${directive.summary}`,
            deps,
            [this.history(actions)],
          ),
        );
      }
      if (directive.action === 'request_peer') {
        if (directive.memberId === agent.agent_id) throw new RuntimeStop('TEAM_SELF_REQUEST');
        if (actions.filter((a) => a.directive.action === 'request_peer').length >= 4)
          throw new RuntimeStop('TEAM_PEER_LIMIT');
        spawned.push(
          this.row(
            run,
            agents,
            this.member(run, directive.memberId),
            'member',
            `${agent.name} 对任务 ${agent.id} 的追问：${directive.question}`,
            agent.dependencies,
            [{ role: 'system', content: PEER_PROTOCOL }, this.history(actions)],
          ),
        );
        state = 'peer_wait';
      }
      await this.insert(em, run, spawned);
      await em.query(
        `INSERT INTO team_actions(id,run_id,source_agent_run_id,directive,state,spawned_agent_ids)
        VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
        [
          randomUUID(),
          run.id,
          agent.id,
          JSON.stringify(directive),
          state,
          JSON.stringify(spawned.map((a) => a.id)),
        ],
      );
      if (state === 'waiting' || directive.action === 'request_peer')
        await this.message(
          em,
          run.id,
          agent.agent_id,
          directive.action === 'request_peer' ? directive.memberId : 'user',
          directive.action === 'delegate'
            ? 'plan'
            : directive.action === 'confirm'
              ? 'confirmation'
              : 'question',
          JSON.stringify(directive),
        );
    });
  }

  private async applyResponse(run: RunEntity, store: RuntimeStore, action: TeamAction) {
    await store.locked(async (em, current) => {
      store.check(current);
      const actions = await readTeamActions(em, run.id);
      const item = actions.find((a) => a.id === action.id)!;
      if (item.state !== 'waiting' || !item.response) return;
      const agents: AgentRow[] = await em.query(
        'SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id',
        [run.id],
      );
      const source = agents.find((a) => a.id === item.sourceAgentRunId)!;
      const spawned: AgentRow[] = [];
      if (item.directive.action === 'delegate' && item.response.approved) {
        for (const task of item.directive.tasks)
          spawned.push(
            this.row(
              run,
              agents,
              this.member(run, task.memberId),
              'member',
              task.task,
              task.dependencies,
              [{ role: 'system', content: MEMBER_PROTOCOL }, this.history(actions)],
            ),
          );
      } else if (source.role === 'member') {
        spawned.push(
          this.row(run, agents, source.definition, 'member', source.task, source.dependencies, [
            { role: 'system', content: MEMBER_PROTOCOL },
            this.history(actions),
          ]),
        );
      }
      await this.insert(em, run, spawned);
      await em.query(
        "UPDATE team_actions SET state='applied',spawned_agent_ids=$2::jsonb WHERE id=$1",
        [item.id, JSON.stringify(spawned.map((a) => a.id))],
      );
    });
  }
  private async resumePeer(run: RunEntity, store: RuntimeStore, action: TeamAction) {
    await store.locked(async (em, current) => {
      store.check(current);
      const actions = await readTeamActions(em, run.id);
      const item = actions.find((a) => a.id === action.id)!;
      if (item.state !== 'peer_wait') return;
      const agents: AgentRow[] = await em.query(
        'SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY phase,agent_id',
        [run.id],
      );
      const source = agents.find((a) => a.id === item.sourceAgentRunId)!;
      const continuation = this.row(
        run,
        agents,
        source.definition,
        'member',
        source.task,
        [...new Set([...source.dependencies, item.spawnedAgentIds[0]!])],
        [{ role: 'system', content: MEMBER_PROTOCOL }, this.history(actions)],
      );
      await this.insert(em, run, [continuation]);
      await em.query(
        "UPDATE team_actions SET state='applied',spawned_agent_ids=$2::jsonb WHERE id=$1",
        [item.id, JSON.stringify([...item.spawnedAgentIds, continuation.id])],
      );
    });
  }
}
