import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  Account,
  CreationRun,
  Expert,
  ModelConnection,
  RunExecution,
  Skill,
} from '@creator-ai/contracts';

const account: Account = {
  revision: 1,
  defaultExpertId: null,
  id: '11111111-1111-4111-8111-111111111111',
  name: '日常 AI 观察',
  platform: 'wechat',
  audience: '想把 AI 用进日常工作的普通人',
  persona: '一位克制、真诚的技术观察者。用日常语言解释技术，不编造亲身经历。',
  createdAt: '2026-11-01T10:00:00Z',
};
const expert: Expert = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '公众号主笔',
  description: '把复杂的话题，写成有观点、好理解的文章。',
  instructions: '先澄清问题，再组织论点，不编造数据。',
  skillKeys: ['article-outline', 'plain-writing', 'fact-check'],
  version: 1,
  createdAt: '2026-11-01T10:00:00Z',
};
const model: ModelConnection = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '测试模型连接',
  baseUrl: 'https://api.example.com/v1',
  model: 'fixture-model',
  tokenParameter: 'max_completion_tokens',
  maxInputTokens: 16000,
  maxOutputTokens: 4096,
  enabled: true,
  hasKey: true,
  createdAt: account.createdAt,
};
const teamExpert: Expert = {
  ...expert,
  id: '55555555-5555-4555-8555-555555555555',
  name: '测试编辑部',
  expertType: 'team',
  team: {
    leadAgent: 'editor',
    members: [
      {
        agentId: 'editor',
        name: '主编',
        description: '汇总',
        instructions: '核对并汇总成员交付',
        skillKeys: [],
      },
      {
        agentId: 'writer',
        name: '主笔',
        description: '写作',
        instructions: '独立完成初稿',
        skillKeys: ['plain-writing'],
      },
    ],
    phases: [{ name: '初稿', agents: ['writer'], task: '完成候选正文' }],
  },
};
function execution(): RunExecution {
  return {
    agents: [
      {
        id: 'member-run',
        agentId: 'writer',
        name: '主笔',
        role: 'member',
        phase: 0,
        task: '完成独立初稿',
        dependencies: [],
        status: 'succeeded',
        loadedSkillKeys: ['plain-writing'],
        result: '成员独立交付：待审核的初稿。',
        failureCode: null,
      },
      {
        id: 'lead-run',
        agentId: 'editor',
        name: '主编',
        role: 'lead',
        phase: 1,
        task: '汇总候选正文',
        dependencies: ['member-run'],
        status: 'succeeded',
        loadedSkillKeys: [],
        result: '主编汇总内容。',
        failureCode: null,
      },
    ],
    invocations: ['member-run', 'lead-run'].map((agentRunId, index) => ({
      id: `invocation-${index}`,
      agentRunId,
      turn: 1,
      status: 'succeeded',
      reservedTokens: 1000,
      inputTokens: 80,
      outputTokens: 30,
      providerRequestId: `provider-${index}`,
      failureCode: null,
      createdAt: account.createdAt,
      completedAt: account.createdAt,
    })),
    tools: [
      {
        id: 'tool-load',
        agentRunId: 'member-run',
        name: 'load_skill',
        input: { key: 'plain-writing' },
        result: '已加载快照中的原创写作方法。',
        status: 'succeeded',
        createdAt: account.createdAt,
      },
    ],
    messages: [
      {
        id: 'report',
        from: 'writer',
        to: 'editor',
        kind: 'report',
        content: '独立初稿已经交付主编。',
        createdAt: account.createdAt,
      },
    ],
    reconciliations: [],
    usage: {
      calls: 2,
      chargedTokens: 220,
      reservedTokens: 0,
      reportedInputTokens: 160,
      reportedOutputTokens: 60,
      hasEstimatedUsage: false,
    },
  };
}
function modelRun(status: CreationRun['status'] = 'succeeded'): CreationRun {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    status,
    revision: 10,
    attempts: 1,
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
    failureCode: status === 'needs_review' ? 'PROVIDER_TRANSPORT_UNKNOWN' : null,
    output: null,
    snapshot: {
      schemaVersion: 1,
      topic: '专家团运行记录',
      brief: '',
      provider: 'compatible',
      workflow: 'team-v1',
      account,
      expert: teamExpert,
      skills: [],
      model,
      limits: { maxCalls: 24, maxTotalTokens: 200000, maxDurationSeconds: 600 },
    },
    execution: execution(),
  };
}

