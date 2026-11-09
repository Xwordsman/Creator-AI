import { expect, test, type Page } from '@playwright/test';
import type { ContentDetail, ContentReview, ContentVersion } from '@creator-ai/contracts';

const id = '66666666-6666-4666-8666-666666666666';
const sourceRunId = '33333333-3333-4333-8333-333333333333';
const path = `/contents/${id}`;
const time = '2026-11-02T10:00:00Z';
test('recovers unfinished title and heading without saving an invalid version', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(path);
  await page.getByLabel('内容标题', { exact: true }).fill('');
  await page.getByRole('textbox', { name: '内容正文编辑器' }).fill('');
  await page.getByRole('button', { name: '二级标题', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: '内容正文编辑器' }).locator('h2')).toBeVisible();
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(
    page.getByText('请检查标题（1–300 字）、段落数量与长度；标题段落不能为空，正文仅支持文本。', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.versions).toHaveLength(1);
  expect(state.writes).toHaveLength(0);
});
async function fixture(
  page: Page,
  options: { isMock?: boolean; loseSave?: boolean; conflictSave?: boolean } = {},
) {
  const initial: ContentVersion = {
    version: 1,
    title: '候选文章',
    document: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '等待人工打磨的正文。' }] }],
    },
    kind: 'generated',
    restoredFrom: null,
    note: '',
    createdAt: time,
  };
  let detail: ContentDetail = {
    item: {
      id,
      sourceRunId,
      accountName: '日常观察',
      platform: 'wechat',
      isMock: options.isMock ?? false,
      title: initial.title,
      status: 'draft',
      currentVersion: 1,
      revision: 1,
      createdAt: time,
      updatedAt: time,
    },
    version: initial,
  };
  const versions = [structuredClone(initial)],
    reviews: ContentReview[] = [];
  const receipts = new Map<string, ContentDetail>(),
    writes: { key: string; body: unknown; url: string }[] = [],
    exports: unknown[] = [];
  let lost = false,
    conflicted = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      api = url.pathname.replace('/api/v1', ''),
      method = req.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        // PostgreSQL JSONB does not preserve JavaScript object insertion order.
        body: JSON.stringify({ data, requestId: 'fixture' }, (_key, value: unknown) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(
                  ([a], [b]) => a.length - b.length || a.localeCompare(b, 'en'),
                ),
              )
            : value,
        ),
      });
    const fail = (code: string, status = 409) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code,
            message: code === 'CONTENT_CONFLICT' ? '内容已在其他页面更新。' : '请求失败',
            retryable: false,
          },
          requestId: 'fixture',
        }),
      });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 10 });
    if (api === '/auth/session')
      return json({
        user: { id: 'content-owner', username: 'creator' },
        csrfToken: 'csrf-content',
        expiresAt: '2026-11-08T00:00:00Z',
      });
    if (api === '/models/capabilities')
      return json({ modelMode: 'mock', canConfigureModels: false, allowedHosts: [], tools: [] });
    if (api === '/contents' && method === 'GET') return list([detail.item]);
    if (api === '/contents' && method === 'POST') return json(detail, 201);
    if (api === path && method === 'GET') return json(detail);
    if (api === `${path}/versions` && method === 'GET')
      return list([...versions].reverse().map(({ document: _, ...v }) => v));
    if (api.startsWith(`${path}/versions/`) && method === 'GET')
      return json(versions.find((v) => v.version === Number(api.split('/').at(-1))));
    if (api === `${path}/reviews` && method === 'GET') return list([...reviews].reverse());
    if (api === `${path}/export`) {
      expect(req.headers()['x-csrf-token']).toBe('csrf-content');
      exports.push(req.postDataJSON());
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename=content.md',
        },
        body: 'fixture export',
      });
    }
    if (
      [`${path}/versions`, `${path}/reviews`, `${path}/restore`].includes(api) &&
      method === 'POST'
    ) {
      const key = req.headers()['idempotency-key']!,
        body = req.postDataJSON();
      expect(key).toBeTruthy();
      expect(req.headers()['x-csrf-token']).toBe('csrf-content');
      writes.push({ key, body, url: api });
      if (receipts.has(key)) return json(receipts.get(key));
      if (options.conflictSave && !conflicted && api.endsWith('/versions')) {
        conflicted = true;
        detail.item.revision++;
        detail.item.title = '另一窗口的标题';
        detail.version = { ...detail.version, title: '另一窗口的标题' };
        return fail('CONTENT_CONFLICT');
      }
      if (body.baseRevision !== detail.item.revision) return fail('CONTENT_CONFLICT');
      if (api.endsWith('/versions') || api.endsWith('/restore')) {
        const restored = api.endsWith('/restore')
          ? versions.find((v) => v.version === body.version)!
          : null;
        const next: ContentVersion = {
          version: versions.length + 1,
          title: restored?.title ?? body.title,
          document: restored?.document ?? body.document,
          kind: restored ? 'restore' : 'edit',
          restoredFrom: restored?.version ?? null,
          note: body.note ?? '',
          createdAt: time,
        };
        versions.push(structuredClone(next));
        detail = {
          item: {
            ...detail.item,
            title: next.title,
            currentVersion: next.version,
            status: 'draft',
            revision: detail.item.revision + 1,
          },
          version: next,
        };
      } else {
        reviews.push({
          id: `review-${reviews.length}`,
          version: detail.item.currentVersion,
          action: body.action,
          note: body.note,
          createdAt: time,
        });
        detail.item = {
          ...detail.item,
          status: (
            {
              submit: 'pending_review',
              approve: 'approved',
              request_changes: 'changes_requested',
            } as const
          )[body.action as 'submit' | 'approve' | 'request_changes'],
          revision: detail.item.revision + 1,
        };
      }
      receipts.set(key, structuredClone(detail));
      if (options.loseSave && !lost && api.endsWith('/versions')) {
        lost = true;
        return route.abort('failed');
      }
      return json(detail);
    }
    return fail('NOT_FOUND', 404);
  });
  return {
    versions,
    reviews,
    writes,
    exports,
    get detail() {
      return detail;
    },
  };
}

