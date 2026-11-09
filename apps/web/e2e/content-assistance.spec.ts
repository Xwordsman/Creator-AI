import { expect, test, type Page } from '@playwright/test';
import type {
  ContentDetail,
  ContentTurnDetail,
  ContentTurnInput,
  ContentVersion,
  ContentWritingProfiles,
} from '@creator-ai/contracts';

const id = '66666666-6666-4666-8666-666666666666';
const modelId = '11111111-1111-4111-8111-111111111111';
const path = `/contents/${id}`;
const endpoint = `${path}/assistant-turns`;
const time = '2026-11-09T10:00:00Z';
const paragraphs = ['开头讲了很多道理。', '这段是我的真实经历。', '结尾又重复了一遍。'];

async function fixture(
  page: Page,
  options: { losePost?: boolean; queued?: boolean; legacyOriginal?: boolean } = {},
) {
  const initial: ContentVersion = {
    version: 1,
    title: '原始标题',
    document: {
      type: 'doc',
      content: paragraphs.map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
    },
    kind: 'generated',
    restoredFrom: null,
    note: '',
    createdAt: time,
  };
  let detail: ContentDetail = {
    item: {
      id,
      sourceRunId: '33333333-3333-4333-8333-333333333333',
      accountName: '家庭写作',
      platform: 'wechat',
      isMock: false,
      title: initial.title,
      status: 'draft',
      currentVersion: 1,
      revision: 1,
      createdAt: time,
      updatedAt: time,
    },
    version: initial,
  };
  const versions = [structuredClone(initial)];
  const turns: ContentTurnDetail[] = [];
  const writes: { key: string; input: ContentTurnInput }[] = [];
  const receipts = new Map<string, ContentTurnDetail>();
  const unexpected: string[] = [];
  let lost = false,
    historyReads = 0;
  let profileRevision = 2;
  const originalAccount: ContentWritingProfiles['original'] = {
    id,
    name: '家庭写作',
    platform: 'wechat',
    audience: 'Readers',
    persona: '自然真诚',
    ...(options.legacyOriginal ? {} : { revision: 1 }),
    defaultExpertId: null,
    createdAt: time,
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      method = request.method();
    const api = new URL(request.url()).pathname.replace('/api/v1', '');
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ data, requestId: 'fixture' }),
      });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 10 });
    if (api === '/auth/session')
      return json({
        user: { id: 'assistant-owner', username: 'creator' },
        csrfToken: 'csrf-assistant',
        expiresAt: '2026-11-16T00:00:00Z',
      });
    if (api === '/models/capabilities')
      return json({
        modelMode: 'configured',
        canConfigureModels: true,
        allowedHosts: ['fixture.invalid'],
        tools: [],
      });
    if (api === '/models')
      return json([{ id: modelId, name: '本地协议测试', model: 'fixture', enabled: true }]);
    if (api === '/contents' && method === 'GET') return list([detail.item]);
    if (api === path && method === 'GET') return json(detail);
    if (api === `${path}/versions` && method === 'GET')
      return list([...versions].reverse().map(({ document: _, ...version }) => version));
    if (api === `${path}/reviews` && method === 'GET') return list([]);
    if (api === `${path}/versions` && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.baseRevision).toBe(detail.item.revision);
      const version: ContentVersion = {
        ...initial,
        ...body,
        version: versions.length + 1,
        kind: 'edit',
      };
      versions.push(structuredClone(version));
      detail = {
        item: {
          ...detail.item,
          title: version.title,
          currentVersion: version.version,
          revision: detail.item.revision + 1,
        },
        version,
      };
      return json(detail);
    }
    if (api === endpoint && method === 'GET') {
      historyReads++;
      return list(turns);
    }
    if (api === `${endpoint}/writing-profile` && method === 'GET')
      return json({
        original: originalAccount,
        current: {
          ...originalAccount,
          revision: profileRevision,
          writingCards: [
            {
              id: modelId,
              title: '家人写作卡',
              kind: 'writing',
              content: '不要编造经历，先讨论真实细节。',
              enabled: true,
            },
          ],
        },
      });
    if (api === endpoint && method === 'POST') {
      const input = request.postDataJSON() as ContentTurnInput;
      const key = request.headers()['idempotency-key']!;
      expect(key).toBeTruthy();
      expect(request.headers()['x-csrf-token']).toBe('csrf-assistant');
      writes.push({ key, input });
      if (receipts.has(key)) return json(receipts.get(key), 202);
      if (
        input.accountProfileRevision !== undefined &&
        input.accountProfileRevision !== profileRevision
      )
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'ACCOUNT_REVISION_CONFLICT',
              message: '账号写作资料已变化，请刷新资料并重新确认本轮选择。',
            },
          },
        });
      const isMock = !input.modelConnectionId;
      const targets = input.annotations.filter((a) => a.kind === 'change' && a.blockIndex !== null);
      const turn: ContentTurnDetail = {
        id: crypto.randomUUID(),
        contentId: id,
        baseVersion: detail.item.currentVersion,
        baseRevision: input.baseRevision,
        mode: input.mode,
        message: input.message,
        annotations: input.annotations,
        status: options.queued ? 'queued' : 'succeeded',
        modelName: isMock ? '本地模拟（未调用 AI）' : '本地协议测试',
        isMock,
        result: options.queued
          ? null
          : {
              reply: isMock ? '模拟回复：未调用 AI。' : '先保留真实经历，换一个具体开头。',
              suggestions:
                input.mode === 'discuss' || isMock
                  ? []
                  : (targets.length ? targets : [{ blockIndex: 0 }]).map((a) => ({
                      id: `suggestion-${a.blockIndex}`,
                      blockIndex: a.blockIndex,
                      before: input.document.content[a.blockIndex!]!.content.map(
                        (t) => t.text,
                      ).join(''),
                      after:
                        a.blockIndex === 0
                          ? '早上六点，我推开了家门。'
                          : '最后留下一个具体的问题。',
                      reason: '从具体生活细节切入。',
                      annotationIds: 'id' in a ? [a.id] : [],
                    })),
            },
        failureCode: null,
        historyTruncated: false,
        createdAt: time,
        manuscript: { title: input.title, document: input.document },
        writingProfile: {
          source: input.accountProfileRevision ? 'current' : 'original',
          accountRevision: input.accountProfileRevision ?? originalAccount.revision ?? null,
          cards: input.accountProfileRevision
            ? [{ id: modelId, title: '家人写作卡', kind: 'writing' }]
            : [],
        },
      };
      turns.unshift(turn);
      receipts.set(key, turn);
      if (options.losePost && !lost) {
        lost = true;
        return route.abort('failed');
      }
      return json(turn, 202);
    }
    if (api.startsWith(`${endpoint}/`) && method === 'GET')
      return json(turns.find((turn) => turn.id === api.split('/').at(-1)));
    if (api.endsWith('/cancel') && method === 'POST') {
      turns[0]!.status = 'cancelled';
      return json({});
    }
    unexpected.push(`${method} ${api}`);
    return route.fulfill({ status: 404, body: '{}' });
  });
  return {
    versions,
    turns,
    writes,
    errors,
    unexpected,
    get historyReads() {
      return historyReads;
    },
    conflict() {
      detail.item.revision++;
    },
    changeProfile() {
      profileRevision++;
    },
  };
}

