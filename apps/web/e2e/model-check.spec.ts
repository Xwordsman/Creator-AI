import { expect, test, type Page } from '@playwright/test';
import type { ModelCheck, ModelConnection } from '@creator-ai/contracts';

const model: ModelConnection = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '写作模型',
  baseUrl: 'https://api.example.com/v1',
  model: 'fixture-model',
  tokenParameter: 'max_tokens',
  maxInputTokens: 16000,
  maxOutputTokens: 4096,
  enabled: true,
  hasKey: true,
  createdAt: '2026-11-09T00:00:00Z',
};
function record(status: ModelCheck['status'] = 'passed'): ModelCheck {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    modelConnectionId: model.id,
    status,
    failureCode: null,
    inputTokens: status === 'passed' ? 37 : null,
    outputTokens: status === 'passed' ? 5 : null,
    createdAt: model.createdAt,
    completedAt: status === 'running' ? null : model.createdAt,
    resolvedAt: null,
    resolutionNote: null,
  };
}
async function fixture(page: Page) {
  const state = {
    connections: [{ ...model }],
    history: [] as ModelCheck[],
    posts: [] as { key: string | undefined; body: unknown }[],
    gets: 0,
    providerCalls: 0,
    configured: true,
    loseResponse: false,
    malformedResponse: false,
    emptyResponse: false,
    failHistory: false,
    holdNextHistory: false,
    releaseHistory: undefined as (() => void) | undefined,
  };
  const seen = new Set<string>();
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/v1', '');
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, requestId: 'model-check-fixture' } });
    if (path === '/auth/session')
      return json({
        user: { id: 'owner', username: 'creator' },
        csrfToken: 'fixture-csrf',
        expiresAt: '2099-01-01T00:00:00Z',
      });
    if (path === '/models/capabilities')
      return json({
        modelMode: state.configured ? 'configured' : 'mock',
        canConfigureModels: state.configured,
        allowedHosts: ['api.example.com'],
        tools: ['load_skill', 'read_skill_file'],
      });
    if (path === '/models') {
      if (req.method() === 'POST') {
        const input = req.postDataJSON();
        delete input.apiKey;
        state.connections = [{ ...model, ...input }];
        return json(state.connections[0], 201);
      }
      return json(state.connections);
    }
    if (path === `/models/${model.id}/checks`) {
      if (req.method() === 'GET') {
        state.gets++;
        if (state.failHistory) return route.abort('failed');
        const snapshot = structuredClone(state.history);
        if (state.holdNextHistory) {
          state.holdNextHistory = false;
          await new Promise<void>((resolve) => (state.releaseHistory = resolve));
        }
        return json(snapshot);
      }
      const key = req.headers()['idempotency-key'];
      state.posts.push({ key, body: req.postDataJSON() });
      if (!seen.has(key!)) {
        seen.add(key!);
        state.providerCalls++;
        if (!state.history.length) state.history = [record()];
      }
      if (state.loseResponse) {
        state.loseResponse = false;
        return route.abort('failed');
      }
      if (state.malformedResponse) {
        state.malformedResponse = false;
        return route.fulfill({ status: 400, contentType: 'text/html', body: 'Proxy response' });
      }
      if (state.emptyResponse) {
        state.emptyResponse = false;
        return json(null);
      }
      return json(state.history[0]);
    }
    if (path.endsWith('/reconcile')) {
      state.history[0] = {
        ...state.history[0]!,
        resolvedAt: '2026-11-09T00:01:00Z',
        resolutionNote: req.postDataJSON().note,
      };
      return json(state.history[0]);
    }
    throw new Error(`Unexpected fixture route: ${req.method()} ${path}`);
  });
  return state;
}
async function open(page: Page) {
  await page.goto('/models');
  await page.getByRole('button', { name: '检查连接 / 记录' }).click();
  await expect(page.getByRole('button', { name: '刷新检查记录' })).toBeEnabled();
}
async function send(page: Page) {
  await page.getByText('我确认发送一次检查请求，可能产生费用', { exact: true }).click();
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: '发送一次检查', exact: true }).click();
}

test('saving and viewing never call; explicit confirmation checks once with usage', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/models');
  await page.getByRole('button', { name: '添加模型连接' }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('写作模型');
  await page.getByLabel('API 基础地址').fill(model.baseUrl);
  await page.getByLabel('模型标识', { exact: true }).fill(model.model);
  await page.getByLabel('API Key', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '保存连接（不调用模型）' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '检查连接 / 记录' }).click();
  await expect(page.getByText('尚未检查；保存连接和打开此窗口都不会调用模型。')).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await expect(page.getByRole('button', { name: '发送一次检查', exact: true })).toBeDisabled();
  await send(page);
  await expect(page.getByText('基础协议通过', { exact: true })).toBeVisible();
  await expect(page.getByText(/服务商报告 Token：输入 37 \/ 输出 5/)).toBeVisible();
  expect(state.posts).toEqual([{ key: expect.any(String), body: { confirm: true } }]);
  expect(state.providerCalls).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: test.info().outputPath('model-check.png'), fullPage: true });
});

