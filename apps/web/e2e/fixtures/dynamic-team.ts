import { expect, type Page } from '@playwright/test';
import type {
  Account,
  CreateRunInput,
  CreationRun,
  Expert,
  ModelConnection,
  TeamAction,
  TeamResponse,
} from '@creator-ai/contracts';

const createdAt = '2026-11-02T08:00:00Z';
export const runId = '33333333-3333-4333-8333-333333333333';
export const plannerId = '77777777-7777-4777-8777-777777777777';
export const memberRunId = '88888888-8888-4888-8888-888888888888';
export const actionId = '99999999-9999-4999-8999-999999999999';
const account: Account = {
  revision: 1,
  defaultExpertId: null,
  id: '11111111-1111-4111-8111-111111111111',
  name: '日常观察',
  platform: 'wechat',
  audience: '普通读者',
  persona: '克制、真诚，不编造经历。',
  createdAt,
};
const expert: Expert = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '独立主笔',
  version: 1,
  createdAt,
  description: '独立写作',
  instructions: '不编造事实',
  skillKeys: [],
  expertType: 'agent',
};
export const team: Expert = {
  ...expert,
  id: '55555555-5555-4555-8555-555555555555',
  name: '动态编辑部',
  expertType: 'team',
  team: {
    leadAgent: 'editor',
    members: [
      {
        agentId: 'editor',
        name: '林主编',
        description: '规划与汇总',
        instructions: '先澄清需求',
        skillKeys: [],
      },
      {
        agentId: 'writer',
        name: '周主笔',
        description: '撰写正文',
        instructions: '不编造数据',
        skillKeys: [],
      },
    ],
    phases: [{ name: '初稿', agents: ['writer'], task: '交付初稿' }],
  },
};
const model: ModelConnection = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '本地 fixture 连接',
  baseUrl: 'https://api.example.com/v1',
  model: 'fixture-model',
  tokenParameter: 'max_completion_tokens',
  maxInputTokens: 16000,
  maxOutputTokens: 4096,
  enabled: true,
  hasKey: true,
  createdAt,
};
export function teamAction(
  directive: TeamAction['directive'] = { action: 'ask_user', question: '这篇内容面向哪类读者？' },
): TeamAction {
  return {
    id: actionId,
    sourceAgentRunId: plannerId,
    directive,
    state: 'waiting',
    response: null,
    spawnedAgentIds: [],
    createdAt,
  };
}
export function delegateAction(): TeamAction {
  return teamAction({
    action: 'delegate',
    summary: '先补充读者视角，再写初稿。',
    tasks: [
      {
        memberId: 'writer',
        task: '围绕读者问题完成初稿，不编造事实。',
        dependencies: [memberRunId],
      },
      { memberId: 'writer', task: '独立检查标题是否准确。', dependencies: [] },
    ],
  });
}
export function dynamicRun(actions: TeamAction[] = [teamAction()]): CreationRun {
  return {
    id: runId,
    status: 'waiting_user',
    revision: 3,
    attempts: 1,
    createdAt,
    updatedAt: createdAt,
    failureCode: null,
    output: null,
    snapshot: {
      schemaVersion: 1,
      topic: '动态协作的创作手记',
      brief: '',
      provider: 'compatible',
      workflow: 'team-dynamic-v1',
      account,
      expert: team,
      skills: [],
      model,
      limits: { maxCalls: 24, maxTotalTokens: 200000, maxDurationSeconds: 600 },
    },
    execution: {
      agents: [
        {
          id: memberRunId,
          agentId: 'writer',
          name: '周主笔',
          role: 'member',
          phase: 0,
          task: '上一轮读者视角',
          dependencies: [],
          status: 'succeeded',
          loadedSkillKeys: [],
          result: '读者视角已提交。',
          failureCode: null,
        },
        {
          id: plannerId,
          agentId: 'editor',
          name: '林主编',
          role: 'planner',
          phase: 1,
          task: '根据读者视角继续规划',
          dependencies: [memberRunId],
          status: 'succeeded',
          loadedSkillKeys: [],
          result: null,
          failureCode: null,
        },
      ],
      invocations: [
        {
          id: 'fixture-invocation',
          agentRunId: plannerId,
          turn: 2,
          status: 'succeeded',
          reservedTokens: 2000,
          inputTokens: 100,
          outputTokens: 50,
          providerRequestId: 'fixture-provider',
          failureCode: null,
          createdAt,
          completedAt: createdAt,
        },
      ],
      tools: [],
      messages: (
        ['assignment', 'report', 'question', 'answer', 'plan', 'confirmation'] as const
      ).map((kind) => ({
        id: `message-${kind}`,
        from: plannerId,
        to: 'writer',
        kind,
        content: `持久消息 ${kind}`,
        createdAt,
      })),
      reconciliations: [],
      collaboration: actions,
      usage: {
        calls: 2,
        chargedTokens: 150,
        reservedTokens: 0,
        reportedInputTokens: 100,
        reportedOutputTokens: 50,
        hasEstimatedUsage: false,
      },
    },
  };
}