async function open(page: Page, revise = false) {
  await page.goto(path);
  await page.getByRole('button', { name: '打开 AI 协作', exact: true }).click();
  await page.getByLabel('本轮模型', { exact: true }).selectOption(modelId);
  if (revise) await page.getByLabel('协作方式', { exact: true }).selectOption('revise');
  await expect(page.getByRole('button', { name: '确认调用并发送', exact: true })).toBeEnabled();
}
async function annotate(page: Page, block: number, note: string, keep = false) {
  await page.getByLabel('这条意见针对哪里？', { exact: true }).selectOption(String(block));
  await page.getByLabel('这处想改什么？', { exact: true }).fill(note);
  await page
    .getByRole('button', { name: keep ? '保留原文，不要改' : '加入批注', exact: true })
    .click();
}
async function send(page: Page) {
  const replies = page.getByText('回复已就绪', { exact: false });
  const previousReplies = await replies.count();
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(replies).toHaveCount(previousReplies + 1);
}
async function view(page: Page) {
  await page.getByRole('button', { name: '查看并选择修改', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true })).toBeVisible();
}

test('keeps legacy references by default and explicitly reselects current references after a revision conflict', async ({
  page,
}) => {
  const state = await fixture(page, { legacyOriginal: true });
  await open(page);
  const selector = page.getByLabel('本轮账号人设与写作资料', { exact: true });
  await expect(selector).toHaveValue('original');
  await expect(selector.locator('option:checked')).toHaveText('沿用原稿资料 · 未记录修订');
  await page.getByText('查看本轮资料 · 0 份启用', { exact: true }).click();
  await expect(page.getByText('自然真诚', { exact: true })).toBeVisible();
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('先讨论开头怎么写');
  await send(page);
  expect(state.writes[0]!.input.accountProfileRevision).toBeUndefined();
  await expect(
    page.getByText('沿用原稿资料 · 未记录修订 · 基础人设，无启用卡片', { exact: false }),
  ).toBeVisible();
  await selector.selectOption('2');
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('请按家人的写作卡讨论');
  await page.reload();
  await expect(selector).toHaveValue('2');
  state.changeProfile();
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号写作资料已变化');
  expect(state.turns).toHaveLength(1);
  await page.getByRole('button', { name: '刷新写作资料', exact: true }).click();
  await expect(selector).toHaveValue('2');
  await selector.selectOption('3');
  await send(page);
  expect(state.writes.at(-1)!.input.accountProfileRevision).toBe(3);
  await expect(
    page.getByText('本轮选择账号资料 · r3 · 写作卡：家人写作卡', { exact: false }),
  ).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('retries the same paid request and reference revision after an account update and lost reply', async ({
  page,
}) => {
  const state = await fixture(page, { losePost: true });
  await open(page);
  await page.getByLabel('本轮账号人设与写作资料', { exact: true }).selectOption('2');
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('按这一版资料先讨论');
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  state.changeProfile();
  await page.reload();
  await page.getByRole('button', { name: '原样重试 AI 请求', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).not.toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.turns).toHaveLength(1);
  expect(state.writes[0]!.input.accountProfileRevision).toBe(2);
  expect(state.errors).toEqual([]);
});

test('sends unsaved edits and batched anchors, applies selected changes, undoes, then saves explicitly', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await open(page, true);
  await page.getByLabel('内容标题', { exact: true }).fill('尚未保存的家庭故事');
  const editor = page.getByRole('textbox', { name: '内容正文编辑器' });
  await editor.locator('p').first().fill('这是尚未保存的开头。');
  await annotate(page, 0, '从生活细节开始');
  await annotate(page, 2, '结尾不要重复');
  await annotate(page, 1, '这是我的经历，请原样保留', true);
  await send(page);
  expect(state.writes[0]!.input.title).toBe('尚未保存的家庭故事');
  expect(state.writes[0]!.input.document.content[0]!.content[0]!.text).toBe('这是尚未保存的开头。');
  expect(state.writes[0]!.input.annotations.map((a) => [a.blockIndex, a.kind])).toEqual([
    [0, 'change'],
    [2, 'change'],
    [1, 'keep'],
  ]);
  expect(state.versions).toHaveLength(1);
  await view(page);
  await page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true }).check();
  await expect(
    page.getByRole('checkbox', { name: '采用第 3 段修改', exact: true }),
  ).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('article-collaboration.png'), fullPage: true });
  await page.getByRole('button', { name: '将选中建议应用到编辑稿', exact: true }).click();
  await expect(editor.locator('p').first()).toHaveText('早上六点，我推开了家门。');
  await expect(editor.locator('p').nth(1)).toHaveText(paragraphs[1]!);
  await expect(editor.locator('p').nth(2)).toHaveText(paragraphs[2]!);
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('尚未保存的家庭故事');
  expect(state.versions).toHaveLength(1);
  await page.getByRole('button', { name: '撤销本次 AI 修改', exact: true }).click();
  await expect(editor.locator('p').first()).toHaveText('这是尚未保存的开头。');
  await page.getByRole('button', { name: '将选中建议应用到编辑稿', exact: true }).click();
  await expect(editor.locator('p').first()).toHaveText('早上六点，我推开了家门。');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByText('v2 · 修订 2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor.locator('p').first()).toHaveText('早上六点，我推开了家门。');
  expect(state.versions).toHaveLength(2);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('discussion and mock replies never offer manuscript changes', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('先聊聊怎样开头自然一些');
  await send(page);
  await expect(page.getByRole('button', { name: '查看并选择修改', exact: true })).toHaveCount(0);
  await page.getByLabel('本轮模型', { exact: true }).selectOption('');
  await page.getByLabel('协作方式', { exact: true }).selectOption('revise');
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('体验模拟修改流程');
  await page.getByRole('button', { name: '发送模拟请求', exact: true }).click();
  await expect(page.getByText('模拟回复：未调用 AI。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看并选择修改', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  expect(state.versions).toHaveLength(1);
});

test('invalidates old suggestions after local editing and refuses to overwrite a newer server revision', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page, true);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('只改开头');
  await send(page);
  await view(page);
  await page.getByLabel('内容标题', { exact: true }).fill('我后来又改了标题');
  await expect(
    page.getByText('正文、标题或修订已变化，旧建议不能覆盖新稿。请基于当前稿重新发送。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true })).toBeDisabled();
  await page.getByLabel('内容标题', { exact: true }).fill('原始标题');
  await page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true }).check();
  state.conflict();
  await page.getByRole('button', { name: '将选中建议应用到编辑稿', exact: true }).click();
  await expect(
    page.getByText('服务器稿件已变化，旧建议未应用。请先备份并核对最新版本。', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: '内容正文编辑器' }).locator('p').first(),
  ).toHaveText(paragraphs[0]!);
  expect(state.versions).toHaveLength(1);
});