test('provider authentication failure explains how to fix it without exposing a response', async ({
  page,
}) => {
  const state = await fixture(page);
  state.history = [{ ...record('failed'), failureCode: 'PROVIDER_HTTP_401' }];
  await open(page);
  await expect(page.getByText('服务商拒绝了 API Key，请检查密钥是否有效。')).toBeVisible();
  expect(state.posts).toHaveLength(0);
});

test('a lost response survives reload and only an explicit retry uses the same key', async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseResponse = true;
  await open(page);
  await send(page);
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toBeEnabled();
  const key = state.posts[0]!.key;
  await page.reload();
  await page.getByRole('button', { name: '检查连接 / 记录' }).click();
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await page.getByRole('button', { name: '原样重试检查请求' }).click();
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toHaveCount(0);
  expect(state.posts).toEqual([
    { key, body: { confirm: true } },
    { key, body: { confirm: true } },
  ]);
  expect(state.providerCalls).toBe(1);
});

test('running checks poll while open and stop polling after close', async ({ page }) => {
  const state = await fixture(page);
  state.history = [record('running')];
  await open(page);
  await expect(page.getByText('检查中', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect.poll(() => state.gets, { timeout: 5000 }).toBeGreaterThan(1);
  await page.getByRole('button', { name: '关闭此对话框' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const count = state.gets;
  await page.waitForTimeout(2200);
  expect(state.gets).toBe(count);
  expect(state.posts).toHaveLength(0);
});

test('unknown results block new calls until a note is saved and keep original evidence', async ({
  page,
}) => {
  const state = await fixture(page);
  state.history = [{ ...record('unknown'), failureCode: 'PROVIDER_TRANSPORT_UNKNOWN' }];
  await open(page);
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByText(/请求结果不确定，可能已产生费用/)).toBeVisible();
  await page.getByLabel('核对服务商记录后的说明').fill('已核对服务商记录，保留原调用结果并继续。');
  await page.getByRole('button', { name: '保存核对说明' }).click();
  await expect(page.getByText('调用结果待核对 · 已人工核对', { exact: true })).toBeVisible();
  await expect(page.getByText(/核对说明：已核对服务商记录/)).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  expect(state.history[0]!.status).toBe('unknown');
});

test('disabled connections in mock mode still show history without enabling a new call', async ({
  page,
}) => {
  const state = await fixture(page);
  state.configured = false;
  state.connections[0]!.enabled = false;
  state.history = [record()];
  await open(page);
  await expect(page.getByText('基础协议通过', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送一次检查', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(0);
});

test('a delayed old history response cannot erase a completed check', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await expect(page.getByText('尚未检查；保存连接和打开此窗口都不会调用模型。')).toBeVisible();
  state.holdNextHistory = true;
  await page.getByRole('button', { name: '刷新检查记录' }).click();
  await expect.poll(() => !!state.releaseHistory).toBe(true);
  try {
    await send(page);
    await expect(page.getByText('基础协议通过', { exact: true })).toBeVisible();
  } finally {
    state.releaseHistory!();
  }
  await expect(page.getByText('基础协议通过', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test('preserves a check key after an invalid 4xx response and retries it only on demand', async ({
  page,
}) => {
  const state = await fixture(page);
  state.malformedResponse = true;
  await open(page);
  await send(page);
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: '检查连接 / 记录' }).click();
  await page.getByRole('button', { name: '原样重试检查请求' }).click();
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toHaveCount(0);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]).toEqual(state.posts[1]);
  expect(state.providerCalls).toBe(1);
});

test('does not permit a new paid check before its existing history can be read', async ({
  page,
}) => {
  const state = await fixture(page);
  state.failHistory = true;
  await open(page);
  await expect(page.getByRole('alert')).toContainText('无法连接服务');
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送一次检查', exact: true })).toBeDisabled();
  expect(state.providerCalls).toBe(0);
  state.failHistory = false;
  await page.getByRole('button', { name: '刷新检查记录' }).click();
  await expect(page.getByRole('checkbox')).toBeEnabled();
});

test('does not mistake an empty HTTP success for a confirmed paid check', async ({ page }) => {
  const state = await fixture(page);
  state.emptyResponse = true;
  await open(page);
  await send(page);
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toBeEnabled();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await page.getByRole('button', { name: '原样重试检查请求' }).click();
  await expect(page.getByRole('button', { name: '原样重试检查请求' })).toHaveCount(0);
  expect(state.posts[0]).toEqual(state.posts[1]);
  expect(state.providerCalls).toBe(1);
});
