import { expect, test, type Page } from '@playwright/test';
import type { Account, SaveWritingCardsInput } from '@creator-ai/contracts';

const id = '55555555-5555-4555-8555-555555555555';
async function fixture(page: Page, loseSave = false) {
  let account: Account = {
    id,
    name: '家庭公众号',
    platform: 'wechat',
    audience: '家庭读者',
    persona: '自然克制',
    revision: 1,
    defaultExpertId: null,
    createdAt: '2026-11-09T00:00:00Z',
  };
  const writes: SaveWritingCardsInput[] = [],
    errors: string[] = [],
    unexpected: string[] = [];
  let lost = false;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/v1', '');
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, requestId: 'cards-fixture' } });
    const list = (items: unknown[]) => json({ items, total: items.length, page: 1, pageSize: 100 });
    if (path === '/auth/session')
      return json({
        user: { id: 'cards-owner', username: 'creator' },
        csrfToken: 'cards-csrf',
        expiresAt: '2026-11-20T00:00:00Z',
      });
    if (path === '/accounts') return list([account]);
    if (path === '/models/capabilities')
      return json({ modelMode: 'mock', canConfigureModels: false, allowedHosts: [], tools: [] });
    if (path === '/experts') return list([]);
    if (path === `/accounts/${id}` && req.method() === 'GET') return json(account);
    if (path === `/accounts/${id}/writing-cards` && req.method() === 'POST') {
      const input = req.postDataJSON() as SaveWritingCardsInput;
      expect(req.headers()['x-csrf-token']).toBe('cards-csrf');
      writes.push(input);
      if (input.baseRevision !== account.revision)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'ACCOUNT_REVISION_CONFLICT', message: '账号已变化' } },
        });
      account = { ...account, writingCards: input.writingCards, revision: account.revision + 1 };
      if (loseSave && !lost) {
        lost = true;
        return route.abort('failed');
      }
      return json(account);
    }
    unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/accounts');
  await page.getByRole('button', { name: '写作资料 · 0', exact: true }).click();
  return { writes, errors, unexpected };
}
const file = (name: string, text: string) => ({
  name,
  mimeType: 'text/markdown',
  buffer: Buffer.from(text, 'utf8'),
});
const upload = (page: Page) => page.getByLabel('导入写作资料文件', { exact: true });

test('imports existing Markdown cards, edits types and saves only after explicit confirmation', async ({
  page,
}, info) => {
  const state = await fixture(page);
  const persona = '# 人物卡\r\n{{NAME_ab12cd34}}\n用朴素的话说真实经历。';
  await upload(page).setInputFiles([
    file('人物卡.md', persona),
    file('写作卡.md', '不要用套话；先讲具体细节。'),
    file('范文.md', '<script>window.cardExecuted=true</script>\n只参考语气。'),
  ]);
  await expect(page.getByLabel('第 1 份资料正文', { exact: true })).toHaveValue(
    persona.replace(/\r\n/g, '\n'),
  );
  await expect(page.getByLabel('第 1 份资料类型', { exact: true })).toHaveValue('persona');
  await expect(page.getByLabel('第 3 份资料类型', { exact: true })).toHaveValue('sample');
  expect(state.writes).toHaveLength(0);
  await page.getByRole('checkbox', { name: '创作时使用', exact: true }).nth(2).uncheck();
  await page.getByLabel('第 2 份资料正文', { exact: true }).fill('保留具体细节；不要替我编经历。');
  await page.screenshot({ path: info.outputPath('writing-cards.png'), fullPage: true });
  await page.getByRole('button', { name: '保存写作资料', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.writingCards.map((c) => c.kind)).toEqual([
    'persona',
    'writing',
    'sample',
  ]);
  expect(state.writes[0]!.writingCards[0]!.content).toBe(persona);
  expect(state.writes[0]!.writingCards[2]!.enabled).toBe(false);
  await page.getByRole('button', { name: '写作资料 · 2', exact: true }).click();
  await expect(page.getByLabel('第 2 份资料正文', { exact: true })).toHaveValue(
    '保留具体细节；不要替我编经历。',
  );
  expect(await page.evaluate(() => 'cardExecuted' in window)).toBe(false);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
test('rejects malformed UTF-8 and oversized batches atomically, retaining the existing local draft', async ({
  page,
}) => {
  const state = await fixture(page);
  await upload(page).setInputFiles([file('人物卡.md', 'Valid draft')]);
  await upload(page).setInputFiles([
    file('写作卡.md', 'Valid second file'),
    { name: '乱码.md', mimeType: 'text/markdown', buffer: Buffer.from([0xff, 0xfe, 0x61]) },
  ]);
  await expect(page.getByRole('alert')).toContainText('UTF-8');
  await expect(page.getByText('第 2 份资料', { exact: true })).not.toBeVisible();
  await upload(page).setInputFiles([file('超长.md', '字'.repeat(8001))]);
  await expect(page.getByRole('alert')).toContainText('8,000');
  await expect(page.getByLabel('第 1 份资料正文', { exact: true })).toHaveValue('Valid draft');
  expect(state.writes).toHaveLength(0);
});
test('reads back an ambiguous save before allowing another write, preserving local edits', async ({
  page,
}) => {
  const state = await fixture(page, true);
  await upload(page).setInputFiles([file('写作卡.md', '明确、真实、自然。')]);
  await page.getByRole('button', { name: '保存写作资料', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本地资料仍保留');
  await expect(page.getByRole('button', { name: '保存写作资料', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '读取服务器资料', exact: true }).click();
  await expect(page.getByLabel('服务器写作资料')).toContainText('服务器配置 r2');
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: '采用服务器资料', exact: true }).click();
  await expect(page.getByLabel('第 1 份资料正文', { exact: true })).toHaveValue(
    '明确、真实、自然。',
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  expect(state.writes).toHaveLength(1);
  expect(state.errors).toEqual([]);
});