export async function dynamicFixture(page: Page, run = dynamicRun()) {
  const state = {
    run,
    owner: 'fixture-owner',
    creates: [] as { body: CreateRunInput; key: string }[],
    responses: [] as { actionId: string; body: TeamResponse }[],
    cancellations: 0,
    reads: 0,
    events: 0,
    failCreates: false,
    failResponses: 0,
    loseResponses: 0,
    conflictResponses: false,
    responseGate: null as Promise<void> | null,
  };
  const accepted = new Map<string, string>();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, requestId: 'dynamic-fixture' } });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 100 });
    const fail = (status: number, message: string) =>
      route.fulfill({ status, json: { error: { code: 'FIXTURE', message, retryable: false } } });
    if (path === '/auth/session')
      return json({
        user: { id: state.owner, username: 'creator' },
        csrfToken: 'fixture-csrf',
        expiresAt: '2026-11-09T08:00:00Z',
      });
    if (path === '/models/capabilities')
      return json({
        modelMode: 'configured',
        canConfigureModels: true,
        allowedHosts: [],
        tools: [],
      });
    if (path === '/accounts') return list([account]);
    if (path === '/experts') return list([expert, team]);
    if (path === '/models') return json([model]);
    if (path === '/creation-runs') {
      if (request.method() !== 'POST') return list([state.run]);
      expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
      const body = request.postDataJSON() as CreateRunInput;
      state.creates.push({ body, key: request.headers()['idempotency-key']! });
      if (state.failCreates) return fail(503, '创建结果暂未确认');
      state.run.snapshot = {
        ...state.run.snapshot,
        topic: body.topic,
        workflow: body.teamMode === 'dynamic' ? 'team-dynamic-v1' : 'team-v1',
      };
      return json(state.run, 202);
    }
    if (path === `/creation-runs/${state.run.id}`) {
      state.reads++;
      return json(state.run);
    }
    if (path === `/creation-runs/${state.run.id}/history`) return list([]);
    if (path === `/creation-runs/${state.run.id}/events`) {
      state.events++;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: stream.unavailable\ndata: {}\n\n',
      });
    }
    if (path === `/creation-runs/${state.run.id}/cancel`) {
      state.cancellations++;
      state.run = {
        ...state.run,
        status: 'cancelled',
        cancelRequested: true,
        revision: state.run.revision + 1,
      };
      return json(state.run);
    }
    const match = path.match(/^\/creation-runs\/[^/]+\/actions\/([^/]+)\/respond$/);
    if (match) {
      expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
      const id = match[1]!;
      const body = request.postDataJSON() as TeamResponse;
      state.responses.push({ actionId: id, body });
      if (state.responseGate) await state.responseGate;
      if (state.failResponses > 0) {
        state.failResponses--;
        return fail(503, '答复结果暂未确认');
      }
      if (
        state.conflictResponses ||
        (accepted.has(id) && accepted.get(id) !== JSON.stringify(body))
      )
        return fail(409, '该交互已有不同答复');
      if (!accepted.has(id)) {
        accepted.set(id, JSON.stringify(body));
        state.run = {
          ...state.run,
          status: 'running',
          revision: state.run.revision + 1,
          execution: {
            ...state.run.execution!,
            collaboration: state.run.execution!.collaboration!.map((action) =>
              action.id === id ? { ...action, state: 'applied', response: body } : action,
            ),
          },
        };
      }
      if (state.loseResponses > 0) {
        state.loseResponses--;
        return fail(503, '服务端已记录，但响应未确认');
      }
      return json(state.run);
    }
    return fail(404, `Unmocked fixture endpoint: ${path}`);
  });
  return state;
}

export async function selectTeam(page: Page) {
  await page.getByLabel('本次使用的模型', { exact: true }).press('Enter');
  await page
    .getByRole('option', { name: '本地 fixture 连接 · fixture-model', exact: true })
    .click();
  await page.getByLabel('交给哪位专家', { exact: true }).press('Enter');
  await page.getByRole('option', { name: '动态编辑部（专家团）', exact: true }).click();
  await page.getByLabel('这次，你想聊什么？').fill('动态协作的创作手记');
}

export async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