async function mockApi(page: Page, empty = false, loggedIn = true, configured = false) {
  const { BUILTIN_SKILLS } = await import('@creator-ai/contracts');
  const accounts = empty ? [] : [{ ...account }];
  const experts = empty ? [] : [{ ...expert }];
  const skills: Skill[] = BUILTIN_SKILLS.map((skill) => ({ ...skill, source: 'builtin' }));
  const runs: CreationRun[] = [];
  const connections: ModelConnection[] = [];
  const continuationKeys = new Map<string, CreationRun>();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, requestId: 'browser-fixture' } });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 100 });
    if (path === '/auth/login') loggedIn = true;
    if (!loggedIn)
      return route.fulfill({
        status: 401,
        json: { error: { code: 'AUTH_REQUIRED', message: '请先登录。', retryable: false } },
      });
    if (path === '/auth/session' || path === '/auth/login')
      return json({
        user: { id: 'owner', username: 'creator' },
        csrfToken: 'test-csrf',
        expiresAt: '2026-11-08T10:00:00Z',
      });
    if (path === '/auth/logout') {
      loggedIn = false;
      return json({ loggedOut: true });
    }
    if (path === '/models/capabilities')
      return json({
        modelMode: configured ? 'configured' : 'mock',
        canConfigureModels: configured,
        allowedHosts: configured ? ['api.example.com'] : [],
        tools: ['load_skill', 'read_skill_file'],
      });
    if (path === '/models') {
      if (method === 'POST') {
        const config = request.postDataJSON();
        delete config.apiKey;
        connections.push({ ...model, ...config });
        return json(connections.at(-1), 201);
      }
      return json(connections);
    }
    if (path === `/models/${model.id}/availability`) {
      connections[0]!.enabled = request.postDataJSON().enabled;
      return json(connections[0]);
    }
    if (path === '/skills') {
      if (method === 'POST') {
        const input = request.postDataJSON() as { key: string; document: string };
        const skill: Skill = {
          ...input,
          name: input.key,
          description: 'A custom skill',
          instructions: input.document,
          version: 1,
          allowedTools: [],
          source: 'custom',
        };
        skills.push(skill);
        return json(skill, 201);
      }
      return list(skills);
    }
    if (path === '/accounts') {
      if (method === 'POST') {
        accounts.push({
          ...request.postDataJSON(),
          id: account.id,
          revision: 1,
          defaultExpertId: request.postDataJSON().defaultExpertId ?? null,
          createdAt: account.createdAt,
        });
        return json(accounts.at(-1), 201);
      }
      return list(accounts);
    }
    if (path === '/experts') {
      if (method === 'POST') {
        experts.push({
          ...request.postDataJSON(),
          id: randomUUID(),
          version: 1,
          createdAt: expert.createdAt,
        });
        return json(experts.at(-1), 201);
      }
      return list(experts);
    }
    if (path.startsWith('/skills/') && path.endsWith('/versions')) {
      const skill = skills.find((item) => item.key === decodeURIComponent(path.split('/')[2]!))!;
      if (method === 'GET') return list([skill]);
      Object.assign(skill, request.postDataJSON(), { version: skill.version + 1 });
      return json(skill);
    }
    if (path.endsWith('/versions')) {
      const old = experts[0]!;
      if (method === 'GET') return list([old]);
      experts[0] = { ...old, ...request.postDataJSON(), version: old.version + 1 };
      return json(experts[0]);
    }
    if (path === '/creation-runs') {
      if (method === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe('test-csrf');
        expect(request.headers()['idempotency-key']).toBeTruthy();
        const input = request.postDataJSON() as {
          topic: string;
          brief: string;
          accountId: string;
          expertId: string;
          modelConnectionId?: string;
        };
        const run: CreationRun = {
          id: '33333333-3333-4333-8333-333333333333',
          status: 'succeeded',
          attempts: 1,
          revision: 3,
          createdAt: account.createdAt,
          updatedAt: account.createdAt,
          failureCode: null,
          snapshot: {
            schemaVersion: 1,
            topic: input.topic,
            brief: input.brief,
            provider: input.modelConnectionId ? 'compatible' : 'mock',
            workflow: input.modelConnectionId ? 'team-v1' : 'mock-article-v1',
            account: accounts[0]!,
            expert: experts.find((item) => item.id === input.expertId)!,
            skills: BUILTIN_SKILLS,
            ...(input.modelConnectionId
              ? { model, limits: { maxCalls: 24, maxTotalTokens: 200000, maxDurationSeconds: 600 } }
              : {}),
          },
          output: {
            schemaVersion: 1,
            title: input.topic,
            isMock: !input.modelConnectionId,
            reviewStatus: 'pending_review',
            document: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: input.modelConnectionId
                        ? '浏览器测试的候选正文，不代表真实模型质量。'
                        : '【模拟草稿】本地模板，仅用于验证流程，未调用 AI。',
                    },
                  ],
                },
                {
                  type: 'heading',
                  attrs: { level: 2 },
                  content: [{ type: 'text', text: '01 / 从一个真实问题开始' }],
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: '在每次创作之前，先想清楚：这篇内容能帮读者解决什么问题？',
                    },
                  ],
                },
              ],
            },
          },
        };
        if (input.modelConnectionId) run.execution = execution();
        runs.push(run);
        return json(run, 202);
      }
      return list(runs);
    }
    const source = runs.find((item) => path === `/creation-runs/${item.id}/continue`);
    if (source && method === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('test-csrf');
      const key = request.headers()['idempotency-key']!;
      expect(key).toBeTruthy();
      if (continuationKeys.has(key)) return json(continuationKeys.get(key), 202);
      const instruction = request.postDataJSON().instruction as string;
      const lineage = {
        parentRunId: source.id,
        rootRunId: source.lineage?.rootRunId ?? source.id,
        depth: (source.lineage?.depth ?? 0) + 1,
      };
      const next: CreationRun = {
        ...structuredClone(source),
        id: randomUUID(),
        lineage,
        snapshot: {
          ...source.snapshot,
          continuation: { ...lineage, instruction, previousOutput: source.output! },
        },
        output: {
          ...source.output!,
          document: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: `模拟修改流程：${instruction}` }],
              },
            ],
          },
        },
      };
      runs.push(next);
      continuationKeys.set(key, next);
      return json(next, 202);
    }
    const historySource = runs.find((item) => path === `/creation-runs/${item.id}/history`);
    if (historySource) {
      const root = historySource.lineage?.rootRunId ?? historySource.id;
      return list(
        runs
          .filter((r) => (r.lineage?.rootRunId ?? r.id) === root)
          .map((r) => ({
            id: r.id,
            status: r.status,
            createdAt: r.createdAt,
            lineage: r.lineage,
            instruction: r.snapshot.continuation?.instruction ?? null,
          }))
          .reverse(),
      );
    }
    const run = runs.find((item) => path === `/creation-runs/${item.id}`);
    if (run) return json(run);
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'Not found' } },
    });
  });
  return { accounts, experts, runs, connections };
}

