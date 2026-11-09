import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  Account,
  CreateRunInput,
  CreationRun,
  Expert,
  ExpertVersion,
  Skill,
  SkillVersion,
} from '@creator-ai/contracts';

const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222',
  x = '33333333-3333-4333-8333-333333333333',
  y = '44444444-4444-4444-8444-444444444444';
const time = '2026-11-02T12:00:00Z';
async function fixture(
  page: Page,
  options: {
    disabledDefault?: boolean;
    teamDefault?: boolean;
    loseBinding?: boolean;
    restoreFailure?: 'lost' | 'conflict' | 'refresh';
  } = {},
) {
  const first: Expert = {
    id: x,
    name: '账号主笔',
    description: '保存的写作方法',
    instructions: '当前方法',
    skillKeys: ['custom:voice'],
    skillVersions: { 'custom:voice': 1 },
    enabled: !options.disabledDefault,
    version: 2,
    createdAt: time,
    ...(options.teamDefault
      ? {
          expertType: 'team' as const,
          team: {
            leadAgent: 'lead',
            members: ['lead', 'writer'].map((agentId) => ({
              agentId,
              name: agentId,
              description: '独立成员',
              instructions: '独立交付',
              skillKeys: ['custom:voice'],
            })),
          },
        }
      : {}),
  };
  const experts: Expert[] = [
    first,
    {
      ...first,
      id: y,
      name: '临时审校',
      expertType: 'agent',
      team: undefined,
      enabled: true,
      version: 1,
      skillVersions: {},
    },
  ];
  const accounts: Account[] = [
    {
      id: a,
      name: '日常账号',
      platform: 'wechat',
      persona: '克制真诚',
      audience: '日常读者',
      revision: 1,
      defaultExpertId: x,
      createdAt: time,
    },
    {
      id: b,
      name: '另一个账号',
      platform: 'toutiao',
      persona: '自然简洁',
      audience: '更多读者',
      revision: 1,
      defaultExpertId: y,
      createdAt: time,
    },
  ];
  const skill: Skill = {
    key: 'custom:voice',
    name: 'voice',
    description: '写作技能',
    instructions: '当前技能',
    document: '---\nname: voice\ndescription: 写作技能\n---\n当前技能',
    source: 'custom',
    enabled: false,
    version: 2,
    allowedTools: [],
  };
  const skills = [skill];
  const history: Record<string, (ExpertVersion | SkillVersion)[]> = {
    [`/experts/${x}`]: [2, 1].map((version) => ({
      ...first,
      version,
      instructions: version === 1 ? '历史专家方法' : first.instructions,
      restoredFrom: null,
    })),
    '/skills/custom:voice': [2, 1].map((version) => ({
      ...skill,
      version,
      instructions: version === 1 ? '历史技能方法' : skill.instructions,
      restoredFrom: null,
      createdAt: time,
    })),
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [],
    runs: CreationRun[] = [],
    submissions: CreateRunInput[] = [];
  let lostBinding = false,
    restoreFailed = false,
    failHistory = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = decodeURIComponent(url.pathname.replace('/api/v1', '')),
      method = req.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, requestId: 'capability-fixture' } });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 100 });
    const fail = (status = 409) =>
      route.fulfill({
        status,
        json: {
          error: {
            code: 'VERSION_CONFLICT',
            message: '服务器配置已变化，请核对。',
            retryable: false,
          },
        },
      });
    if (path === '/auth/session')
      return json({
        user: { id: 'owner', username: 'creator' },
        csrfToken: 'fixture-csrf',
        expiresAt: '2026-11-09T12:00:00Z',
      });
    if (path === '/models/capabilities')
      return json({
        modelMode: 'mock',
        canConfigureModels: false,
        allowedHosts: [],
        tools: ['load_skill', 'read_skill_file'],
      });
    if (path === '/models') return json([]);
    if (path === '/accounts') return list(accounts);
    if (path === '/experts') return list(experts);
    if (path === '/skills') return list(skills);
    if (method === 'POST') {
      expect(req.headers()['x-csrf-token']).toBe('fixture-csrf');
      writes.push({ path, body: req.postDataJSON() as Record<string, unknown> });
    }
    if (path.endsWith('/default-expert')) {
      const account = accounts.find((item) => path.includes(item.id))!;
      const body = req.postDataJSON() as { expertId: string | null; baseRevision: number };
      if (body.baseRevision !== account.revision) return fail();
      if (account.defaultExpertId !== body.expertId) {
        account.defaultExpertId = body.expertId;
        account.revision++;
      }
      if (options.loseBinding && !lostBinding) {
        lostBinding = true;
        return route.abort();
      }
      return json(account, 201);
    }
    if (path.endsWith('/versions')) {
      const root = path.slice(0, -'/versions'.length);
      if (method === 'GET') {
        if (failHistory) return fail(503);
        return list(history[root] ?? []);
      }
      const current = experts.find((item) => root.includes(item.id))!;
      if (Number(url.searchParams.get('baseVersion')) !== current.version) return fail();
      Object.assign(current, req.postDataJSON(), { version: current.version + 1 });
      return json(current, 201);
    }
    if (path.endsWith('/restore')) {
      const root = path.slice(0, -'/restore'.length),
        versions = history[root]!;
      const body = req.postDataJSON() as { version: number; baseVersion: number };
      if (body.baseVersion !== versions[0]!.version) return fail();
      const source = versions.find((item) => item.version === body.version)!;
      const next = { ...source, version: body.baseVersion + 1, restoredFrom: body.version };
      versions.unshift(next);
      const current = root.startsWith('/skills/') ? skills[0]! : experts[0]!;
      Object.assign(current, { instructions: next.instructions, version: next.version });
      if (options.restoreFailure && !restoreFailed) {
        restoreFailed = true;
        if (options.restoreFailure === 'lost') return route.abort();
        if (options.restoreFailure === 'conflict') return fail();
        failHistory = true;
      }
      return json(current, 201);
    }
    if (path === '/creation-runs') {
      if (method === 'GET') return list(runs);
      const input = req.postDataJSON() as CreateRunInput;
      submissions.push(input);
      const account = accounts.find((item) => item.id === input.accountId)!;
      const selected = experts.find(
        (item) => item.id === (input.expertId ?? account.defaultExpertId),
      )!;
      const run: CreationRun = {
        id: randomUUID(),
        status: 'succeeded',
        attempts: 1,
        revision: 3,
        createdAt: time,
        updatedAt: time,
        failureCode: null,
        snapshot: {
          schemaVersion: 1,
          provider: 'mock',
          workflow: 'mock-article-v1',
          topic: input.topic,
          brief: input.brief,
          account: structuredClone(account),
          expert: structuredClone(selected),
          skills: [],
        },
        output: {
          schemaVersion: 1,
          title: input.topic,
          isMock: true,
          reviewStatus: 'pending_review',
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '模拟验收正文。' }] }],
          },
        },
      };
      runs.push(run);
      return json(run, 202);
    }
    const run = runs.find((item) => path === `/creation-runs/${item.id}`);
    if (run) return json(run);
    if (path.endsWith('/history')) return list([]);
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  return {
    accounts,
    experts,
    skills,
    history,
    writes,
    submissions,
    allowHistory: () => {
      failHistory = false;
    },
  };
}
const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole('combobox', { name: label, exact: true }).press('Enter');
  await page.getByRole('option', { name: option, exact: true }).click();
};
const noOverflow = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);