test('read-only transitions do not dirty JSONB documents or create phantom edits', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(path);
  await expect(page.getByRole('button', { name: '提交审核', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByText('v1 · 修订 2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '审核通过', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  expect(state.versions).toHaveLength(1);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.url).toBe(`${path}/reviews`);
});

test('saves edited title and body, reloads durable version and displays history', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(path);
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('候选文章');
  await page.getByLabel('内容标题', { exact: true }).fill('人工打磨后的标题');
  await page.getByRole('textbox', { name: '内容正文编辑器' }).fill('这是人工修改后的正文。');
  await expect(page.getByRole('button', { name: '提交审核', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('v2 · 修订 2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('人工打磨后的标题');
  await expect(page.getByRole('textbox', { name: '内容正文编辑器' })).toContainText(
    '这是人工修改后的正文。',
  );
  await expect(page.getByRole('button', { name: '预览 v1', exact: true })).toBeVisible();
  expect(state.versions).toHaveLength(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});
test('binds reviews to saved versions and clears approval after an edit', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(path);
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByText('v1 · 修订 2', { exact: true })).toBeVisible();
  await page.getByLabel('审核意见 / 修改原因').fill('已人工核对');
  await page.getByRole('button', { name: '审核通过', exact: true }).click();
  await expect(page.getByText('已通过', { exact: true })).toBeVisible();
  await page.getByLabel('内容标题', { exact: true }).fill('通过后再修改');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('编辑中', { exact: true })).toBeVisible();
  expect(state.reviews).toHaveLength(2);
  expect(state.reviews[1]!.version).toBe(1);
});
test('restores history as a new version without overwriting current or original', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(path);
  await page.getByLabel('内容标题', { exact: true }).fill('第二版标题');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('v2 · 修订 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览 v1', exact: true }).click();
  await expect(page.getByRole('heading', { name: '历史预览 · v1' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '将此版本恢复为新版本', exact: true }).click();
  await expect(page.getByText('v3 · 修订 3', { exact: true })).toBeVisible();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('候选文章');
  expect(state.versions.map((v) => v.title)).toEqual(['候选文章', '第二版标题', '候选文章']);
});
test('freezes uncertain save, survives reload, and retries the same payload and key only', async ({
  page,
}) => {
  const state = await fixture(page, { loseSave: true });
  await page.goto(path);
  await page.getByLabel('内容标题', { exact: true }).fill('只保存一次');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('请求结果待确认', { exact: true })).toBeVisible();
  await expect(page.getByLabel('内容标题', { exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '原样重试并核对', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原样重试并核对', exact: true }).click();
  await expect(page.getByText('请求结果待确认', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('只保存一次');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]).toEqual(state.writes[1]);
  expect(state.versions).toHaveLength(2);
});
test('keeps local edits on optimistic conflict and requires explicit discard to load latest', async ({
  page,
}) => {
  await fixture(page, { conflictSave: true });
  await page.goto(path);
  await page.getByLabel('内容标题', { exact: true }).fill('我的未合并编辑');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('内容已在其他页面更新。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('我的未合并编辑');
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '读取服务器最新版本', exact: true }).click();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('另一窗口的标题');
});
test('warns before leaving unsaved work and can recover local edits on reload', async ({
  page,
}) => {
  await fixture(page);
  await page.goto(path);
  await page.getByLabel('内容标题', { exact: true }).fill('还没保存');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: '← 返回内容库', exact: true }).click();
  await expect(page).toHaveURL(path);
  await page.reload();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('还没保存');
  await expect(
    page.getByText('已恢复此浏览器会话中的本地编辑。若服务器已更新，请先核对版本。', {
      exact: true,
    }),
  ).toBeVisible();
});
test('never approves mock contents and exports only an explicitly acknowledged saved version', async ({
  page,
}) => {
  const state = await fixture(page, { isMock: true });
  await page.goto(path);
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByRole('button', { name: '审核通过', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出已保存版本', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出已保存版本', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`content-${id}-v1.md`);
  expect(state.exports).toEqual([{ version: 1, format: 'md', acknowledgeUnreviewed: true }]);
});
test('content library links to the editor and shows permanent mock provenance', async ({
  page,
}) => {
  await fixture(page, { isMock: true });
  await page.goto('/contents');
  await page.getByRole('link', { name: /日常观察 · v1 · 模拟内容/ }).click();
  await expect(page.getByRole('heading', { name: '内容编辑台', exact: true })).toBeVisible();
  await expect(
    page.getByText('模拟内容：可体验编辑、版本、送审与导出，但不能审核通过，不可正式发布。', {
      exact: true,
    }),
  ).toBeVisible();
});