test('login redirects to the workbench and exposes the mock boundary', async ({ page }) => {
  await mockApi(page, false, false);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('用户名', { exact: true }).fill('creator');
  await page.getByLabel('密码', { exact: true }).fill('not-a-real-credential');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '今天，让想法成稿。' })).toBeVisible();
  await expect(page.getByText('模拟模式 · 不调用模型')).toBeVisible();
});

test('creates an account, an independent expert and a read-only draft', async ({
  page,
}, testInfo) => {
  await mockApi(page, true);
  await page.goto('/accounts');
  await page.getByRole('button', { name: '新建账号', exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('我的公众号');
  await page.getByLabel('目标读者', { exact: true }).fill('普通读者');
  await page.getByLabel('作者人设与表达习惯', { exact: true }).fill('真诚、克制，不编造经历。');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的公众号' })).toBeVisible();
  await page.getByRole('link', { name: '专家中心', exact: true }).click();
  await page.getByRole('button', { name: '从主笔模板创建', exact: true }).click();
  await page.getByRole('button', { name: '创建专家', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公众号主笔', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '配置专家' }).click();
  await page.getByLabel('工作指令与质量要求').fill('先明确读者问题，不编造数据。');
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await expect(page.getByText('v2', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '创作工作台', exact: true }).click();
  await page.getByLabel('这次，你想聊什么？').fill('普通人如何建立 AI 知识库');
  await page.getByRole('button', { name: '生成模拟草稿' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByText('【模拟草稿】本地模板，仅用于验证流程，未调用 AI。')).toBeVisible();
  await expect(page.locator('[contenteditable="false"]')).toBeVisible();
  await page.reload();
  await expect(page.getByText('【模拟草稿】本地模板，仅用于验证流程，未调用 AI。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('draft.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('workbench is usable without horizontal overflow', async ({ page }, testInfo) => {
  await mockApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('当前草稿由固定模板生成', { exact: false })).toBeVisible();
  await page.getByLabel('这次，你想聊什么？').fill('普通人如何建立 AI 知识库');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('workbench.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('continues a draft without overwriting it and retains source links after reload', async ({
  page,
}, testInfo) => {
  const fixture = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('这次，你想聊什么？').fill('分支创作测试');
  await page.getByRole('button', { name: '生成模拟草稿', exact: true }).click();
  await expect(page).toHaveURL(/\/runs\//);
  const originalUrl = page.url();
  const feedback = page.getByLabel('这一轮，你想怎么改？');
  await expect(page.getByRole('button', { name: '生成模拟修改稿' })).toBeDisabled();
  await feedback.fill('保留观点，把开头改得更直接。');
  await page.getByRole('button', { name: '生成模拟修改稿' }).click();
  await expect(page).not.toHaveURL(originalUrl);
  await expect(
    page.getByText('模拟修改流程：保留观点，把开头改得更直接。', { exact: true }),
  ).toBeVisible();
  expect(fixture.runs).toHaveLength(2);
  expect(fixture.runs[0]!.snapshot).not.toHaveProperty('continuation');
  await page.reload();
  await expect(page.getByRole('link', { name: /查看来源稿/ })).toBeVisible();
  await expect(page.getByText('修改分支 · 深度 1', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('continuation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: /查看来源稿/ }).click();
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByLabel('这一轮，你想怎么改？')).toHaveValue('保留观点，把开头改得更直接。');
  await page.reload();
  await page.reload();
  await page.getByRole('button', { name: '生成模拟修改稿' }).click();
  await expect(page).not.toHaveURL(originalUrl);
  expect(fixture.runs).toHaveLength(2);
});

test('retains feedback and idempotency on uncertain submission without automatic retries', async ({
  page,
}) => {
  const fixture = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('这次，你想聊什么？').fill('修改请求重试测试');
  await page.getByRole('button', { name: '生成模拟草稿', exact: true }).click();
  const keys: string[] = [];
  await page.route('**/creation-runs/*/continue', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    return route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '暂不可用，请稍后重试。' } },
    });
  });
  await page.getByLabel('这一轮，你想怎么改？').fill('缩短开头，保留主要结论。');
  await page.getByRole('button', { name: '生成模拟修改稿' }).click();
  await expect(page.getByRole('alert')).toContainText('暂不可用');
  expect(keys).toHaveLength(1);
  await page.reload();
  await page.reload();
  await expect(page.getByLabel('这一轮，你想怎么改？')).toHaveValue('缩短开头，保留主要结论。');
  await page.getByRole('button', { name: '生成模拟修改稿' }).click();
  await expect(page.getByRole('alert')).toContainText('暂不可用');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(fixture.runs).toHaveLength(1);
});

test('a late continuation response cannot navigate away from a different draft', async ({
  page,
}) => {
  const fixture = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('这次，你想聊什么？').fill('页面切换测试');
  await page.getByRole('button', { name: '生成模拟草稿', exact: true }).click();
  let release!: () => void;
  let entered!: () => void;
  const sent = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/creation-runs/*/continue', async (route) => {
    entered();
    await gate;
    await route.fulfill({
      status: 202,
      json: { data: { ...fixture.runs[0], id: '77777777-7777-4777-8777-777777777777' } },
    });
  });
  await page.getByLabel('这一轮，你想怎么改？').fill('请改善开头。');
  await page.getByRole('button', { name: '生成模拟修改稿' }).click();
  await sent;
  await page.getByRole('link', { name: '返回创作记录' }).click();
  await expect(page).toHaveURL(/\/runs$/);
  const received = page.waitForResponse('**/creation-runs/*/continue');
  release();
  await received;
  await expect(page.getByRole('heading', { name: '每个想法，都有来处。' })).toBeVisible();
  await expect(page).toHaveURL(/\/runs$/);
});

test('an expired SSE handshake returns to login rather than reconnecting forever', async ({
  page,
}) => {
  await mockApi(page);
  const id = '33333333-3333-4333-8333-333333333333';
  let expired = false;
  await page.route(`**/creation-runs/${id}`, async (route) => {
    if (expired)
      return route.fulfill({
        status: 401,
        json: { error: { code: 'SESSION_EXPIRED', message: '请重新登录。' } },
      });
    return route.fulfill({
      json: {
        data: {
          id,
          status: 'queued',
          revision: 1,
          attempts: 0,
          output: null,
          failureCode: null,
          createdAt: account.createdAt,
          updatedAt: account.createdAt,
          snapshot: {
            schemaVersion: 1,
            topic: 'Waiting for a worker',
            brief: '',
            provider: 'mock',
            workflow: 'mock-article-v1',
            account,
            expert,
            skills: [],
          },
        },
      },
    });
  });
  await page.route(`**/creation-runs/${id}/events`, (route) => {
    expired = true;
    return route.fulfill({
      status: 401,
      json: { error: { code: 'SESSION_EXPIRED', message: '请重新登录。' } },
    });
  });
  await page.goto(`/runs/${id}`);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: '进入工作空间' })).toBeVisible();
});

test('creates and versions an independent SKILL.md without claiming tool execution', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto('/skills');
  await expect(page.getByText('内置 · 只读')).toHaveCount(3);
  await page.getByRole('button', { name: '新建 Skill', exact: true }).click();
  await page.getByLabel('技能标识', { exact: true }).fill('original-skill');
  await page
    .getByLabel('SKILL.md', { exact: true })
    .fill('---\nname: original-skill\ndescription: 原创写作方法\n---\n不编造事实。');
  await page.getByRole('button', { name: '创建技能', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'original-skill', exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page
    .getByLabel('SKILL.md', { exact: true })
    .fill(
      '---\nname: original-skill\ndescription: 原创写作方法\n---\n不编造事实，保留待核实事项。',
    );
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(card.getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('skills.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('configures a lead, independent member and phase without enabling team execution', async ({
  page,
}, testInfo) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Failed to resolve component')) warnings.push(message.text());
  });
  await mockApi(page);
  await page.goto('/experts');
  await page.getByRole('button', { name: '组建专家团', exact: true }).click();
  await page.getByRole('button', { name: '添加下一阶段', exact: true }).click();
  await page.getByLabel('阶段 1 名称', { exact: true }).fill('初稿');
  await page.getByLabel('本阶段并行成员', { exact: true }).press('Enter');
  await page.getByRole('option', { name: '内容主笔', exact: true }).click();
  await page.getByLabel('阶段任务与交付要求', { exact: true }).fill('独立完成初稿，向主理人汇报。');
  await page.getByRole('button', { name: '创建专家', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '内容编辑部', exact: true }) });
  await expect(card.getByText('专家团 · 模型连接后可执行', { exact: true })).toBeVisible();
  await expect(card.getByText('1 个结构化阶段', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(card.getByRole('button', { name: '原始包', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('teams.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: '创作工作台', exact: true }).click();
  await page.getByLabel('交给哪位专家', { exact: true }).press('Enter');
  await expect(
    page.getByRole('option', { name: '内容编辑部（需选择模型连接）', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  expect(warnings).toEqual([]);
});

test('model settings save encrypted-key metadata without an automatic test call', async ({
  page,
}, testInfo) => {
  const { connections } = await mockApi(page, false, true, true);
  let creationRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/creation-runs')) creationRequests++;
  });
  await page.goto('/models');
  await page.getByRole('button', { name: '添加模型连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('新建的模型连接');
  await page.getByLabel('API 基础地址', { exact: true }).fill('https://api.example.com/v1');
  await page.getByLabel('模型标识', { exact: true }).fill('fixture-model');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-key-not-live');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute(
    'type',
    'pass' + 'word',
  );
  await page.getByRole('button', { name: '保存连接（不调用模型）', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建的模型连接' })).toBeVisible();
  expect(connections[0]).not.toHaveProperty('apiKey');
  expect(creationRequests).toBe(0);
  await page.getByRole('button', { name: '添加模型连接', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '停用连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用连接', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('models.png'), fullPage: true });
});

test('selecting a model enables a real team path and exposes member evidence', async ({
  page,
}, testInfo) => {
  const { experts, connections } = await mockApi(page, false, true, true);
  experts.push(teamExpert);
  connections.push({ ...model });
  await page.goto('/');
  await page.getByLabel('本次使用的模型', { exact: true }).press('Enter');
  await page.getByRole('option', { name: '测试模型连接 · fixture-model', exact: true }).click();
  await page.getByLabel('交给哪位专家', { exact: true }).press('Enter');
  await page.getByRole('option', { name: '测试编辑部（专家团）', exact: true }).click();
  await page.getByLabel('这次，你想聊什么？').fill('编辑部的下一篇内容');
  await page.getByText('本次运行预算', { exact: false }).click();
  await expect(page.getByLabel('调用次数上限', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '启动专家团创作', exact: false }).click();
  await expect(page.getByRole('heading', { name: '编辑部协作过程', exact: true })).toBeVisible();
  await expect(page.getByText('待审核 · AI 候选正文', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '确认新调用，生成修改稿', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('可能产生新费用', { exact: false })).toBeVisible();
  await expect(page.getByText('不是剩余额度，也不代表金额上限。', { exact: false })).toBeVisible();
  const member = page
    .locator('.agent-execution')
    .filter({ has: page.getByRole('heading', { name: '主笔', exact: true }) });
  await member.getByText('查看成员交付', { exact: true }).click();
  await expect(member.getByText('成员独立交付：待审核的初稿。', { exact: true })).toBeVisible();
  await member.getByText('技能加载与只读工具记录', { exact: true }).click();
  await expect(member.getByText('load_skill · 已执行', { exact: true })).toBeVisible();
  await member.getByText('模型调用账本', { exact: true }).click();
  await expect(member.getByText('invocation-0', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('team-execution.png'), fullPage: true });
});

test('unknown results require a note and close without retrying the model', async ({
  page,
}, testInfo) => {
  await mockApi(page, false, true, true);
  let run = modelRun('needs_review');
  run.execution!.agents[0]!.status = 'unknown';
  run.execution!.invocations[0]!.status = 'unknown';
  run.execution!.usage.reservedTokens = 1000;
  run.execution!.usage.hasEstimatedUsage = true;
  let reconciliations = 0;
  await page.route(`**/creation-runs/${run.id}`, (route) => route.fulfill({ json: { data: run } }));
  await page.route(`**/creation-runs/${run.id}/reconcile`, (route) => {
    reconciliations++;
    const { note } = route.request().postDataJSON();
    run = {
      ...run,
      status: 'cancelled',
      revision: 11,
      failureCode: 'UNKNOWN_ACKNOWLEDGED',
      execution: {
        ...run.execution!,
        reconciliations: [{ id: 'ack', note, createdAt: account.createdAt }],
      },
    };
    return route.fulfill({ json: { data: run } });
  });
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole('heading', { name: '请求结果不明确，已停止自动重发' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '围绕这篇，继续创作', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: '记录核对说明并关闭任务' })).toBeDisabled();
  await page
    .getByLabel('人工核对说明', { exact: true })
    .fill('已在服务商记录中核对，保留本次未知调用证据并关闭任务。');
  await page.getByRole('button', { name: '记录核对说明并关闭任务' }).click();
  await expect(page.getByRole('heading', { name: '人工核对记录' })).toBeVisible();
  await expect(
    page.getByText('已在服务商记录中核对，保留本次未知调用证据并关闭任务。', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '人工核对记录' })).toBeVisible();
  expect(reconciliations).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('unknown-review.png'), fullPage: true });
});

test('cancelling a queued model task becomes terminal and closes its event stream', async ({
  page,
}) => {
  await mockApi(page, false, true, true);
  let run = modelRun('queued');
  run.execution!.agents = [];
  await page.route(`**/creation-runs/${run.id}`, (route) => route.fulfill({ json: { data: run } }));
  await page.route(`**/creation-runs/${run.id}/events`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `event: run.snapshot\ndata: ${JSON.stringify(run)}\n\n`,
    }),
  );
  await page.route(`**/creation-runs/${run.id}/cancel`, (route) => {
    run = {
      ...run,
      status: 'cancelled',
      cancelRequested: true,
      revision: 11,
      failureCode: 'CANCELLED',
    };
    return route.fulfill({ json: { data: run } });
  });
  await page.goto(`/runs/${run.id}`);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已取消', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
  await expect(page.getByText('实时连接中断', { exact: false })).toHaveCount(0);
});

test('shows a package preview and requires explicit confirmation before import', async ({
  page,
}) => {
  await mockApi(page);
  let installs = 0;
  await page.route('**/packages/preview', (route) =>
    route.fulfill({
      json: {
        data: {
          kind: 'skill',
          name: 'preview-only',
          packageVersion: null,
          skills: [],
          files: [{ path: 'SKILL.md', content: 'not rendered', encoding: 'utf8' }],
          warnings: ['仅保存，不安装依赖、不执行。'],
          runtimeReady: false,
        },
      },
    }),
  );
  await page.route('**/packages/import', (route) => {
    installs++;
    return route.fulfill({ json: { data: { expert: null, skills: [], warnings: [] } } });
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: '导入能力包', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认保存能力包', exact: true })).toBeDisabled();
  await page.getByLabel('选择 ZIP 包', { exact: false }).setInputFiles({
    name: 'fixture.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('browser fixture only'),
  });
  await expect(page.getByText('导入不等于具备运行能力', { exact: true })).toBeVisible();
  expect(installs).toBe(0);
  await page.getByRole('button', { name: '确认保存能力包', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(installs).toBe(1);
});