test('recovers unsent annotations on refresh and warns before leaving', async ({ page }) => {
  const state = await fixture(page);
  await open(page, true);
  await annotate(page, 0, '开头太空泛');
  await annotate(page, 1, '', true);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('保持我的口吻');
  await page.getByLabel('这处想改什么？', { exact: true }).fill('还没加入的想法');
  await page.reload();
  await expect(page.getByLabel('这一轮，你想说什么？', { exact: true })).toHaveValue(
    '保持我的口吻',
  );
  await expect(page.getByLabel('这处想改什么？', { exact: true })).toHaveValue('还没加入的想法');
  await expect(page.getByText('修改 · 第 1 段', { exact: true })).toBeVisible();
  await expect(page.getByText('保留 · 第 2 段', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: '← 返回内容库', exact: true }).click();
  await expect(page).toHaveURL(path);
  expect(state.writes).toHaveLength(0);
});

test('retains uncertain requests across refresh and retries the identical input and key', async ({
  page,
}) => {
  const state = await fixture(page, { losePost: true });
  await open(page, true);
  await page.getByLabel('内容标题', { exact: true }).fill('发送时的稿件');
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('只修改开头');
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  await expect(page.getByLabel('这一轮，你想说什么？', { exact: true })).toBeDisabled();
  await page.getByLabel('内容标题', { exact: true }).fill('发送后继续修改的稿件');
  await page.reload();
  await expect(page.getByRole('button', { name: '原样重试 AI 请求', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: '原样重试 AI 请求', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.turns).toHaveLength(1);
  await view(page);
  await expect(page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true })).toBeDisabled();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('发送后继续修改的稿件');
});

