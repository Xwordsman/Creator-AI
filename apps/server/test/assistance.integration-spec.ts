import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  applyContentSuggestions,
  blockText,
  type ContentTurnInput,
  type ContentTurn,
  type ContentDetail,
  type ModelConnection,
  type SessionInfo,
} from '@creator-ai/contracts';
import { createDataSource } from '../src/database/data-source';
import { ExpertEntity, RunEntity, UserEntity } from '../src/database/entities';
import { createAdmin } from '../src/modules/auth/bootstrap';
import { bootstrapApi } from '../src/main-api';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { CreationService } from '../src/modules/creation/creation.service';
import { ContentService } from '../src/modules/content/content.service';
import { ContentAssistanceService } from '../src/modules/content/content-assistance.service';
import { ModelService } from '../src/modules/models/model.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';

type Body = { messages: { role: string; content: string }[] };
const send = (response: ServerResponse, content: string) =>
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: 'local-assistance-fixture',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 80 },
    }),
  );
describe('Article collaboration: real database + local HTTP fixture, no paid model', () => {
  let db: DataSource,
    app: INestApplication,
    server: Server,
    owner: string,
    other: string,
    base: string,
    headers: Record<string, string>,
    model: ModelConnection;
  let creation: CreationService, contents: ContentService, assistance: ContentAssistanceService;
  let accountId: string, expertId: string;
  let handler: (body: Body, res: ServerResponse) => void, calls: Body[], fixtureError: unknown;
  const env = { ...process.env },
    origin = 'http://127.0.0.1:5187';
  const manuscript = {
    title: 'Unsaved human title',
    document: {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph' as const,
          content: [
            { type: 'text' as const, text: 'Human-edited opening, not the generated draft.' },
          ],
        },
        {
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: 'Keep my real experience.' }],
        },
      ],
    },
  };
  const input = (extra: Partial<ContentTurnInput> = {}): ContentTurnInput => ({
    ...structuredClone(manuscript),
    baseRevision: 1,
    mode: 'revise',
    message: 'Please improve only the opening.',
    annotations: [],
    modelConnectionId: model.id,
    ...extra,
  });
  const http = (path: string, body?: unknown, key = randomUUID()) =>
    fetch(`${base}${path}`, {
      headers: { ...headers, 'Idempotency-Key': key },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const run = async (id: string) => {
    await new TaskRunner(db, new MockTextProvider()).execute(id);
    return creation.get(owner, id);
  };
  const article = async (): Promise<ContentDetail> => {
    const source = await creation.create(
      owner,
      { accountId, expertId, topic: 'Original generated topic', brief: '' },
      randomUUID(),
    );
    await run(source.id);
    return contents.promote(owner, source.id);
  };
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL,
      redis = process.env.TEST_REDIS_URL;
    if (
      !url ||
      !new URL(url).pathname.endsWith('_test') ||
      !redis ||
      new URL(redis).pathname !== '/15'
    )
      throw new Error('Dedicated test database and Redis DB15 required');
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
        calls.push(body);
        handler(body, res);
      })().catch((error: unknown) => {
        fixtureError = error;
        res.destroy();
      });
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
      MODEL_MODE: 'configured',
      MODEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      MODEL_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      MODEL_ALLOW_LOCAL: 'true',
    });
    db = await createDataSource(url).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE users CASCADE');
    const secret = randomUUID() + randomUUID();
    await createAdmin(db, 'assistant-test', secret);
    app = await bootstrapApi(0);
    base = `${await app.getUrl()}/api/v1`.replace('0.0.0.0', '127.0.0.1');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'assistant-test', ['pass' + 'word']: secret }),
    });
    expect(login.status).toBe(200);
    const info = ((await login.json()) as { data: SessionInfo }).data;
    owner = info.user.id;
    headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      Origin: origin,
      'X-CSRF-Token': info.csrfToken,
      'Content-Type': 'application/json',
    };
    other = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: other,
      username: 'other-assistant',
      passwordHash: 'not-used',
      createdAt: new Date(),
    });
    const catalog = new CatalogService(db);
    accountId = (
      await catalog.createAccount(owner, {
        name: 'Family writing',
        platform: 'wechat',
        audience: 'Readers',
        persona: 'Be natural, not theatrical.',
      })
    ).id;
    expertId = (
      await catalog.createExpert(owner, {
        name: 'Editor',
        description: 'Editor',
        instructions: 'Original method',
        skillKeys: [],
      })
    ).id;
    model = await new ModelService(db).create(owner, {
      name: 'Local test only',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'fixture',
      apiKey: 'fixture-not-a-real-key',
      tokenParameter: 'max_completion_tokens',
      maxInputTokens: 64000,
      maxOutputTokens: 1024,
    });
    creation = new CreationService(db);
    contents = new ContentService(db);
    assistance = new ContentAssistanceService(db);
  });
  beforeEach(() => {
    calls = [];
    fixtureError = undefined;
    handler = (body, res) => {
      const context = JSON.parse(body.messages.find((m) => m.role === 'user')!.content);
      send(
        res,
        JSON.stringify({
          reply: 'Here is a concrete alternative. Please verify.',
          suggestions:
            context.mode === 'discuss'
              ? []
              : [
                  {
                    id: 'opening',
                    blockIndex: 0,
                    before: context.currentManuscript.blocks[0].text,
                    after: 'A concrete opening, awaiting your approval.',
                    reason: 'More direct',
                    annotationIds: [],
                  },
                ],
        }),
      );
    };
  });
  afterEach(() => expect(fixtureError).toBeUndefined());
  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db?.isInitialized) await db.destroy();
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'APP_ORIGIN',
      'NODE_ENV',
      'MODEL_MODE',
      'MODEL_ENCRYPTION_KEY',
      'MODEL_ALLOWED_HOSTS',
      'MODEL_ALLOW_LOCAL',
    ]) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
  });

  it('uses the unsaved manuscript, batches change/keep anchors and never writes a content version', async () => {
    const original = await article(),
      id = original.item.id;
    const request = input({
      annotations: [
        {
          id: randomUUID(),
          blockIndex: 0,
          blockText: blockText(manuscript.document.content[0]!),
          quote: 'opening',
          kind: 'change',
          note: 'More specific',
        },
        {
          id: randomUUID(),
          blockIndex: 1,
          blockText: blockText(manuscript.document.content[1]!),
          quote: '',
          kind: 'keep',
          note: '',
        },
      ],
    });
    const response = await http(`/contents/${id}/assistant-turns`, request);
    expect(response.status).toBe(202);
    const turn = ((await response.json()) as { data: ContentTurn }).data;
    expect((await run(turn.id)).status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.messages[1]!.content);
    expect(sent.currentManuscript).toMatchObject({
      title: manuscript.title,
      blocks: [
        { text: blockText(manuscript.document.content[0]!) },
        { text: blockText(manuscript.document.content[1]!) },
      ],
    });
    expect(sent.annotations).toHaveLength(2);
    expect(await contents.get(owner, id)).toEqual(original);
    const detail = await assistance.get(owner, id, turn.id);
    const changed = applyContentSuggestions(manuscript, detail, ['opening']);
    expect(blockText(changed.document.content[1]!)).toBe('Keep my real experience.');
    await contents.mutate(
      owner,
      id,
      'save',
      { ...changed, baseRevision: 1, note: 'Accepted after reading' },
      randomUUID(),
    );
    expect((await contents.get(owner, id)).item.currentVersion).toBe(2);
    expect((await http(`/contents/${id}/assistant-turns/${turn.id}`)).status).toBe(200);
  });
  it('preserves legacy references, explicitly selects current cards, fences stale selection and replays the frozen receipt', async () => {
    const catalog = new CatalogService(db);
    const original = await article();
    // Model an immutable source created before account revisions existed.
    await db.query(
      "UPDATE creation_runs SET snapshot=snapshot #- '{account,revision}' #- '{account,defaultExpertId}' WHERE id=$1",
      [original.item.sourceRunId],
    );
    const oldSnapshot = (await creation.get(owner, original.item.sourceRunId)).snapshot;
    const account = await catalog.getAccount(owner, accountId);
    const card = {
      id: randomUUID(),
      title: 'Family writing',
      kind: 'writing' as const,
      content: 'Use concrete descriptions; do not invent experiences.',
      enabled: true,
    };
    const disabled = {
      ...card,
      id: randomUUID(),
      enabled: false,
      content: 'DISABLED_MUST_NOT_BE_SENT',
    };
    const updated = await catalog.saveWritingCards(owner, accountId, {
      baseRevision: account.revision,
      writingCards: [card, disabled],
    });
    const endpoint = `/contents/${original.item.id}/assistant-turns`;
    const profiles = await http(`${endpoint}/writing-profile`);
    expect(profiles.status).toBe(200);
    const data = (await profiles.json()).data;
    expect(data.original).toEqual(oldSnapshot.account);
    expect(data.original).not.toHaveProperty('revision');
    expect(data.current.writingCards).toEqual([card, disabled]);
    await expect(assistance.writingProfiles(other, original.item.id)).rejects.toMatchObject({
      status: 404,
    });
    const frozen = await assistance.create(
      owner,
      original.item.id,
      input({ mode: 'discuss' }),
      randomUUID(),
    );
    await run(frozen.id);
    expect((await assistance.get(owner, original.item.id, frozen.id)).writingProfile).toEqual({
      source: 'original',
      accountRevision: null,
      cards: [],
    });
    expect(JSON.parse(calls[0]!.messages.find((m) => m.role === 'user')!.content).account).toEqual(
      oldSnapshot.account,
    );
    const key = randomUUID(),
      request = input({ mode: 'discuss', accountProfileRevision: updated.revision });
    const turn = await assistance.create(owner, original.item.id, request, key);
    await run(turn.id);
    const currentContext = JSON.parse(calls[1]!.messages.find((m) => m.role === 'user')!.content);
    expect(currentContext.account.writingCards).toEqual([card]);
    expect(calls[1]!.messages[0]!.content).toContain('sample 只参考');
    expect((await assistance.get(owner, original.item.id, turn.id)).writingProfile).toEqual({
      source: 'current',
      accountRevision: updated.revision,
      cards: [{ id: card.id, kind: card.kind, title: card.title }],
    });
    expect(
      (await assistance.list(owner, original.item.id, 1, 10)).items.find((t) => t.id === turn.id)
        ?.writingProfile?.cards,
    ).toHaveLength(1);
    await catalog.saveWritingCards(owner, accountId, {
      baseRevision: updated.revision,
      writingCards: [],
    });
    expect((await assistance.create(owner, original.item.id, request, key)).id).toBe(turn.id);
    await expect(
      assistance.create(owner, original.item.id, request, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_REVISION_CONFLICT' } });
    expect(calls).toHaveLength(2);
    expect((await creation.get(owner, original.item.sourceRunId)).snapshot).toEqual(oldSnapshot);
    expect(await contents.get(owner, original.item.id)).toEqual(original);
  });
  it('serializes duplicate requests and independent concurrent turns; receipt survives later saves', async () => {
    const { item } = await article(),
      key = randomUUID(),
      request = input();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => assistance.create(owner, item.id, request, key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(
      (await db.query('SELECT * FROM task_outbox WHERE run_id=$1', [results[0]!.id])).length,
    ).toBe(1);
    await expect(
      assistance.create(owner, item.id, { ...request, message: 'Different' }, key),
    ).rejects.toMatchObject({ status: 409 });
    await expect(assistance.create(owner, item.id, request, randomUUID())).rejects.toMatchObject({
      response: { code: 'ASSISTANCE_IN_PROGRESS' },
    });
    await run(results[0]!.id);
    await run(results[0]!.id);
    expect(calls).toHaveLength(1);
    await contents.mutate(
      owner,
      item.id,
      'save',
      { ...manuscript, baseRevision: 1, note: '' },
      randomUUID(),
    );
    expect((await assistance.create(owner, item.id, request, key)).id).toBe(results[0]!.id);
    await expect(assistance.create(owner, item.id, request, randomUUID())).rejects.toMatchObject({
      response: { code: 'CONTENT_CONFLICT' },
    });
    const second = await article();
    const racing = await Promise.allSettled(
      [1, 2].map(() => assistance.create(owner, second.item.id, input(), randomUUID())),
    );
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of racing) if (r.status === 'fulfilled') await creation.cancel(owner, r.value.id);
  });
  it('requires authentication, CSRF, ownership, strict schema and valid anchors', async () => {
    const { item } = await article(),
      path = `/contents/${item.id}/assistant-turns`;
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { ...headers, 'X-CSRF-Token': '' },
          body: JSON.stringify(input()),
        })
      ).status,
    ).toBe(403);
    expect((await http(path, { ...input(), history: [] })).status).toBe(400);
    await expect(assistance.list(other, item.id, 1, 10)).rejects.toMatchObject({ status: 404 });
    await expect(assistance.create(other, item.id, input(), randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      assistance.create(
        owner,
        item.id,
        input({
          annotations: [
            {
              id: randomUUID(),
              blockIndex: 0,
              blockText: 'stale',
              quote: '',
              kind: 'change',
              note: 'fix',
            },
          ],
        }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ANNOTATION_STALE' } });
    const turn = await assistance.create(owner, item.id, input(), randomUUID());
    await expect(assistance.get(other, item.id, turn.id)).rejects.toMatchObject({ status: 404 });
    await expect(assistance.get(owner, randomUUID(), turn.id)).rejects.toMatchObject({
      status: 404,
    });
    await creation.cancel(owner, turn.id);
  });
  it('discusses without patches and bounds history without embedding recursive drafts', async () => {
    const { item } = await article();
    for (let i = 0; i < 8; i++) {
      const turn = await assistance.create(
        owner,
        item.id,
        input({ mode: 'discuss', message: `Question number ${i}` }),
        randomUUID(),
      );
      const done = await run(turn.id);
      expect(done.output!.assistance!.suggestions).toEqual([]);
      if (i === 7) {
        expect(done.snapshot.assistance!.history).toHaveLength(12);
        expect(done.snapshot.assistance!.historyTruncated).toBe(true);
        expect(JSON.stringify(done.snapshot.assistance!.history)).not.toContain('document');
      }
    }
    const listing = await assistance.list(owner, item.id, 1, 3);
    expect(listing.total).toBe(8);
    expect(listing.items).toHaveLength(3);
    expect(listing.items[0]).not.toHaveProperty('manuscript');
  });
  it.each(['not json', 'protected', 'scope', 'discuss'])(
    'rejects %s output without automatic paid correction',
    async (kind) => {
      const { item } = await article();
      const annotations: ContentTurnInput['annotations'] =
        kind === 'protected'
          ? [
              {
                id: randomUUID(),
                kind: 'keep',
                blockIndex: 0,
                blockText: blockText(manuscript.document.content[0]!),
                quote: '',
                note: '',
              },
            ]
          : kind === 'scope'
            ? [
                {
                  id: randomUUID(),
                  kind: 'change',
                  blockIndex: 1,
                  blockText: blockText(manuscript.document.content[1]!),
                  quote: '',
                  note: 'Change only this',
                },
              ]
            : [];
      handler = (_body, response) =>
        send(
          response,
          kind === 'not json'
            ? '<html>invalid</html>'
            : JSON.stringify({
                reply: 'wrong',
                suggestions: [
                  {
                    id: 's',
                    blockIndex: 0,
                    before: blockText(manuscript.document.content[0]!),
                    after: 'Wrong',
                    reason: 'x',
                    annotationIds: [],
                  },
                ],
              }),
        );
      const t = await assistance.create(
        owner,
        item.id,
        input({ annotations, mode: kind === 'discuss' ? 'discuss' : 'revise' }),
        randomUUID(),
      );
      expect(await run(t.id)).toMatchObject({
        status: 'failed',
        failureCode: 'ASSISTANCE_INVALID_OUTPUT',
        output: null,
      });
      await run(t.id);
      expect(calls).toHaveLength(1);
      expect((await contents.get(owner, item.id)).item.currentVersion).toBe(1);
    },
  );
  it('retains unknown call evidence and blocks a new round until human reconciliation', async () => {
    const { item } = await article();
    handler = (_body, response) => response.destroy();
    const t = await assistance.create(owner, item.id, input(), randomUUID());
    expect((await run(t.id)).status).toBe('needs_review');
    await run(t.id);
    expect(calls).toHaveLength(1);
    await expect(assistance.create(owner, item.id, input(), randomUUID())).rejects.toMatchObject({
      response: { code: 'ASSISTANCE_IN_PROGRESS' },
    });
    await creation.reconcile(owner, t.id, 'Checked fixture disconnect; no paid provider involved.');
    expect((await assistance.create(owner, item.id, input(), randomUUID())).status).toBe('queued');
  });
  it('makes mock honesty explicit, preserves provenance and forbids promotion/continuation', async () => {
    const { item } = await article();
    const t = await assistance.create(
      owner,
      item.id,
      input({ modelConnectionId: undefined }),
      randomUUID(),
    );
    await run(t.id);
    const done = await assistance.get(owner, item.id, t.id);
    expect(done).toMatchObject({ isMock: true, result: { suggestions: [] } });
    expect(done.result!.reply).toContain('未调用 AI');
    expect(calls).toHaveLength(0);
    await expect(contents.promote(owner, t.id)).rejects.toMatchObject({
      response: { code: 'ASSISTANCE_NOT_ARTICLE' },
    });
    await expect(
      creation.continueDraft(owner, t.id, { instruction: 'Continue' }, randomUUID()),
    ).rejects.toMatchObject({ response: { code: 'ASSISTANCE_NOT_ARTICLE' } });
    expect((await contents.get(owner, item.id)).item.isMock).toBe(true);
  });
  it('freezes source methods, selects only the team lead and uses an independent chosen model', async () => {
    const original = await article();
    const source = await db
      .getRepository(RunEntity)
      .findOneByOrFail({ id: original.item.sourceRunId });
    // Synthetic historical team candidate; no claim of testing editorial quality or full team execution.
    source.snapshot.expert.expertType = 'team';
    source.snapshot.expert.team = {
      leadAgent: 'lead',
      members: [
        {
          agentId: 'lead',
          name: 'Lead',
          description: 'Lead',
          instructions: 'Lead method',
          skillKeys: [],
          maxTurns: 12,
        },
        {
          agentId: 'member',
          name: 'Member',
          description: 'Member',
          instructions: 'Other',
          skillKeys: [],
        },
      ],
    };
    await db.getRepository(RunEntity).save(source);
    const expert = await db.getRepository(ExpertEntity).findOneByOrFail({ id: expertId });
    expert.definition.instructions = 'Later edits must not silently replace old methods';
    await db.getRepository(ExpertEntity).save(expert);
    const t = await assistance.create(owner, original.item.id, input(), randomUUID());
    const done = await run(t.id);
    expect(done.snapshot.expert.team).toBeUndefined();
    expect(done.snapshot.expert.instructions).toContain('Original method');
    expect(done.snapshot.expert.instructions).toContain('Lead method');
    expect(done.execution!.agents).toHaveLength(1);
    expect(done.snapshot.model!.id).toBe(model.id);
    expect(done.snapshot.limits).toEqual({
      maxCalls: 4,
      maxTotalTokens: 64000,
      maxDurationSeconds: 180,
    });
  });
});
