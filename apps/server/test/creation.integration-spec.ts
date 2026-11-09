import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import type {
  Account,
  CreationRun,
  Expert,
  ExpertInput,
  Skill,
  SessionInfo,
} from '@creator-ai/contracts';
import { createDataSource } from '../src/database/data-source';
import { createAdmin } from '../src/modules/auth/bootstrap';
import { CreationService } from '../src/modules/creation/creation.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';
import { OutboxDispatcher } from '../src/modules/tasks/outbox-dispatcher';
import { bootstrapApi } from '../src/main-api';
import { RunEntity, UserEntity } from '../src/database/entities';
import { exportExpert, inspectPackage, parseSkill } from '../src/modules/catalog/package-codec';
import { readArchive, writeArchive } from '../src/modules/catalog/package-archive';

describe('PostgreSQL + Redis + HTTP vertical slice', () => {
  let db: DataSource;
  let redis: Redis;
  let queue: Queue;
  let worker: Worker;
  let app: INestApplication;
  let base: string;
  let headers: Record<string, string>;
  let ownerId: string;
  let account: Account;
  let expert: Expert;
  let creation: CreationService;
  let catalog: CatalogService;
  const origin = 'http://localhost:5173';
  const testSecret = randomUUID() + randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const redisUrl = process.env.TEST_REDIS_URL;
    if (
      !databaseUrl ||
      !new URL(databaseUrl).pathname.endsWith('_test') ||
      !redisUrl ||
      new URL(redisUrl).pathname !== '/15'
    ) {
      throw new Error(
        'Integration tests require a dedicated *_test database and TEST_REDIS_URL ending in /15. Never use production services.',
      );
    }
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      APP_ORIGIN: origin,
      MODEL_MODE: 'mock',
      NODE_ENV: 'test',
    });
    db = await createDataSource(databaseUrl).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE users CASCADE');
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const username = `test-${randomUUID().slice(0, 8)}`;
    await createAdmin(db, username, testSecret);
    await expect(createAdmin(db, 'second', 'another-secret-123')).rejects.toThrow('already exists');
    app = await bootstrapApi(0);
    base = `${await app.getUrl()}/api/v1`.replace('0.0.0.0', '127.0.0.1');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: testSecret }),
    });
    expect(login.status).toBe(200);
    const info = ((await login.json()) as { data: SessionInfo }).data;
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');
    ownerId = info.user.id;
    headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      Origin: origin,
      'X-CSRF-Token': info.csrfToken,
      'Content-Type': 'application/json',
    };
    catalog = new CatalogService(db);
    creation = new CreationService(db);
    account = await catalog.createAccount(ownerId, {
      name: 'Test account',
      platform: 'wechat',
      audience: 'Readers',
      persona: 'Be precise',
    });
    expert = await catalog.createExpert(ownerId, {
      name: 'Test expert',
      description: 'Test editor',
      instructions: 'Use clear language',
      skillKeys: ['plain-writing'],
    });
    queue = new Queue(`creator-integration-${randomUUID()}`, { connection: redis });
  });

  afterAll(async () => {
    await worker?.close();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await app?.close();
    redis?.disconnect();
    if (db?.isInitialized) await db.destroy();
  });

  it('requires authentication, Origin and CSRF, including SSE', async () => {
    expect((await fetch(`${base}/accounts`)).status).toBe(401);
    expect((await fetch(`${base}/creation-runs/${randomUUID()}/events`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/accounts`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://attacker.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/accounts`, {
          method: 'POST',
          headers: { ...headers, 'X-CSRF-Token': '' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/accounts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...account, ownerId: 'other' }),
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${base}/accounts`, { method: 'POST', headers, body: '{' })).status).toBe(
      400,
    );
    expect(
      (
        await fetch(`${base}/creation-runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'a'.repeat(70000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(`${base}/accounts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'a'.repeat(2 * 1024 * 1024) }),
        })
      ).status,
    ).toBe(413);
    const session = await fetch(`${base}/auth/session`, { headers });
    expect(JSON.stringify(await session.json())).not.toContain('passwordHash');
  });

  it('atomically creates an outbox and deduplicates concurrent submissions', async () => {
    const input = { accountId: account.id, expertId: expert.id, topic: 'Same topic', brief: '' };
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => creation.create(ownerId, input, key)),
    );
    expect(new Set(results.map((run) => run.id)).size).toBe(1);
    const row = results[0]!;
    const outbox = await db.query('SELECT run_id FROM task_outbox WHERE run_id = $1', [row.id]);
    expect(outbox).toHaveLength(1);
    await expect(
      creation.create(ownerId, { ...input, topic: 'Different topic' }, key),
    ).rejects.toMatchObject({ status: 409 });
    const http = await fetch(`${base}/creation-runs`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
    expect(http.status).toBe(202);
    expect(((await http.json()) as { data: CreationRun }).data.id).toBe(row.id);
  });

  it('creates continuation through authenticated HTTP, validates inputs and preserves mock provenance', async () => {
    const parent = await creation.create(
      ownerId,
      { accountId: account.id, expertId: expert.id, topic: 'Revision HTTP', brief: '' },
      randomUUID(),
    );
    await new TaskRunner(db, new MockTextProvider()).execute(parent.id);
    const endpoint = `${base}/creation-runs/${parent.id}/continue`;
    const key = randomUUID();
    const body = JSON.stringify({ instruction: 'Please shorten the introduction' });
    expect(
      (await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body }))
        .status,
    ).toBe(403);
    expect((await fetch(endpoint, { method: 'POST', headers, body })).status).toBe(400);
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': key },
          body: JSON.stringify({ instruction: 'Revise', previousOutput: {} }),
        })
      ).status,
    ).toBe(400);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body,
    });
    expect(response.status).toBe(202);
    const child = ((await response.json()) as { data: CreationRun }).data;
    expect(child.snapshot.provider).toBe('mock');
    await new TaskRunner(db, new MockTextProvider()).execute(child.id);
    const done = await creation.get(ownerId, child.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      output: { isMock: true, reviewStatus: 'pending_review' },
    });
    expect(JSON.stringify(done.output)).toContain('此模板未理解或改写原稿');
    expect(JSON.stringify(done.output)).toContain('Please shorten the introduction');
    const history = await fetch(`${base}/creation-runs/${child.id}/history?page=1&pageSize=1`, {
      headers,
    });
    expect(history.status).toBe(200);
    expect(
      ((await history.json()) as { data: { total: number; items: unknown[] } }).data,
    ).toMatchObject({ total: 2, items: [expect.any(Object)] });
    const again = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body,
    });
    expect(((await again.json()) as { data: CreationRun }).data.id).toBe(child.id);
  });

  it('preserves expert snapshots and enforces ownership', async () => {
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: expert.id, topic: 'Versioned topic', brief: '' },
      randomUUID(),
    );
    const updated = await catalog.updateExpert(ownerId, expert.id, 1, {
      name: expert.name,
      description: expert.description,
      instructions: 'New version',
      skillKeys: expert.skillKeys,
    });
    expect(updated.version).toBe(2);
    expect((await creation.get(ownerId, run.id)).snapshot.expert.instructions).toBe(
      'Use clear language',
    );
    await expect(catalog.updateExpert(ownerId, expert.id, 1, updated)).rejects.toMatchObject({
      status: 409,
    });
    const otherId = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: otherId,
      username: `other-${randomUUID()}`,
      passwordHash: 'not-used',
      createdAt: new Date(),
    });
    await expect(creation.get(otherId, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      creation.create(
        otherId,
        { accountId: account.id, expertId: expert.id, topic: 'Unauthorized', brief: '' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('dispatches durable runs through BullMQ and returns an authenticated SSE snapshot', async () => {
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: expert.id, topic: 'End to end', brief: '' },
      randomUUID(),
    );
    const runner = new TaskRunner(db, new MockTextProvider());
    worker = new Worker(
      queue.name,
      (job: { data: { runId: string } }) => runner.execute(job.data.runId),
      { connection: redis },
    );
    await worker.waitUntilReady();
    await new OutboxDispatcher(db, queue).dispatch();
    const deadline = Date.now() + 10000;
    while ((await creation.get(ownerId, run.id)).status !== 'succeeded' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await creation.get(ownerId, run.id);
    expect(result.output).toMatchObject({ isMock: true, reviewStatus: 'pending_review' });
    expect(result.attempts).toBe(1);
    await runner.execute(run.id);
    expect((await creation.get(ownerId, run.id)).attempts).toBe(1);
    const abort = new AbortController();
    const events = await fetch(`${base}/creation-runs/${run.id}/events`, {
      headers,
      signal: abort.signal,
    });
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('run.snapshot')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    abort.abort();
    expect(text).toContain('run.snapshot');
  });

  it('recovers an expired mock lease and fences a late old worker', async () => {
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: expert.id, topic: 'Lease test', brief: '' },
      randomUUID(),
    );
    const provider = new MockTextProvider();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new TaskRunner(db, {
      generate: async (snapshot) => {
        entered();
        await gate;
        return { ...(await provider.generate(snapshot)), title: 'late result' };
      },
    });
    const first = slow.execute(run.id);
    await started;
    await db
      .getRepository(RunEntity)
      .update(run.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    await new TaskRunner(db, provider).execute(run.id);
    release();
    await first;
    expect((await creation.get(ownerId, run.id)).output?.title).toBe('Lease test');
    expect((await creation.get(ownerId, run.id)).attempts).toBe(2);
  });

  it('versions custom skills and snapshots their resources without claiming they executed', async () => {
    const key = `custom-${randomUUID().slice(0, 8)}`;
    const document = `---\nname: ${key}\ndescription: Original test skill\n---\nFirst instructions`;
    const response = await fetch(`${base}/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, document }),
    });
    expect(response.status).toBe(201);
    const skill = ((await response.json()) as { data: Skill }).data;
    expect(skill).toMatchObject({ key, version: 1, source: 'custom', allowedTools: [] });
    const selected = await catalog.createExpert(ownerId, {
      name: 'Skill snapshot',
      description: 'Original fixture',
      instructions: 'Use configured skills',
      skillKeys: [key],
      preloadSkillKeys: [key],
    });
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: selected.id, topic: 'Snapshot', brief: '' },
      randomUUID(),
    );
    expect(run.snapshot.skillSelection).toEqual({ available: [key], preloaded: [key], loaded: [] });
    const update = { key, document: document.replace('First instructions', 'Second instructions') };
    const changed = await fetch(`${base}/skills/${key}/versions?baseVersion=1`, {
      method: 'POST',
      headers,
      body: JSON.stringify(update),
    });
    expect(changed.status).toBe(201);
    expect(
      (await catalog.skillVersions(ownerId, key, 1, 100)).items.map((item) => item.version),
    ).toEqual([2, 1]);
    expect((await creation.get(ownerId, run.id)).snapshot.skills[0]?.instructions).toBe(
      'First instructions',
    );
    expect(
      (
        await fetch(`${base}/skills/${key}/versions?baseVersion=1`, {
          method: 'POST',
          headers,
          body: JSON.stringify(update),
        })
      ).status,
    ).toBe(409);
    await catalog.setSkillEnabled(ownerId, key, false, 2);
    await expect(
      creation.create(
        ownerId,
        { accountId: account.id, expertId: selected.id, topic: 'Disabled', brief: '' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect((await creation.get(ownerId, run.id)).snapshot.skills[0]?.enabled).toBe(true);
    await expect(
      catalog.createSkill(ownerId, {
        key: 'plain-writing',
        document: '---\nname: plain-writing\ndescription: Test\n---\nTest',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('supports skill-free experts and large team definitions but rejects team execution', async () => {
    const definition: ExpertInput = {
      name: 'Independent',
      description: 'No skill dependency',
      instructions: 'Independent instructions',
      skillKeys: [],
    };
    const noSkills = await catalog.createExpert(ownerId, definition);
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: noSkills.id, topic: 'No skills', brief: '' },
      randomUUID(),
    );
    expect(run.snapshot.skills).toEqual([]);
    await catalog.setExpertEnabled(ownerId, noSkills.id, false, 1);
    await expect(
      creation.create(
        ownerId,
        { accountId: account.id, expertId: noSkills.id, topic: 'Disabled', brief: '' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const team: ExpertInput = {
      ...definition,
      expertType: 'team',
      team: {
        leadAgent: 'lead',
        members: [
          { ...definition, agentId: 'lead', instructions: '编排'.repeat(9000) },
          { ...definition, agentId: 'writer', instructions: '写作'.repeat(9000) },
        ],
        phases: [{ name: 'Draft', agents: ['writer'], task: 'Write independently' }],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(team))).toBeGreaterThan(64 * 1024);
    const saved = await fetch(`${base}/experts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(team),
    });
    expect(saved.status).toBe(201);
    const stored = ((await saved.json()) as { data: Expert }).data;
    expect(stored.team?.members).toHaveLength(2);
    const count = await db.getRepository(RunEntity).count();
    const rejected = await fetch(`${base}/creation-runs`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        accountId: account.id,
        expertId: stored.id,
        topic: 'Team',
        brief: '',
      }),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: { code: 'TEAM_RUNTIME_UNAVAILABLE' } });
    expect(await db.getRepository(RunEntity).count()).toBe(count);
    expect((await catalog.expertVersions(ownerId, stored.id, 1, 100)).items[0]?.team).toEqual(
      team.team,
    );
  });

  it('previews, imports and exports packages transactionally without overwriting collisions', async () => {
    const definition: ExpertInput = {
      name: 'Original import',
      description: 'Test package',
      instructions: 'Use attached references',
      skillKeys: ['alpha', 'zeta'],
    };
    const makeSkill = (key: string) =>
      parseSkill(
        key,
        `---\nname: ${key}\ndescription: Original test skill\n---\nUse the reference`,
        [{ path: 'references/example.md', content: 'Original reference', encoding: 'utf8' }],
      );
    const files = exportExpert(definition, ['alpha', 'zeta'].map(makeSkill), 'import-fixture', 1);
    files.push({ path: 'assets/sample.bin', content: 'AP8B', encoding: 'base64' });
    const buffer = await writeArchive(files);
    const upload = (path: string, data: Buffer = buffer) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/zip' },
        body: new Uint8Array(data),
      });
    const before = await catalog.listExperts(ownerId, 1, 100);
    const preview = await upload('/packages/preview');
    expect(preview.status).toBe(201);
    expect(await preview.json()).toMatchObject({ data: { runtimeReady: false, kind: 'expert' } });
    expect((await catalog.listExperts(ownerId, 1, 100)).total).toBe(before.total);
    const imported = await upload('/packages/import');
    expect(imported.status).toBe(201);
    const installed = ((await imported.json()) as { data: { expert: Expert; skills: Skill[] } })
      .data;
    expect(installed.expert.hasSourcePackage).toBe(true);
    expect(installed.skills[0]?.files?.[0]?.content).toBe('Original reference');
    const source = await fetch(`${base}/experts/${installed.expert.id}/export?original=true`, {
      headers,
    });
    expect(source.headers.get('content-type')).toContain('application/zip');
    expect(await readArchive(Buffer.from(await source.arrayBuffer()))).toEqual(files);
    const current = await catalog.exportExpert(ownerId, installed.expert.id, false);
    expect(inspectPackage(await readArchive(current)).expert?.name).toBe(definition.name);
    const conflict = exportExpert(
      { ...definition, skillKeys: ['aaa-new', 'zeta'] },
      ['aaa-new', 'zeta'].map(makeSkill),
      'import-fixture',
      2,
    );
    expect((await upload('/packages/import', await writeArchive(conflict))).status).toBe(409);
    const all = await catalog.listSkills(ownerId, 1, 100);
    expect(all.items.some((s) => s.key === 'import-fixture:aaa-new')).toBe(false);
    expect((await catalog.listExperts(ownerId, 1, 100)).total).toBe(before.total + 1);
    expect(
      (await fetch(`${base}/packages/import`, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/packages/import`, {
          method: 'POST',
          headers: { ...headers, 'X-CSRF-Token': '', 'Content-Type': 'application/zip' },
          body: new Uint8Array(buffer),
        })
      ).status,
    ).toBe(403);
  });

  it('isolates capability owners and serializes concurrent installs of the same skill', async () => {
    const otherId = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: otherId,
      username: `catalog-${randomUUID()}`,
      passwordHash: 'not-used',
      createdAt: new Date(),
    });
    const input = {
      key: 'concurrent-skill',
      document: '---\nname: concurrent-skill\ndescription: Test\n---\nIndependent instructions',
    };
    const results = await Promise.allSettled([
      catalog.createSkill(ownerId, input),
      catalog.createSkill(ownerId, input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await catalog.listSkills(otherId, 1, 100)).items.some((s) => s.key === input.key)).toBe(
      false,
    );
    await expect(catalog.exportSkill(otherId, input.key)).rejects.toMatchObject({ status: 404 });
    await expect(catalog.skillVersions(otherId, input.key, 1, 100)).rejects.toMatchObject({
      status: 404,
    });
    await expect(catalog.expertVersions(otherId, expert.id, 1, 100)).rejects.toMatchObject({
      status: 404,
    });
    await expect(catalog.exportExpert(otherId, expert.id, false)).rejects.toMatchObject({
      status: 404,
    });
    expect(await catalog.createSkill(otherId, input)).toMatchObject({ version: 1 });
  });

  it('authenticates durable collaboration responses, validates intent and queues exactly once', async () => {
    const run = await creation.create(
      ownerId,
      {
        accountId: account.id,
        expertId: expert.id,
        topic: 'HTTP collaboration fixture',
        brief: '',
      },
      randomUUID(),
    );
    await db.query(
      "UPDATE creation_runs SET status='waiting_user',snapshot=$2::jsonb WHERE id=$1",
      [
        run.id,
        JSON.stringify({ ...run.snapshot, provider: 'compatible', workflow: 'team-dynamic-v1' }),
      ],
    );
    const source = randomUUID(),
      action = randomUUID();
    await db.query(
      `INSERT INTO agent_runs(id,run_id,agent_id,name,role,phase,task,definition,status,result)
      VALUES($1,$2,'lead','Lead','planner',0,'HTTP fixture',$3::jsonb,'succeeded','{}')`,
      [source, run.id, JSON.stringify({ ...run.snapshot.expert, agentId: 'lead' })],
    );
    await db.query(
      `INSERT INTO team_actions(id,run_id,source_agent_run_id,directive,state)
      VALUES($1,$2,$3,$4::jsonb,'waiting')`,
      [
        action,
        run.id,
        source,
        JSON.stringify({ action: 'confirm', question: 'Approve this editorial direction?' }),
      ],
    );
    await db.query('UPDATE task_outbox SET last_dispatched_at=now() WHERE run_id=$1', [run.id]);
    const endpoint = `${base}/creation-runs/${run.id}/actions/${action}/respond`;
    const post = (input: unknown, selectedHeaders = headers) =>
      fetch(endpoint, { method: 'POST', headers: selectedHeaders, body: JSON.stringify(input) });
    expect(
      (
        await post(
          { answer: 'Agreed', approved: true },
          { 'Content-Type': 'application/json', Origin: origin },
        )
      ).status,
    ).toBe(401);
    expect(
      (await post({ answer: 'Agreed', approved: true }, { ...headers, 'X-CSRF-Token': '' })).status,
    ).toBe(403);
    expect((await post({ answer: 'Agreed', approved: true, ownerId: randomUUID() })).status).toBe(
      400,
    );
    expect((await post({ answer: 'Agreed' })).status).toBe(422);
    await expect(
      creation.respond(randomUUID(), run.id, action, { answer: 'Agreed', approved: true }),
    ).rejects.toMatchObject({ status: 404 });
    const pending = await fetch(`${base}/creation-runs/${run.id}`, { headers });
    expect(await pending.json()).toMatchObject({
      data: {
        status: 'waiting_user',
        execution: { collaboration: [{ id: action, response: null }] },
      },
    });
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => post({ answer: 'Agreed', approved: true })),
    );
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await creation.get(ownerId, run.id)).status).toBe('queued');
    expect(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM team_messages WHERE run_id=$1 AND kind='answer'",
          [run.id],
        )
      )[0].count,
    ).toBe(1);
    expect(
      (await db.query('SELECT last_dispatched_at FROM task_outbox WHERE run_id=$1', [run.id]))[0]
        .last_dispatched_at,
    ).toBeNull();
    expect((await post({ answer: 'Changed my mind', approved: false })).status).toBe(409);
    await creation.cancel(ownerId, run.id);
    expect((await post({ answer: 'Agreed', approved: true })).status).toBe(200);
    expect((await creation.get(ownerId, run.id)).status).toBe('cancelled');
  });

  it('revokes a session at logout', async () => {
    expect(
      (await fetch(`${base}/auth/logout`, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(200);
    expect((await fetch(`${base}/auth/session`, { headers })).status).toBe(401);
  });

  it('does not persist malformed provider output as successful content', async () => {
    const run = await creation.create(
      ownerId,
      { accountId: account.id, expertId: expert.id, topic: 'Invalid output', brief: '' },
      randomUUID(),
    );
    await new TaskRunner(db, { generate: async () => ({ html: '<script>bad</script>' }) }).execute(
      run.id,
    );
    expect(await creation.get(ownerId, run.id)).toMatchObject({ status: 'failed', output: null });
  });
});