test('uses the account default in new runs, survives reload and changes with the account', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/?accountId=${b}`);
  await expect(
    page.getByRole('status').filter({ hasText: '已沿用账号默认专家：临时审校' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: '已沿用账号默认专家：临时审校' }),
  ).toBeVisible();
  await choose(page, '为哪个账号创作', '日常账号');
  await expect(
    page.getByText('已沿用账号默认专家：账号主笔。可以临时换选。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('custom:voice · 固定 v1')).toBeVisible();
  await page.getByLabel('这次，你想聊什么？').fill('复用账号默认专家');
  await noOverflow(page);
  await page.getByRole('button', { name: '生成模拟草稿', exact: true }).click();
  await expect(page).toHaveURL(/\/runs\//);
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0]).toMatchObject({ accountId: a, accountRevision: 1 });
  expect(state.submissions[0]).not.toHaveProperty('expertId');
});
test('allows an explicit one-off override and a deliberate return to the saved default', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/');
  await choose(page, '交给哪位专家', '临时审校');
  await expect(
    page.getByText('本次已临时选择其他专家，不修改账号默认设置。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '使用账号默认专家' }).click();
  await expect(
    page.getByText('已沿用账号默认专家：账号主笔。可以临时换选。', { exact: true }),
  ).toBeVisible();
  await choose(page, '交给哪位专家', '临时审校');
  await page.getByLabel('这次，你想聊什么？').fill('临时换专家');
  await page.getByRole('button', { name: '生成模拟草稿', exact: true }).click();
  await expect(page).toHaveURL(/\/runs\//);
  expect(state.submissions[0]).toMatchObject({ expertId: y });
  expect(state.submissions[0]).not.toHaveProperty('accountRevision');
  expect(state.accounts[0]!.defaultExpertId).toBe(x);
});
for (const unavailable of ['disabled', 'team'] as const) {
  test(`does not silently substitute an unavailable ${unavailable} default or choose a paid model`, async ({
    page,
  }) => {
    const state = await fixture(page, {
      disabledDefault: unavailable === 'disabled',
      teamDefault: unavailable === 'team',
    });
    await page.goto('/');
    await page.getByLabel('这次，你想聊什么？').fill('不自动换专家');
    await expect(page.getByRole('button', { name: '生成模拟草稿', exact: true })).toBeDisabled();
    await expect(
      page.getByText(
        unavailable === 'disabled'
          ? '账号默认专家已停用，请临时换选或在账号中重新设置。'
          : '账号默认专家为专家团，请选择模型连接或临时换选单专家；不会自动使用收费模型或降级模拟。',
        { exact: true },
      ),
    ).toBeVisible();
    await noOverflow(page);
    expect(state.submissions).toHaveLength(0);
    await choose(page, '交给哪位专家', '临时审校');
    await expect(page.getByRole('button', { name: '生成模拟草稿', exact: true })).toBeEnabled();
  });
}
test('re-reads a lost default-change response before allowing any further write', async ({
  page,
}) => {
  const state = await fixture(page, { loseBinding: true });
  await page.goto('/accounts');
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '日常账号', exact: true }) });
  await card.getByRole('button', { name: '设置默认专家', exact: true }).click();
  await choose(page, '默认专家 / 专家团', '临时审校');
  await page.getByRole('button', { name: '保存默认专家', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '请先读取服务器配置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存默认专家', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: '读取服务器配置', exact: true }).click();
  await expect(page.getByText('日常账号 · 配置 r2', { exact: true })).toBeVisible();
  await choose(page, '默认专家 / 专家团', '清除默认 · 创作时选择');
  await page.getByRole('button', { name: '保存默认专家', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.accounts[0]).toMatchObject({ revision: 3, defaultExpertId: null });
  expect(state.writes[1]!.body).toEqual({ expertId: null, baseRevision: 2 });
  await page.reload();
  await expect(card.getByText('未设置 · 创作时选择', { exact: true })).toBeVisible();
});
test('loads historical pin options, saves them, and removes pins for unselected skills', async ({
  page,
}) => {
  const state = await fixture(page);
  state.skills[0]!.enabled = true;
  state.experts[0]!.skillVersions = {};
  await page.goto('/experts');
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '账号主笔', exact: true }) });
  await card.getByRole('button', { name: '配置专家', exact: true }).click();
  await choose(page, 'custom:voice 版本策略', '固定 v1');
  await noOverflow(page);
  await page.getByRole('button', { name: '保存为新版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes[0]!.body.skillVersions).toEqual({ 'custom:voice': 1 });
  await page.reload();
  await expect(card.getByText('voice · 固定 v1', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '配置专家', exact: true }).click();
  await page.getByRole('combobox', { name: '可用 Skills（可不选）', exact: true }).press('Enter');
  await page.getByRole('option', { name: 'voice · v2', exact: true }).click();
  await page.getByLabel('专家名称', { exact: true }).click();
  await expect(page.getByRole('region', { name: '技能版本绑定' })).toHaveCount(0);
  await page.getByRole('button', { name: '保存为新版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes[1]!.body.skillVersions).toEqual({});
});
for (const kind of ['expert', 'skill'] as const) {
  test(`restores ${kind} history only after confirmation, appends a new version and preserves disabled state`, async ({
    page,
  }) => {
    const state = await fixture(page, { disabledDefault: true });
    await page.goto(kind === 'expert' ? '/experts' : '/skills');
    const card = page.locator('article').filter({
      has: page.getByRole('heading', {
        name: kind === 'expert' ? '账号主笔' : 'voice',
        exact: true,
      }),
    });
    await card.getByRole('button', { name: '版本', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .locator('summary')
      .filter({ hasText: /^\s*v1\s/ })
      .click();
    await dialog.getByRole('button', { name: '恢复 v1 为新版本', exact: true }).click();
    await expect(page.getByRole('region', { name: '确认历史恢复' })).toBeVisible();
    expect(state.writes).toHaveLength(0);
    await page.getByRole('button', { name: '确认恢复为新版本', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已从 v1 恢复为新版本 v3' }),
    ).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.body).toEqual({ version: 1, baseVersion: 2 });
    expect(kind === 'expert' ? state.experts[0]!.enabled : state.skills[0]!.enabled).toBe(false);
    await expect(dialog.locator('summary').filter({ hasText: 'v3' })).toContainText('恢复自 v1');
    await noOverflow(page);
    await page.reload();
    await expect(card.getByRole('button', { name: '启用', exact: true })).toBeVisible();
  });
}
for (const failure of ['lost', 'conflict', 'refresh'] as const) {
  test(`requires a fresh history read after ${failure} restore results without automatic repeat`, async ({
    page,
  }) => {
    const state = await fixture(page, { restoreFailure: failure });
    await page.goto('/skills');
    await page.getByRole('button', { name: '版本', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .locator('summary')
      .filter({ hasText: /^\s*v1\s/ })
      .click();
    await dialog.getByRole('button', { name: '恢复 v1 为新版本', exact: true }).click();
    await dialog.getByRole('button', { name: '确认恢复为新版本', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(state.writes).toHaveLength(1);
    await expect(
      dialog.getByRole('button', { name: '恢复 v1 为新版本', exact: true }),
    ).toBeDisabled();
    state.allowHistory();
    await dialog.getByRole('button', { name: '重新读取历史', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.locator('summary').filter({ hasText: 'v3' })).toContainText('恢复自 v1');
    expect(state.writes).toHaveLength(1);
    expect(state.history['/skills/custom:voice']).toHaveLength(3);
  });
}