for (const value of [null, false]) {
  test(`retains a corrupt assistance record (${value}) instead of authorizing a new paid call`, async ({
    page,
  }) => {
    const state = await fixture(page);
    const key = `creator-assistant:assistant-owner:${id}:pending`;
    const raw = JSON.stringify(value);
    await page.addInitScript(({ key, raw }) => sessionStorage.setItem(key, raw), { key, raw });
    await page.goto(path);
    await expect(page.getByRole('alert').filter({ hasText: '本地请求记录损坏' })).toBeVisible();
    await expect(page.getByLabel('这一轮，你想说什么？', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '发送模拟请求', exact: true })).toBeDisabled();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(raw);
    expect(state.writes).toHaveLength(0);
    expect(state.errors).toEqual([]);
  });
}

test('polls active tasks, blocks duplicate submission and exposes unknown-call reconciliation', async ({
  page,
}) => {
  const state = await fixture(page, { queued: true });
  await open(page);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('讨论开头');
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止后续调用', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认调用并发送', exact: true })).toBeDisabled();
  state.turns[0]!.status = 'needs_review';
  await expect(page.getByRole('link', { name: '核对未知调用', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认调用并发送', exact: true })).toBeDisabled();
  expect(state.historyReads).toBeGreaterThan(1);
  expect(state.writes).toHaveLength(1);
});

test('anchors editor selection and blocks annotations after that paragraph changes', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page, true);
  const editor = page.getByRole('textbox', { name: '内容正文编辑器' });
  await editor.locator('p').nth(1).click();
  await editor.press('Home');
  await editor.press('Shift+End');
  await expect(
    page.getByLabel('这条意见针对哪里？', { exact: true }).locator('option').first(),
  ).toHaveText('正文当前选中段落（第 2 段）');
  await page.getByLabel('这处想改什么？', { exact: true }).fill('语气再自然一点');
  await page.getByRole('button', { name: '加入批注', exact: true }).click();
  await editor.locator('p').nth(1).fill('这段在批注后被我修改了。');
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await expect(
    page.getByText('批注对应的段落已变化，请重新选择该段后提交。', { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test('does not let undo overwrite edits made after applying AI changes', async ({ page }) => {
  await fixture(page);
  await open(page, true);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('改善开头');
  await send(page);
  await view(page);
  await page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true }).check();
  await page.getByRole('button', { name: '将选中建议应用到编辑稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销本次 AI 修改', exact: true })).toBeVisible();
  await page.getByLabel('内容标题', { exact: true }).fill('采用后继续完善的标题');
  await page.getByRole('button', { name: '撤销本次 AI 修改', exact: true }).click();
  await expect(
    page.getByText('采用建议后稿件又有修改，不能直接撤销覆盖。请使用正文撤销或历史版本进行核对。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('内容标题', { exact: true })).toHaveValue('采用后继续完善的标题');
});

test('stops queued assistance without creating another request', async ({ page }) => {
  const state = await fixture(page, { queued: true });
  await open(page);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('先讨论');
  await page.getByRole('button', { name: '确认调用并发送', exact: true }).click();
  await page.getByRole('button', { name: '停止后续调用', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止后续调用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认调用并发送', exact: true })).toBeEnabled();
  expect(state.turns[0]!.status).toBe('cancelled');
  expect(state.writes).toHaveLength(1);
});

test('ignores a suggestion response that arrives after leaving the article', async ({ page }) => {
  const state = await fixture(page);
  await open(page, true);
  await page.getByLabel('这一轮，你想说什么？', { exact: true }).fill('修改开头');
  await send(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route(`**/api/v1${endpoint}/*`, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/writing-profile'))
      return route.fallback();
    observed();
    await gate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: state.turns[0] }),
    });
  });
  await page.getByRole('button', { name: '查看并选择修改', exact: true }).click();
  await received;
  await page.getByRole('link', { name: '← 返回内容库', exact: true }).click();
  await expect(page).toHaveURL('/contents');
  release();
  await page.getByRole('link', { name: /家庭写作 · v1/ }).click();
  await page.getByRole('button', { name: '打开 AI 协作', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看并选择修改', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '采用第 1 段修改', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});
