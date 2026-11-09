import { expect, test } from '@playwright/test';
import {
  actionId,
  delegateAction,
  dynamicFixture,
  dynamicRun,
  expectNoOverflow,
  plannerId,
  runId,
  selectTeam,
  teamAction,
} from './fixtures/dynamic-team';

test('dynamic mode is an explicit real-model team opt-in with visible costs', async ({
  page,
}, testInfo) => {
  const fixture = await dynamicFixture(page);
  await page.goto('/');
  await expect(page.locator('.el-select').first()).toContainText(
    '模拟模板（无模型费用，仅单专家）',
  );
  await expect(page.getByRole('radio', { name: '动态协作', exact: true })).toHaveCount(0);
  await page.getByLabel('交给哪位专家', { exact: true }).press('Enter');
  await expect(page.getByRole('option', { name: '动态编辑部（需选择模型连接）' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await selectTeam(page);
  await expect(page.getByRole('radio', { name: '分阶段协作', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: '动态协作', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: '动态协作', exact: true })).toBeChecked();
  await expect(
    page.getByText('规划与成员交流也会产生调用与 Token 费用', { exact: false }),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('dynamic-mode.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '启动专家团创作', exact: false }).click();
  await expect(page).toHaveURL(`/runs/${runId}`);
  expect(fixture.creates).toHaveLength(1);
  expect(fixture.creates[0]!.body).toMatchObject({
    teamMode: 'dynamic',
    modelConnectionId: '44444444-4444-4444-8444-444444444444',
    limits: { maxCalls: 24 },
  });
  await expect(page.getByRole('heading', { name: '动态团队协作', exact: true })).toBeVisible();
});

test('creation retries freeze a mode-aware request key and never auto-submit', async ({ page }) => {
  const fixture = await dynamicFixture(page);
  fixture.failCreates = true;
  await page.goto('/');
  await selectTeam(page);
  const submit = page.getByRole('button', { name: '启动专家团创作', exact: false });
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('创建结果暂未确认');
  expect(fixture.creates[0]!.body.teamMode).toBe('staged');
  await submit.click();
  await expect.poll(() => fixture.creates.length).toBe(2);
  expect(fixture.creates[0]!.key).toBe(fixture.creates[1]!.key);
  await page
    .getByRole('radiogroup', { name: '专家团协作方式', exact: true })
    .getByText('动态协作', { exact: true })
    .click();
  await submit.click();
  await expect.poll(() => fixture.creates.length).toBe(3);
  expect(fixture.creates[2]!.body.teamMode).toBe('dynamic');
  expect(fixture.creates[2]!.key).not.toBe(fixture.creates[1]!.key);
  await submit.click();
  await expect.poll(() => fixture.creates.length).toBe(4);
  expect(fixture.creates[3]).toEqual(fixture.creates[2]);
  await page.reload();
  expect(fixture.creates).toHaveLength(4);
  await selectTeam(page);
  await expect(page.getByRole('radio', { name: '分阶段协作', exact: true })).toBeChecked();
});

test('question draft survives reload, renders as text and submits only once', async ({
  page,
}, testInfo) => {
  const question = '读者是谁？<img src=x onerror="window.fixtureXss=true">';
  const fixture = await dynamicFixture(
    page,
    dynamicRun([teamAction({ action: 'ask_user', question })]),
  );
  let release!: () => void;
  fixture.responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto(`/runs/${runId}`);
  const panel = page.getByRole('region', { name: '动态团队协作', exact: true });
  await expect(panel.getByText(question, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'fixtureXss' in window)).toBe(false);
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交答复', exact: true })).toBeDisabled();
  await page.getByLabel('你的答复', { exact: true }).fill('知识管理初学者，希望看到具体步骤。');
  await page.reload();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveValue(
    '知识管理初学者，希望看到具体步骤。',
  );
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('pending-question.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '提交答复', exact: true }).click();
  await expect.poll(() => fixture.responses.length).toBe(1);
  await expect(page.getByRole('button', { name: '原样重试本次答复' })).toBeDisabled();
  await expect(page.getByLabel('你的答复', { exact: true })).toBeDisabled();
  release();
  await expect(panel.getByText('你的答复', { exact: true })).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveCount(0);
  expect(fixture.responses[0]!.body).toEqual({ answer: '知识管理初学者，希望看到具体步骤。' });
  await page.reload();
  await expect(
    panel.getByText('知识管理初学者，希望看到具体步骤。', { exact: true }),
  ).toBeVisible();
  expect(fixture.responses).toHaveLength(1);
});

for (const approved of [true, false]) {
  test(`plan ${approved ? 'approval' : 'rejection'} shows named tasks, dependencies and durable decision`, async ({
    page,
  }, testInfo) => {
    const fixture = await dynamicFixture(page, dynamicRun([delegateAction()]));
    await page.goto(`/runs/${runId}`);
    const card = page.locator(`[data-action-id="${actionId}"]`);
    await expect(
      card.getByText('林主编 · 主理人规划 · 协作第 2 轮', { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByText('围绕读者问题完成初稿，不编造事实。', { exact: true }),
    ).toBeVisible();
    await expect(card.getByText('无，可独立开始', { exact: true })).toBeVisible();
    await expect(card.getByText('周主笔 · 团队成员 · 协作第 1 轮', { exact: false })).toBeVisible();
    await page
      .getByLabel('补充说明（可选）', { exact: true })
      .fill(approved ? '同意，优先写具体步骤。' : '不同意，请先缩小读者范围。');
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('pending-plan.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('button', { name: approved ? '同意并继续' : '拒绝并反馈', exact: true })
      .click();
    await expect(
      card.getByText(approved ? '你的答复 · 同意' : '你的答复 · 拒绝', { exact: true }),
    ).toBeVisible();
    expect(fixture.responses).toHaveLength(1);
    expect(fixture.responses[0]!.body.approved).toBe(approved);
    await page.reload();
    await expect(card.getByText(approved ? '已同意' : '已拒绝', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '同意并继续', exact: true })).toHaveCount(0);
  });
}

test('confirmation requires an explicit decision and can use a transparent default answer', async ({
  page,
}) => {
  const fixture = await dynamicFixture(
    page,
    dynamicRun([teamAction({ action: 'confirm', question: '可以删掉没有出处的数据吗？' })]),
  );
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText('可以删掉没有出处的数据吗？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '拒绝并反馈', exact: true }).click();
  await expect.poll(() => fixture.responses.length).toBe(1);
  expect(fixture.responses[0]!.body).toEqual({ answer: '不同意继续执行', approved: false });
  await expect(page.getByText('你的答复 · 拒绝', { exact: true })).toBeVisible();
});

test('uncertain reply preserves its exact decision across reload and retries only on demand', async ({
  page,
}) => {
  const fixture = await dynamicFixture(page, dynamicRun([delegateAction()]));
  fixture.failResponses = 1;
  await page.goto(`/runs/${runId}`);
  await page
    .getByLabel('补充说明（可选）', { exact: true })
    .fill('不同意，请先列出需要核实的事实。');
  await page.getByRole('button', { name: '拒绝并反馈', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '未自动重发' })).toBeVisible();
  expect(fixture.responses).toHaveLength(1);
  await page.reload();
  await page.reload();
  const answer = page.getByLabel('补充说明（可选）', { exact: true });
  await expect(answer).toHaveValue('不同意，请先列出需要核实的事实。');
  await expect(answer).toBeDisabled();
  await expect(page.getByRole('button', { name: '同意并继续', exact: true })).toHaveCount(0);
  expect(fixture.responses).toHaveLength(1);
  await page.getByRole('button', { name: '原样重试本次答复', exact: true }).click();
  await expect(page.getByText('你的答复 · 拒绝', { exact: true })).toBeVisible();
  expect(fixture.responses).toHaveLength(2);
  expect(fixture.responses[1]).toEqual(fixture.responses[0]);
});

test('409 conflicts require snapshot reconciliation, never a changed payload', async ({ page }) => {
  const fixture = await dynamicFixture(page);
  fixture.conflictResponses = true;
  await page.goto(`/runs/${runId}`);
  await page.getByLabel('你的答复', { exact: true }).fill('先面向新手读者。');
  await page.getByRole('button', { name: '提交答复', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '已有不同答复或状态已变化' }),
  ).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toBeDisabled();
  fixture.run.execution!.collaboration![0]!.response = { answer: '在其他页面确认的答复。' };
  fixture.run.execution!.collaboration![0]!.state = 'applied';
  fixture.run.revision++;
  await page.getByRole('button', { name: '核对最新快照' }).click();
  await expect(page.getByText('在其他页面确认的答复。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveCount(0);
  expect(fixture.responses).toHaveLength(1);
});

test('an accepted but lost answer is replayed idempotently without a second transition', async ({
  page,
}) => {
  const fixture = await dynamicFixture(page);
  fixture.loseResponses = 1;
  await page.goto(`/runs/${runId}`);
  await page.getByLabel('你的答复', { exact: true }).fill('主要面向知识管理初学者。');
  await page.getByRole('button', { name: '提交答复', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '服务端已记录' })).toBeVisible();
  const appliedRevision = fixture.run.revision;
  await page.getByRole('button', { name: '原样重试本次答复', exact: true }).click();
  await expect(page.locator('.team-action__answer')).toContainText('主要面向知识管理初学者。');
  expect(fixture.responses).toHaveLength(2);
  expect(fixture.responses[1]).toEqual(fixture.responses[0]);
  expect(fixture.responses[1]!.body).not.toHaveProperty('approved');
  expect(fixture.run.revision).toBe(appliedRevision);
});

test('waiting tasks can be cancelled without replying, and stopped actions stay read-only', async ({
  page,
}, testInfo) => {
  const fixture = await dynamicFixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByLabel('你的答复', { exact: true }).fill('这段未提交的文字应保留。');
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已取消', exact: true })).toBeVisible();
  await expect(page.getByText('已停止 · 不再等待', { exact: true })).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
  expect(fixture.responses).toHaveLength(0);
  expect(fixture.cancellations).toBe(1);
  await page.reload();
  await expect(
    page.getByText('本次协作已停止，没有可提交的交互。历史记录仍保留。', { exact: true }),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('cancelled-team.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('all directive and message types retain actual source, round and readable history', async ({
  page,
}, testInfo) => {
  const actions = [
    teamAction({ action: 'finalize', summary: '按已确认方向汇总候选稿。' }),
    teamAction({ action: 'deliver', content: '<script>not executable</script>候选交付。' }),
    teamAction({ action: 'request_peer', memberId: 'writer', question: '标题是否准确？' }),
  ].map((action, index) => ({
    ...action,
    id: `history-${index}`,
    state: index === 2 ? ('peer_wait' as const) : ('applied' as const),
  }));
  const run = dynamicRun(actions);
  run.status = 'running';
  await dynamicFixture(page, run);
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByText('当前没有需要你答复的交互，团队将按任务状态继续推进。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '汇总安排', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '内容交付', exact: true })).toBeVisible();
  await expect(page.getByText('等待成员答复', { exact: true })).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveCount(0);
  await page.getByText('团队交接记录 · 6 条', { exact: true }).click();
  for (const label of ['任务委派', '成员汇报', '协作提问', '协作答复', '协作计划', '确认记录'])
    await expect(page.locator('.team-messages strong').filter({ hasText: label })).toContainText(
      '林主编 · 主理人规划 · 协作第 2 轮 → 周主笔',
    );
  const planner = page
    .locator('.agent-execution')
    .filter({ has: page.getByRole('heading', { name: '林主编', exact: true }) });
  await expect(planner.getByText(plannerId, { exact: true })).toBeVisible();
  await planner.getByText('模型调用账本', { exact: true }).click();
  await expect(planner.getByText('第 2 轮 · 已完成', { exact: true })).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('collaboration-history.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('waiting without a pending action still polls read-only snapshots', async ({ page }) => {
  await page.clock.install();
  const fixture = await dynamicFixture(page, dynamicRun([]));
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText('当前快照没有可答复的待办', { exact: false })).toBeVisible();
  await expect.poll(() => fixture.events).toBe(1);
  fixture.run.execution!.collaboration = [teamAction()];
  fixture.run.revision++;
  await page.clock.fastForward(8000);
  await expect(page.getByLabel('你的答复', { exact: true })).toBeVisible();
  expect(fixture.reads).toBeGreaterThan(1);
  expect(fixture.responses).toHaveLength(0);
});

test('waiting snapshots do not close SSE, and newer terminal events resolve the panel', async ({
  page,
}) => {
  const fixture = await dynamicFixture(page);
  let connections = 0;
  await page.route(`**/creation-runs/${runId}/events`, (route) => {
    connections++;
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 100\nevent: run.snapshot\ndata: ${JSON.stringify(fixture.run)}\n\n`,
    });
  });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByLabel('你的答复', { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(1);
  fixture.run.status = 'cancelled';
  fixture.run.revision++;
  await expect(page.getByRole('heading', { name: '已取消', exact: true })).toBeVisible();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveCount(0);
});

test('a late action response cannot navigate or replace a different page', async ({ page }) => {
  const fixture = await dynamicFixture(page);
  let release!: () => void;
  fixture.responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto(`/runs/${runId}`);
  await page.getByLabel('你的答复', { exact: true }).fill('主要面向新手。');
  await page.getByRole('button', { name: '提交答复', exact: true }).click();
  await expect.poll(() => fixture.responses.length).toBe(1);
  await page.getByRole('link', { name: '返回创作记录', exact: true }).click();
  await expect(page).toHaveURL('/runs');
  const received = page.waitForResponse('**/actions/*/respond');
  release();
  await received;
  await expect(
    page.getByRole('heading', { name: '每个想法，都有来处。', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL('/runs');
});

test('tab-local drafts are isolated by user, run and action', async ({ page }) => {
  const fixture = await dynamicFixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByLabel('你的答复', { exact: true }).fill('仅属于第一个用户的私有答复。');
  fixture.owner = 'different-owner';
  await page.reload();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveValue('');
  await page.getByLabel('你的答复', { exact: true }).fill('仅属于另一条交互的答复。');
  fixture.run.execution!.collaboration![0]!.id = 'different-action';
  fixture.run.revision++;
  await page.reload();
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveValue('');
  await page.getByLabel('你的答复', { exact: true }).fill('这段答复仅属于当前任务。');
  fixture.run.id = '66666666-6666-4666-8666-666666666666';
  await page.goto(`/runs/${fixture.run.id}`);
  await expect(page.getByLabel('你的答复', { exact: true })).toHaveValue('');
  expect(fixture.responses).toHaveLength(0);
});
