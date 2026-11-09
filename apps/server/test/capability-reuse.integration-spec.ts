import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Account, ExpertInput, SessionInfo, Skill } from '@creator-ai/contracts';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { createAdmin } from '../src/modules/auth/bootstrap';
import { bootstrapApi } from '../src/main-api';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { exportExpert } from '../src/modules/catalog/package-codec';
import { readArchive, writeArchive } from '../src/modules/catalog/package-archive';
import { CreationService } from '../src/modules/creation/creation.service';
import { ContentService } from '../src/modules/content/content.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';
import {
  AccountEntity,
  ExpertVersionEntity,
  RunEntity,
  SkillEntity,
  SkillVersionEntity,
  UserEntity,
} from '../src/database/entities';

describe('Reusable account defaults, pinned skills and append-only capability restore', () => {
  let db: DataSource, app: INestApplication, base: string, ownerId: string, otherId: string;
  let catalog: CatalogService, creation: CreationService;
  let headers: Record<string, string>;
  const origin = 'http://127.0.0.1:5173';
  const definition: ExpertInput = {
    name: 'Reusable editor',
    description: 'A saved working method',
    instructions: 'Write clearly, mark uncertainties',
    skillKeys: [],
  };
  const profile = {
    name: 'Reusable account',
    platform: 'wechat' as const,
    audience: 'Readers',
    persona: 'Precise',
  };
  const document = (key: string, body = 'ORIGINAL_INSTRUCTIONS') =>
    `---\nname: ${key.split(':').at(-1)}\ndescription: Reusable method\n---\n${body}`;
  const uniqueKey = () => `reuse-${randomUUID()}`;
  const request = (path: string, body?: unknown, overrides: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { ...headers, ...overrides },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const create = (
    account: Account,
    extra: Partial<Parameters<CreationService['create']>[1]> = {},
    key = randomUUID(),
  ) =>
    creation.create(
      ownerId,
      { accountId: account.id, topic: 'Reuse test topic', brief: '', ...extra },
      key,
    );
  async function skillFixture() {
    const key = uniqueKey();
    const { skills } = await catalog.importPackage(
      ownerId,
      await writeArchive([
        { path: 'SKILL.md', content: document(key), encoding: 'utf8' },
        { path: 'references/source.md', content: 'ORIGINAL_RESOURCE', encoding: 'utf8' },
      ]),
    );
    return skills[0]!;
  }
  async function changedSkill(skill: Skill) {
    const result = await catalog.updateSkill(ownerId, skill.key, 1, {
      key: skill.key,
      document: document(skill.key, 'LATER_INSTRUCTIONS'),
    });
    // Fixture-only resource authoring: there is deliberately no live resource-edit endpoint.
    const changed = {
      ...result,
      files: [
        { path: 'references/source.md', content: 'LATER_RESOURCE', encoding: 'utf8' as const },
      ],
    };
    await db.transaction(async (em) => {
      const row = await em.findOneByOrFail(SkillEntity, { ownerId, key: skill.key });
      await em.update(SkillEntity, row.id, { definition: changed });
      await em.update(SkillVersionEntity, { skillId: row.id, version: 2 }, { definition: changed });
    });
    return changed;
  }
  it('saves UTF-8 account cards beyond 64 KiB, checks ownership and serializes profile revisions', async () => {
    const account = await catalog.createAccount(ownerId, profile);
    const path = `/accounts/${account.id}/writing-cards`;
    const cards = Array.from({ length: 3 }, (_, i) => ({
      id: randomUUID(),
      title: `Card ${i}`,
      kind: 'writing',
      enabled: true,
      content: '写'.repeat(8000),
    }));
    const writes = await Promise.all(
      [1, 2].map(() => request(path, { baseRevision: 1, writingCards: cards })),
    );
    expect(writes.map((r) => r.status).sort()).toEqual([200, 409]);
    const saved = await catalog.getAccount(ownerId, account.id);
    expect(saved.revision).toBe(2);
    expect(saved.writingCards).toEqual(cards);
    expect(
      (await request(path, { baseRevision: 2, writingCards: [...cards, cards[0]] })).status,
    ).toBe(400);
    await expect(catalog.getAccount(otherId, account.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      catalog.saveWritingCards(otherId, account.id, { baseRevision: 2, writingCards: [] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { ...headers, 'X-CSRF-Token': '' },
          body: JSON.stringify({ baseRevision: 2, writingCards: [] }),
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}/accounts/${account.id}`)).status).toBe(401);
  });
  it('freezes cards in new creations and continuation branches instead of editing old snapshots', async () => {
    const expert = await catalog.createExpert(ownerId, definition);
    const account = await catalog.createAccount(ownerId, {
      ...profile,
      defaultExpertId: expert.id,
    });
    const card = {
      id: randomUUID(),
      title: 'Original voice',
      kind: 'writing' as const,
      enabled: true,
      content: 'ORIGINAL_VOICE',
    };
    const saved = await catalog.saveWritingCards(ownerId, account.id, {
      baseRevision: 1,
      writingCards: [card],
    });
    const source = await create(saved, { accountRevision: 2 });
    await new TaskRunner(db, new MockTextProvider()).execute(source.id);
    await catalog.saveWritingCards(ownerId, account.id, {
      baseRevision: 2,
      writingCards: [{ ...card, content: 'LATER_VOICE' }],
    });
    expect((await creation.get(ownerId, source.id)).snapshot.account.writingCards).toEqual([card]);
    await expect(create(saved, { accountRevision: 2 })).rejects.toMatchObject({ status: 409 });
    const later = await create(await catalog.getAccount(ownerId, account.id));
    expect(later.snapshot.account.writingCards?.[0]!.content).toBe('LATER_VOICE');
    const branch = await creation.continueDraft(
      ownerId,
      source.id,
      { instruction: 'Improve the opening' },
      randomUUID(),
    );
    expect(branch.snapshot.account.writingCards).toEqual([card]);
  });
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL,
      redis = process.env.TEST_REDIS_URL;
    if (
      !url ||
      !new URL(url).pathname.endsWith('_test') ||
      !redis ||
      new URL(redis).pathname !== '/15'
    )
      throw new Error('Dedicated test services required');
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ORIGIN: origin,
      MODEL_MODE: 'mock',
      NODE_ENV: 'test',
    });
    db = await createDataSource(url).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE users CASCADE');
    const secret = randomUUID() + randomUUID();
    await createAdmin(db, 'reuse-test', secret);
    app = await bootstrapApi(0);
    base = `${await app.getUrl()}/api/v1`.replace('0.0.0.0', '127.0.0.1');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'reuse-test', ['pass' + 'word']: secret }),
    });
    expect(login.status).toBe(200);
    const info = ((await login.json()) as { data: SessionInfo }).data;
    ownerId = info.user.id;
    headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      Origin: origin,
      'X-CSRF-Token': info.csrfToken,
      'Content-Type': 'application/json',
    };
    otherId = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: otherId,
      username: 'other-reuse-owner',
      passwordHash: 'not-a-login',
      createdAt: new Date(),
    });
    catalog = new CatalogService(db);
    creation = new CreationService(db);
  });
  afterAll(async () => {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
  });

  it('creates nullable defaults and binds, changes and clears with optimistic revisions', async () => {
    const expert = await catalog.createExpert(ownerId, definition);
    let account = await catalog.createAccount(ownerId, profile);
    expect(account).toMatchObject({ revision: 1, defaultExpertId: null });
    expect(
      (await db.getRepository(AccountEntity).findOneByOrFail({ id: account.id })).profile,
    ).not.toHaveProperty('defaultExpertId');
    account = await catalog.setAccountDefault(ownerId, account.id, {
      expertId: expert.id,
      baseRevision: 1,
    });
    expect(account).toMatchObject({ revision: 2, defaultExpertId: expert.id });
    expect(
      await catalog.setAccountDefault(ownerId, account.id, {
        expertId: expert.id,
        baseRevision: 2,
      }),
    ).toEqual(account);
    expect(
      await catalog.setAccountDefault(ownerId, account.id, { expertId: null, baseRevision: 2 }),
    ).toMatchObject({ revision: 3, defaultExpertId: null });
    expect(
      await catalog.createAccount(ownerId, { ...profile, defaultExpertId: expert.id }),
    ).toMatchObject({ revision: 1, defaultExpertId: expert.id });
  });
  it('enforces owner binding both in the service and the composite database foreign key', async () => {
    const foreign = await catalog.createExpert(otherId, definition);
    const account = await catalog.createAccount(ownerId, profile);
    await expect(
      catalog.createAccount(ownerId, { ...profile, defaultExpertId: foreign.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      catalog.setAccountDefault(ownerId, account.id, { expertId: foreign.id, baseRevision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      catalog.setAccountDefault(otherId, account.id, { expertId: null, baseRevision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db.getRepository(AccountEntity).update(account.id, { defaultExpertId: foreign.id }),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    expect(
      (await catalog.listAccounts(ownerId, 1, 100)).items.find((row) => row.id === account.id),
    ).toEqual(account);
  });
  it('serializes competing default changes and rejects stale revisions without extra increments', async () => {
    const a = await catalog.createExpert(ownerId, definition),
      b = await catalog.createExpert(ownerId, definition);
    const account = await catalog.createAccount(ownerId, profile);
    const results = await Promise.allSettled(
      [a, b].map((expert) =>
        catalog.setAccountDefault(ownerId, account.id, { expertId: expert.id, baseRevision: 1 }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    expect(
      (await db.getRepository(AccountEntity).findOneByOrFail({ id: account.id })).revision,
    ).toBe(2);
  });
  it('resolves the default current definition but allows a one-off explicit override', async () => {
    const a = await catalog.createExpert(ownerId, definition),
      b = await catalog.createExpert(ownerId, definition);
    const account = await catalog.createAccount(ownerId, { ...profile, defaultExpertId: a.id });
    await catalog.updateExpert(ownerId, a.id, 1, {
      ...definition,
      instructions: 'New expert method',
    });
    expect((await create(account, { accountRevision: 1 })).snapshot).toMatchObject({
      account: { revision: 1, defaultExpertId: a.id },
      expert: { id: a.id, version: 2, instructions: 'New expert method' },
    });
    expect((await create(account, { expertId: b.id })).snapshot.expert.id).toBe(b.id);
    expect(
      (await db.getRepository(AccountEntity).findOneByOrFail({ id: account.id })).defaultExpertId,
    ).toBe(a.id);
  });
  it('replays an already-created default run even after defaults change, but rejects new stale requests', async () => {
    const a = await catalog.createExpert(ownerId, definition),
      b = await catalog.createExpert(ownerId, definition);
    const account = await catalog.createAccount(ownerId, { ...profile, defaultExpertId: a.id });
    const key = randomUUID();
    const run = await create(account, { accountRevision: 1 }, key);
    await catalog.setAccountDefault(ownerId, account.id, { expertId: b.id, baseRevision: 1 });
    expect(await create(account, { accountRevision: 1 }, key)).toEqual(run);
    await expect(create(account, { accountRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(create(account, { accountRevision: 2 }, key)).rejects.toMatchObject({
      status: 409,
    });
    expect((await create(account, { accountRevision: 2 })).snapshot.expert.id).toBe(b.id);
  });
  it('never falls back when a default is unset, disabled or is a team without a model', async () => {
    const before = await db.getRepository(RunEntity).countBy({ ownerId });
    const account = await catalog.createAccount(ownerId, profile);
    await expect(create(account)).rejects.toMatchObject({
      status: 422,
      response: { code: 'DEFAULT_EXPERT_REQUIRED' },
    });
    const expert = await catalog.createExpert(ownerId, definition);
    await catalog.setAccountDefault(ownerId, account.id, { expertId: expert.id, baseRevision: 1 });
    await catalog.setExpertEnabled(ownerId, expert.id, false, 1);
    await expect(create(account)).rejects.toMatchObject({
      status: 422,
      response: { code: 'EXPERT_DISABLED' },
    });
    await expect(
      catalog.createAccount(ownerId, { ...profile, defaultExpertId: expert.id }),
    ).rejects.toMatchObject({ status: 422 });
    const team = await catalog.createExpert(ownerId, {
      ...definition,
      expertType: 'team',
      team: {
        leadAgent: 'lead',
        members: ['lead', 'writer'].map((agentId) => ({ ...definition, agentId })),
      },
    });
    await catalog.setAccountDefault(ownerId, account.id, { expertId: team.id, baseRevision: 2 });
    await expect(create(account)).rejects.toMatchObject({
      status: 422,
      response: { code: 'TEAM_RUNTIME_UNAVAILABLE' },
    });
    expect(await db.getRepository(RunEntity).countBy({ ownerId })).toBe(before);
  });
  it('pins historical instructions/resources while unpinned experts resolve the latest', async () => {
    const skill = await skillFixture();
    await changedSkill(skill);
    const pinned = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: [skill.key],
      skillVersions: { [skill.key]: 1 },
    });
    const latest = await catalog.createExpert(ownerId, { ...definition, skillKeys: [skill.key] });
    const account = await catalog.createAccount(ownerId, profile);
    expect((await create(account, { expertId: pinned.id })).snapshot.skills[0]).toMatchObject({
      version: 1,
      instructions: 'ORIGINAL_INSTRUCTIONS',
      files: skill.files,
    });
    expect((await create(account, { expertId: latest.id })).snapshot.skills[0]).toMatchObject({
      version: 2,
      instructions: 'LATER_INSTRUCTIONS',
      files: [{ content: 'LATER_RESOURCE' }],
    });
  });
  it('rejects unavailable, foreign and nonexistent pinned versions including bogus builtin history', async () => {
    const skill = await skillFixture();
    await expect(
      catalog.createExpert(ownerId, {
        ...definition,
        skillKeys: [skill.key],
        skillVersions: { [skill.key]: 99 },
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'SKILL_VERSION_UNAVAILABLE' } });
    await expect(
      catalog.createExpert(otherId, {
        ...definition,
        skillKeys: [skill.key],
        skillVersions: { [skill.key]: 1 },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      catalog.createExpert(ownerId, {
        ...definition,
        skillKeys: ['plain-writing'],
        skillVersions: { 'plain-writing': 2 },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const expert = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: [skill.key],
      skillVersions: { [skill.key]: 1 },
    });
    await catalog.setSkillEnabled(ownerId, skill.key, false, 1);
    const account = await catalog.createAccount(ownerId, profile);
    await expect(create(account, { expertId: expert.id })).rejects.toMatchObject({
      status: 422,
      response: { code: 'SKILL_UNAVAILABLE' },
    });
  });
  it('restores all historical Skill content as a new version without re-enabling it', async () => {
    const skill = await skillFixture();
    await changedSkill(skill);
    const before = await catalog.skillVersions(ownerId, skill.key, 1, 100);
    await catalog.setSkillEnabled(ownerId, skill.key, false, 2);
    expect(
      await catalog.restoreSkill(ownerId, skill.key, { version: 1, baseVersion: 2 }),
    ).toMatchObject({ ...skill, version: 3, enabled: false });
    const after = await catalog.skillVersions(ownerId, skill.key, 1, 100);
    expect(after.items[0]).toMatchObject({
      version: 3,
      restoredFrom: 1,
      document: skill.document,
      files: skill.files,
      source: 'imported',
    });
    expect(after.items.slice(1)).toEqual(before.items);
    await expect(
      catalog.restoreSkill(ownerId, skill.key, { version: 3, baseVersion: 3 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      catalog.restoreSkill(ownerId, skill.key, { version: 99, baseVersion: 3 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      catalog.restoreSkill(ownerId, 'plain-writing', { version: 1, baseVersion: 2 }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('appends at most one Skill restore across parallel requests and uncertain-result retries', async () => {
    const skill = await skillFixture();
    await changedSkill(skill);
    const input = { version: 1, baseVersion: 2 };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => catalog.restoreSkill(ownerId, skill.key, input)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .every((result) => result.reason.status === 409),
    ).toBe(true);
    await expect(catalog.restoreSkill(ownerId, skill.key, input)).rejects.toMatchObject({
      status: 409,
    });
    expect((await catalog.skillVersions(ownerId, skill.key, 1, 100)).total).toBe(3);
  });
  it('restores expert pins and source archives without enabling the expert or disabled dependencies', async () => {
    const skill = await skillFixture();
    const imported = await catalog.importPackage(
      ownerId,
      await writeArchive([
        ...exportExpert(
          { ...definition, skillKeys: [skill.key], skillVersions: { [skill.key]: 1 } },
          [skill],
          uniqueKey(),
          1,
        ),
        { path: 'README.md', content: 'Original attachment', encoding: 'utf8' },
      ]),
    );
    const expert = imported.expert!,
      key = imported.skills[0]!.key;
    const original = await readArchive(await catalog.exportExpert(ownerId, expert.id, true));
    const input = { ...definition, skillKeys: expert.skillKeys };
    await catalog.updateExpert(ownerId, expert.id, 1, {
      ...input,
      name: 'Changed expert',
      skillVersions: {},
    });
    const before = await catalog.expertVersions(ownerId, expert.id, 1, 100);
    await catalog.setExpertEnabled(ownerId, expert.id, false, 2);
    await catalog.setSkillEnabled(ownerId, key, false, 1);
    const restored = await catalog.restoreExpert(ownerId, expert.id, {
      version: 1,
      baseVersion: 2,
    });
    expect(restored).toMatchObject({
      name: definition.name,
      version: 3,
      enabled: false,
      skillVersions: { [key]: 1 },
      hasSourcePackage: true,
    });
    const after = await catalog.expertVersions(ownerId, expert.id, 1, 100);
    expect(after.items[0]).toMatchObject({ restoredFrom: 1 });
    expect(after.items.slice(1)).toEqual(before.items);
    expect(await readArchive(await catalog.exportExpert(ownerId, expert.id, true))).toEqual(
      original,
    );
    await catalog.setExpertEnabled(ownerId, expert.id, true, 3);
    const account = await catalog.createAccount(ownerId, profile);
    await expect(create(account, { expertId: expert.id })).rejects.toMatchObject({
      status: 422,
      response: { code: 'SKILL_UNAVAILABLE' },
    });
    await expect(
      catalog.restoreExpert(ownerId, expert.id, { version: 3, baseVersion: 3 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      catalog.restoreExpert(ownerId, expert.id, { version: 99, baseVersion: 3 }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('serializes expert restore against another edit and rejects stale replay', async () => {
    const expert = await catalog.createExpert(ownerId, definition);
    await catalog.updateExpert(ownerId, expert.id, 1, {
      ...definition,
      instructions: 'Second method',
    });
    const results = await Promise.allSettled([
      catalog.restoreExpert(ownerId, expert.id, { version: 1, baseVersion: 2 }),
      catalog.updateExpert(ownerId, expert.id, 2, {
        ...definition,
        instructions: 'Competing method',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    await expect(
      catalog.restoreExpert(ownerId, expert.id, { version: 1, baseVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.getRepository(ExpertVersionEntity).countBy({ expertId: expert.id })).toBe(3);
  });
  it('preserves old runs, continuation snapshots and personal content/review records', async () => {
    const skill = await skillFixture();
    const expert = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: [skill.key],
      skillVersions: { [skill.key]: 1 },
    });
    const account = await catalog.createAccount(ownerId, {
      ...profile,
      defaultExpertId: expert.id,
    });
    const run = await create(account);
    await new TaskRunner(db, new MockTextProvider()).execute(run.id);
    const contents = new ContentService(db);
    const content = await contents.promote(ownerId, run.id);
    await contents.mutate(
      ownerId,
      content.item.id,
      'review',
      { action: 'submit', baseRevision: 1, note: 'Review recorded' },
      randomUUID(),
    );
    const runBefore = await db.getRepository(RunEntity).findOneByOrFail({ id: run.id });
    const contentBefore = await contents.get(ownerId, content.item.id),
      reviewsBefore = await contents.reviews(ownerId, content.item.id, 1, 100);
    await changedSkill(skill);
    await catalog.updateExpert(ownerId, expert.id, 1, { ...definition, skillKeys: [skill.key] });
    await catalog.restoreExpert(ownerId, expert.id, { version: 1, baseVersion: 2 });
    await catalog.restoreSkill(ownerId, skill.key, { version: 1, baseVersion: 2 });
    await catalog.setAccountDefault(ownerId, account.id, { expertId: null, baseRevision: 1 });
    const child = await creation.continueDraft(
      ownerId,
      run.id,
      { instruction: 'Shorter opening' },
      randomUUID(),
    );
    expect(child.snapshot.account).toEqual(runBefore.snapshot.account);
    expect(child.snapshot.expert).toEqual(runBefore.snapshot.expert);
    expect(child.snapshot.skills).toEqual(runBefore.snapshot.skills);
    expect(await db.getRepository(RunEntity).findOneByOrFail({ id: run.id })).toEqual(runBefore);
    expect(await contents.get(ownerId, content.item.id)).toEqual(contentBefore);
    expect(await contents.reviews(ownerId, content.item.id, 1, 100)).toEqual(reviewsBefore);
  });
  it('exports historical pinned resources and rebases the installed package to new v1 skills', async () => {
    const skill = await skillFixture();
    await changedSkill(skill);
    const expert = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: [skill.key],
      skillVersions: { [skill.key]: 1 },
    });
    const archive = await catalog.exportExpert(ownerId, expert.id, false);
    const files = await readArchive(archive);
    expect(files.find((file) => file.path.endsWith('/references/source.md'))?.content).toBe(
      'ORIGINAL_RESOURCE',
    );
    expect(files.find((file) => file.path.endsWith('/SKILL.md'))?.content).toContain(
      'ORIGINAL_INSTRUCTIONS',
    );
    const installed = await catalog.importPackage(otherId, archive);
    const key = installed.skills[0]!.key;
    expect(installed.expert!.skillVersions).toEqual({ [key]: 1 });
    expect(installed.skills[0]).toMatchObject({ version: 1, files: skill.files });
    const account = await catalog.createAccount(otherId, {
      ...profile,
      defaultExpertId: installed.expert!.id,
    });
    expect(
      (
        await creation.create(
          otherId,
          { accountId: account.id, topic: 'Installed package', brief: '' },
          randomUUID(),
        )
      ).snapshot.skills[0],
    ).toMatchObject({ version: 1, instructions: 'ORIGINAL_INSTRUCTIONS' });
  });
  it('protects every new write with authentication, CSRF, strict schemas and ownership', async () => {
    const expert = await catalog.createExpert(ownerId, definition),
      skill = await skillFixture();
    const foreignExpert = await catalog.createExpert(otherId, definition);
    const foreignKey = uniqueKey();
    const foreignSkill = await catalog.createSkill(otherId, {
      key: foreignKey,
      document: document(foreignKey),
    });
    const account = await catalog.createAccount(ownerId, profile),
      foreignAccount = await catalog.createAccount(otherId, profile);
    const endpoints = [
      {
        path: `/accounts/${account.id}/default-expert`,
        body: { expertId: expert.id, baseRevision: 1 },
      },
      { path: `/experts/${expert.id}/restore`, body: { version: 1, baseVersion: 1 } },
      { path: `/skills/${skill.key}/restore`, body: { version: 1, baseVersion: 1 } },
    ];
    for (const { path, body } of endpoints) {
      expect(
        (
          await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(401);
      expect((await request(path, body, { 'X-CSRF-Token': '' })).status).toBe(403);
      expect((await request(path, body, { Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await request(path, { ...body, enabled: true })).status).toBe(400);
      expect((await request(path, { ...body, ownerId: otherId })).status).toBe(400);
    }
    expect(
      (
        await request(`/accounts/${foreignAccount.id}/default-expert`, {
          expertId: null,
          baseRevision: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/experts/${foreignExpert.id}/restore`, { version: 1, baseVersion: 1 }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/skills/${foreignSkill.key}/restore`, { version: 1, baseVersion: 1 })).status,
    ).toBe(404);
    expect(
      (
        await request(`/accounts/${account.id}/default-expert`, {
          expertId: expert.id,
          baseRevision: 1,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          '/creation-runs',
          { accountId: account.id, accountRevision: 2, topic: 'HTTP default' },
          { 'Idempotency-Key': randomUUID() },
        )
      ).status,
    ).toBe(202);
  });
});
