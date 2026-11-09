import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import type {
  Account,
  Expert,
  ExpertInput,
  ModelConnection,
  RunLimits,
} from '@creator-ai/contracts';
import { createDataSource } from '../src/database/data-source';
import {
  ExpertEntity,
  RunEntity,
  SkillEntity,
  SkillVersionEntity,
  UserEntity,
} from '../src/database/entities';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { CreationService } from '../src/modules/creation/creation.service';
import { ModelService } from '../src/modules/models/model.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';
import { AgentRuntime, planAgents } from '../src/modules/tasks/agent-runtime';
import { RuntimeStore } from '../src/modules/tasks/runtime-store';
import { writeArchive } from '../src/modules/catalog/package-archive';

type Body = {
  messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools?: unknown[];
};
type Handler = (
  body: Body,
  response: ServerResponse,
  request: IncomingMessage,
) => void | Promise<void>;
const success = (response: ServerResponse, content: string) =>
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: 'fixture-response',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    }),
  );
const tools = (response: ServerResponse, calls: { name: string; input: unknown }[]) =>
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call, index) => ({
              id: `call-${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    }),
  );

describe('Durable agent runtime with a local HTTP model fixture (no paid API)', () => {
  let db: DataSource;
  let server: Server;
  let model: ModelConnection;
  let catalog: CatalogService;
  let creation: CreationService;
  let models: ModelService;
  let ownerId: string;
  let account: Account;
  let expert: Expert;
  let handler: Handler;
  let requests: Body[];
  let fixtureError: unknown;
  const env = { ...process.env };
  const apiKey = `fixture-${randomUUID()}`;
  const defaults: RunLimits = { maxCalls: 24, maxTotalTokens: 200000, maxDurationSeconds: 60 };
  const definition: ExpertInput = {
    name: '独立主笔',
    description: 'Fixture',
    instructions: 'Original writing method',
    skillKeys: [],
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('A dedicated *_test database is required');
    server = createServer((request, response) => {
      void (async () => {
        expect(request.url).toBe('/v1/chat/completions');
        expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
        expect(request.headers['x-client-request-id']).toMatch(/^[a-f\d-]{36}$/);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
        requests.push(body);
        await handler(body, response, request);
      })().catch((error: unknown) => {
        fixtureError = error;
        response.destroy();
      });
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MODEL_MODE: 'configured',
      MODEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      MODEL_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      MODEL_ALLOW_LOCAL: 'true',
    });
    db = await createDataSource(url).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE users CASCADE');
    ownerId = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: ownerId,
      username: `runtime-${randomUUID()}`,
      passwordHash: 'not-used',
      createdAt: new Date(),
    });
    catalog = new CatalogService(db);
    creation = new CreationService(db);
    models = new ModelService(db);
    account = await catalog.createAccount(ownerId, {
      name: 'Runtime fixture',
      platform: 'wechat',
      audience: 'Readers',
      persona: 'Account voice has priority',
    });
    expert = await catalog.createExpert(ownerId, definition);
    model = await models.create(ownerId, {
      name: 'Local fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'fixture-only',
      apiKey,
      maxInputTokens: 32000,
      maxOutputTokens: 512,
      tokenParameter: 'max_completion_tokens',
    });
  });
  beforeEach(() => {
    requests = [];
    fixtureError = undefined;
    handler = (_body, response) => {
      success(response, '## 候选正文\n\n原创测试内容，仍待人工审核。');
    };
  });
  afterEach(() => {
    expect(fixtureError).toBeUndefined();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db?.isInitialized) await db.destroy();
    for (const name of [
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
  const create = (selected: Expert = expert, limits: Partial<RunLimits> = {}) =>
    creation.create(
      ownerId,
      {
        accountId: account.id,
        expertId: selected.id,
        topic: 'Runtime topic',
        brief: '',
        modelConnectionId: model.id,
        limits: { ...defaults, ...limits },
      },
      randomUUID(),
    );
  const execute = async (id: string) => {
    await new TaskRunner(db, new MockTextProvider()).execute(id);
    return creation.get(ownerId, id);
  };

  it('creates an immutable, idempotent revision with fresh usage and the full immediate draft context', async () => {
    const selected = await catalog.createExpert(ownerId, definition);
    const parent = await execute((await create(selected)).id);
    const parentBefore = await creation.get(ownerId, parent.id);
    await db.getRepository(ExpertEntity).update(selected.id, {
      version: 2,
      definition: { ...definition, instructions: 'Later method must not leak into old revisions' },
    });
    const key = randomUUID();
    const input = {
      instruction: 'Shorten the opening; keep the rest and provide the complete revised draft',
    };
    const children = await Promise.all(
      Array.from({ length: 5 }, () => creation.continueDraft(ownerId, parent.id, input, key)),
    );
    expect(new Set(children.map((r) => r.id)).size).toBe(1);
    const child = children[0]!;
    expect(child).toMatchObject({
      status: 'queued',
      revision: 1,
      attempts: 0,
      output: null,
      lineage: { parentRunId: parent.id, rootRunId: parent.id, depth: 1 },
      snapshot: {
        expert: { version: 1, instructions: definition.instructions },
        limits: defaults,
        continuation: { instruction: input.instruction, previousOutput: parent.output },
      },
    });
    expect(
      await db.query('SELECT run_id FROM task_outbox WHERE run_id=$1', [child.id]),
    ).toHaveLength(1);
    await expect(
      creation.continueDraft(ownerId, parent.id, { instruction: 'Other request' }, key),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      creation.create(
        ownerId,
        { accountId: account.id, expertId: selected.id, topic: 'Other request', brief: '' },
        key,
      ),
    ).rejects.toMatchObject({ status: 409 });
    handler = (body, response) => {
      const context = JSON.parse(body.messages[1]!.content!);
      expect(context.revisionRequest).toBe(input.instruction);
      expect(context.previousDraft).toEqual(parent.output);
      expect(context.account).toEqual(parent.snapshot.account);
      expect(body.messages[0]!.content).toContain(definition.instructions);
      expect(body.messages[0]!.content).not.toContain('Later method');
      success(response, 'Revised full candidate');
    };
    const done = await execute(child.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      output: { isMock: false },
      execution: { usage: { calls: 1, chargedTokens: 110, reservedTokens: 0 } },
    });
    expect(requests).toHaveLength(2);
    expect(await creation.get(ownerId, parent.id)).toEqual(parentBefore);
    const next = await creation.continueDraft(
      ownerId,
      child.id,
      { instruction: 'Use a more concrete conclusion' },
      randomUUID(),
    );
    expect(next.lineage).toEqual({ parentRunId: child.id, rootRunId: parent.id, depth: 2 });
    expect(next.snapshot.continuation!.previousOutput).toEqual(done.output);
    expect(next.snapshot.continuation).not.toHaveProperty('continuation');
    expect(JSON.stringify(next.snapshot)).not.toContain(input.instruction);
    await creation.cancel(ownerId, next.id);
  });

  it('retains explicit sibling branches and paginated history without exposing drafts or other owners', async () => {
    const parent = await execute((await create()).id);
    const a = await creation.continueDraft(
      ownerId,
      parent.id,
      { instruction: 'First branch' },
      randomUUID(),
    );
    const b = await creation.continueDraft(
      ownerId,
      parent.id,
      { instruction: 'Alternative branch' },
      randomUUID(),
    );
    expect(a.lineage).toEqual(b.lineage);
    expect(a.id).not.toBe(b.id);
    const history = await creation.history(ownerId, a.id, 1, 1);
    const all = await creation.history(ownerId, b.id, 1, 20);
    expect(history).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(history.items).toHaveLength(1);
    expect(all.items.map((r) => r.id).sort()).toEqual([parent.id, a.id, b.id].sort());
    expect(JSON.stringify(all)).not.toContain('previousOutput');
    expect(JSON.stringify(all)).not.toContain('snapshot');
    await expect(creation.history(randomUUID(), parent.id, 1, 10)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      creation.continueDraft(randomUUID(), parent.id, { instruction: 'Revise' }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    for (const status of ['queued', 'running', 'failed', 'cancelled', 'needs_review'] as const) {
      await db.getRepository(RunEntity).update(parent.id, { status });
      await expect(
        creation.continueDraft(ownerId, parent.id, { instruction: 'Revise' }, randomUUID()),
      ).rejects.toMatchObject({ status: 409 });
    }
    await db.getRepository(RunEntity).update(parent.id, { status: 'succeeded' });
    await creation.cancel(ownerId, a.id);
    await creation.cancel(ownerId, b.id);
    expect(requests).toHaveLength(1);
  });

  it('checks current availability while retaining the historical snapshot', async () => {
    const selected = await catalog.createExpert(ownerId, definition);
    const parent = await execute((await create(selected)).id);
    await db.getRepository(ExpertEntity).update(selected.id, { enabled: false });
    await expect(
      creation.continueDraft(ownerId, parent.id, { instruction: 'Revise' }, randomUUID()),
    ).rejects.toMatchObject({ status: 422 });
    await db.getRepository(ExpertEntity).update(selected.id, { enabled: true });
    await models.setEnabled(ownerId, model.id, false);
    try {
      await expect(
        creation.continueDraft(ownerId, parent.id, { instruction: 'Revise' }, randomUUID()),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await models.setEnabled(ownerId, model.id, true);
    }
    expect((await creation.get(ownerId, parent.id)).output).toEqual(parent.output);
    expect(requests).toHaveLength(1);
  });

  it('passes revision context to each independent team member and the lead', async () => {
    const member = {
      name: 'Member',
      description: 'Role',
      instructions: 'Work independently',
      skillKeys: [],
    };
    const team = await catalog.createExpert(ownerId, {
      ...definition,
      expertType: 'team',
      team: {
        leadAgent: 'lead',
        members: [
          { ...member, agentId: 'writer', name: 'Writer' },
          { ...member, agentId: 'reviewer', name: 'Reviewer' },
          { ...member, agentId: 'lead', name: 'Lead' },
        ],
      },
    });
    const parent = await execute((await create(team)).id);
    expect(parent.status).toBe('succeeded');
    requests = [];
    handler = (body, response) => {
      const context = JSON.parse(body.messages[1]!.content!);
      expect(context.revisionRequest).toBe('Improve clarity without adding facts');
      expect(context.previousDraft).toEqual(parent.output);
      success(response, 'Independent revised delivery');
    };
    const child = await creation.continueDraft(
      ownerId,
      parent.id,
      { instruction: 'Improve clarity without adding facts' },
      randomUUID(),
    );
    const done = await execute(child.id);
    expect(done.status).toBe('succeeded');
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.messages[0]!.content)).size).toBe(3);
    expect(done.execution!.agents).toHaveLength(3);
    expect(done.execution!.usage.calls).toBe(3);
    expect(
      done.execution!.invocations.every(
        (i) => !parent.execution!.invocations.some((p) => p.id === i.id),
      ),
    ).toBe(true);
  });

  it('keeps original skill resources after version updates and rejects new revisions when disabled', async () => {
    const key = `revision-${randomUUID().slice(0, 8)}`;
    const document = `---\nname: ${key}\ndescription: Revision fixture\n---\nOriginal method`;
    await catalog.createSkill(ownerId, { key, document });
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: [key],
      preloadSkillKeys: [key],
    });
    const parent = await execute((await create(selected)).id);
    expect(parent.status).toBe('succeeded');
    await catalog.updateSkill(ownerId, key, 1, {
      key,
      document: document.replace('Original method', 'New method'),
    });
    const input = { instruction: 'Keep original writing method' };
    const requestKey = randomUUID();
    const child = await creation.continueDraft(ownerId, parent.id, input, requestKey);
    expect(child.snapshot.skills).toEqual(parent.snapshot.skills);
    expect(child.snapshot.skillSelection?.loaded).toEqual([]);
    await catalog.setSkillEnabled(ownerId, key, false, 2);
    await expect(
      creation.continueDraft(ownerId, parent.id, input, randomUUID()),
    ).rejects.toMatchObject({ status: 422 });
    expect((await creation.continueDraft(ownerId, parent.id, input, requestKey)).id).toBe(child.id);
    await creation.cancel(ownerId, child.id);
    expect(requests).toHaveLength(1);
  });

  it('encrypts keys, isolates owners and never exposes credentials in DTOs or snapshots', async () => {
    const rows: { encrypted_key: string }[] = await db.query(
      'SELECT encrypted_key FROM model_connections WHERE id=$1',
      [model.id],
    );
    expect(rows[0]!.encrypted_key).not.toContain(apiKey);
    expect(await models.credentials(ownerId, model)).toBe(apiKey);
    expect(JSON.stringify(await models.list(ownerId))).not.toContain(apiKey);
    expect(await models.list(randomUUID())).toEqual([]);
    await expect(models.credentials(randomUUID(), model)).rejects.toMatchObject({ status: 422 });
    const run = await create();
    expect(JSON.stringify(run)).not.toContain(apiKey);
    await expect(creation.cancel(randomUUID(), run.id)).rejects.toMatchObject({ status: 404 });
    await creation.cancel(ownerId, run.id);
  });

  it('executes a skill-free expert and records usage without claiming mock output', async () => {
    const run = await create();
    const done = await execute(run.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      output: { isMock: false, reviewStatus: 'pending_review' },
      execution: {
        usage: { calls: 1, chargedTokens: 110, reservedTokens: 0, hasEstimatedUsage: false },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
    expect(done.execution!.agents[0]).toMatchObject({ status: 'succeeded', loadedSkillKeys: [] });
    expect(done.execution!.invocations[0]!.providerRequestId).toBe('fixture-response');
    await execute(run.id);
    expect(requests).toHaveLength(1);
  });

  it('preloads instructions, loads skills on demand and audits denied tools and resources', async () => {
    const imported = await catalog.importPackage(
      ownerId,
      await writeArchive([
        {
          path: 'SKILL.md',
          content:
            '---\nname: runtime-ref\ndescription: Metadata only\n---\nSECRET_INSTRUCTIONS_FROM_SKILL',
          encoding: 'utf8',
        },
        { path: 'references/source.md', content: 'ORIGINAL_REFERENCE', encoding: 'utf8' },
      ]),
    );
    const skill = imported.skills[0]!;
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: ['plain-writing', skill.key],
      preloadSkillKeys: ['plain-writing'],
    });
    handler = (body, response) => {
      const turn = requests.length;
      if (turn === 1) {
        expect(JSON.stringify(body.messages)).not.toContain('SECRET_INSTRUCTIONS_FROM_SKILL');
        expect(JSON.stringify(body.messages)).toContain('配置预加载');
        tools(response, [{ name: 'load_skill', input: { key: skill.key } }]);
      } else if (turn === 2) {
        expect(body.messages.at(-1)!.tool_call_id).toBe('call-0');
        expect(body.messages.at(-1)!.content).toContain('SECRET_INSTRUCTIONS_FROM_SKILL');
        tools(response, [
          { name: 'read_skill_file', input: { key: skill.key, path: 'references/source.md' } },
          { name: 'shell', input: { command: 'never execute' } },
          {
            name: 'read_skill_file',
            input: { key: skill.key, path: 'references/../settings.json' },
          },
          { name: 'load_skill', input: { key: 'fact-check' } },
        ]);
      } else {
        expect(JSON.stringify(body.messages)).toContain('ORIGINAL_REFERENCE');
        success(response, 'Skills were available as untrusted text; no script was executed.');
      }
    };
    const done = await execute((await create(selected)).id);
    expect(done.failureCode).toBeNull();
    expect(done.status).toBe('succeeded');
    expect(done.snapshot.skillSelection!.loaded).toEqual([]);
    expect(done.execution!.agents[0]!.loadedSkillKeys).toEqual(['plain-writing', skill.key]);
    expect(done.execution!.tools.filter((tool) => tool.status === 'denied')).toHaveLength(3);
    expect(done.execution!.tools).toHaveLength(6);
  });

  it.each(['agent', 'team'] as const)(
    'actually loads pinned historical instructions/resources for a %s after current content changes',
    async (kind) => {
      const key = `runtime-pin-${kind}`;
      const document = (body: string) =>
        `---\nname: ${key}\ndescription: Versioned method\n---\n${body}`;
      const imported = await catalog.importPackage(
        ownerId,
        await writeArchive([
          { path: 'SKILL.md', content: document('PINNED_INSTRUCTIONS'), encoding: 'utf8' },
          { path: 'references/source.md', content: 'PINNED_REFERENCE', encoding: 'utf8' },
        ]),
      );
      const skill = imported.skills[0]!;
      const changed = await catalog.updateSkill(ownerId, key, 1, {
        key,
        document: document('LATER_INSTRUCTIONS'),
      });
      // Synthetic resource edit is limited to the isolated test fixture, not a production API.
      const latest = {
        ...changed,
        files: [
          { path: 'references/source.md', content: 'LATER_REFERENCE', encoding: 'utf8' as const },
        ],
      };
      await db.transaction(async (em) => {
        const row = await em.findOneByOrFail(SkillEntity, { ownerId, key });
        await em.update(SkillEntity, row.id, { definition: latest });
        await em.update(
          SkillVersionEntity,
          { skillId: row.id, version: 2 },
          { definition: latest },
        );
      });
      const selected = await catalog.createExpert(ownerId, {
        ...definition,
        skillKeys: [key],
        skillVersions: { [key]: 1 },
        expertType: kind,
        ...(kind === 'team'
          ? {
              team: {
                leadAgent: 'lead',
                members: ['lead', 'writer'].map((agentId) => ({
                  ...definition,
                  agentId,
                  name: agentId,
                  skillKeys: [key],
                })),
              },
            }
          : {}),
      });
      const run = await create(selected);
      await catalog.updateSkill(ownerId, key, 2, {
        key,
        document: document('STILL_LATER_INSTRUCTIONS'),
      });
      handler = (body, response) => {
        const transcript = JSON.stringify(body.messages);
        expect(transcript).not.toContain('LATER_INSTRUCTIONS');
        expect(transcript).not.toContain('LATER_REFERENCE');
        const turn = body.messages.filter((message) => message.role === 'assistant').length;
        if (turn === 0) tools(response, [{ name: 'load_skill', input: { key } }]);
        else if (turn === 1) {
          expect(body.messages.at(-1)!.content).toContain('PINNED_INSTRUCTIONS');
          tools(response, [
            { name: 'read_skill_file', input: { key, path: 'references/source.md' } },
          ]);
        } else {
          expect(body.messages.at(-1)!.content).toContain('PINNED_REFERENCE');
          success(response, 'Pinned snapshot was used; candidate needs human review.');
        }
      };
      const done = await execute(run.id);
      expect(done).toMatchObject({
        status: 'succeeded',
        failureCode: null,
        snapshot: { skills: [{ key, version: 1, files: skill.files }] },
      });
      expect(done.execution!.agents.every((agent) => agent.loadedSkillKeys.includes(key))).toBe(
        true,
      );
      expect(done.execution!.tools.every((tool) => tool.status === 'succeeded')).toBe(true);
      expect(requests).toHaveLength(kind === 'team' ? 6 : 3);
    },
  );

  it('runs independent parallel members, phase dependencies and a separate lead synthesis', async () => {
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      name: 'Fixture team',
      expertType: 'team',
      team: {
        leadAgent: 'lead',
        members: ['lead', 'research', 'outline', 'writer'].map((id) => ({
          ...definition,
          name: id,
          agentId: id,
        })),
        phases: [
          { name: 'Parallel', agents: ['research', 'outline'], task: 'Independent analysis' },
          { name: 'Draft', agents: ['writer'], task: 'Use prior findings' },
        ],
      },
    });
    const parallel: ServerResponse[] = [];
    handler = (body, response) => {
      const task = JSON.parse(body.messages[1]!.content!) as {
        dependencyResults: { name: string; result: string }[];
      };
      const name = /当前专家：(\w+)/.exec(body.messages[0]!.content!)![1]!;
      expect(body.messages).toHaveLength(2);
      if (name === 'research' || name === 'outline') {
        expect(task.dependencyResults).toEqual([]);
        parallel.push(response);
        if (parallel.length === 2)
          parallel.forEach((res, i) => success(res, `Independent finding ${i}`));
      } else if (name === 'writer') {
        expect(task.dependencyResults).toHaveLength(2);
        success(response, 'Writer synthesis');
      } else {
        expect(name).toBe('lead');
        expect(task.dependencyResults).toHaveLength(3);
        success(response, 'Lead final candidate');
      }
    };
    const run = await create(selected);
    let runtimeFailure: unknown;
    class TeamRuntime extends AgentRuntime {
      override async execute(...args: Parameters<AgentRuntime['execute']>) {
        try {
          return await super.execute(...args);
        } catch (error) {
          runtimeFailure = error;
          throw error;
        }
      }
    }
    await new TaskRunner(db, new MockTextProvider(), new TeamRuntime(db)).execute(run.id);
    const done = await creation.get(ownerId, run.id);
    expect(runtimeFailure).toBeUndefined();
    expect(done.status).toBe('succeeded');
    expect(requests).toHaveLength(4);
    expect(done.execution!.agents.every((agent) => agent.status === 'succeeded')).toBe(true);
    expect(new Set(done.execution!.invocations.map((call) => call.agentRunId)).size).toBe(4);
    expect(
      done.execution!.messages.filter((message) => message.kind === 'assignment'),
    ).toHaveLength(3);
    expect(done.execution!.messages.filter((message) => message.kind === 'report')).toHaveLength(3);
  });

  it('enforces a token reservation before any network dispatch', async () => {
    const done = await execute((await create(expert, { maxTotalTokens: 2000 })).id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(requests).toHaveLength(0);
    expect(done.execution!.usage.calls).toBe(0);
  });

  it('enforces the call budget across tool turns', async () => {
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: ['plain-writing'],
    });
    handler = (_body, response) => {
      tools(response, [{ name: 'load_skill', input: { key: 'plain-writing' } }]);
    };
    const done = await execute((await create(selected, { maxCalls: 1 })).id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(requests).toHaveLength(1);
    expect(done.execution!.usage.reservedTokens).toBe(0);
  });

  it('releases reservations for a disabled connection before sending', async () => {
    const run = await create();
    await models.setEnabled(ownerId, model.id, false);
    try {
      const done = await execute(run.id);
      expect(done).toMatchObject({ status: 'failed', execution: { usage: { reservedTokens: 0 } } });
      expect(done.execution!.invocations[0]).toMatchObject({
        status: 'rejected',
        failureCode: 'NOT_DISPATCHED',
      });
      expect(requests).toHaveLength(0);
    } finally {
      await models.setEnabled(ownerId, model.id, true);
    }
  });

  it('cancels queued work without calling a model', async () => {
    const run = await create();
    await creation.cancel(ownerId, run.id);
    expect((await execute(run.id)).status).toBe('cancelled');
    expect(requests).toHaveLength(0);
  });

  it('retains unknown charges after a disconnected request and never automatically resends', async () => {
    handler = (_body, response) => {
      response.destroy();
    };
    const run = await create();
    const done = await execute(run.id);
    expect(done).toMatchObject({
      status: 'needs_review',
      execution: { usage: { calls: 1, hasEstimatedUsage: true } },
    });
    expect(done.execution!.invocations[0]!.status).toBe('unknown');
    expect(done.execution!.usage.reservedTokens).toBeGreaterThan(0);
    await execute(run.id);
    expect(requests).toHaveLength(1);
    await expect(
      creation.reconcile(randomUUID(), run.id, 'Checked provider invoice'),
    ).rejects.toMatchObject({ status: 404 });
    const acknowledged = await creation.reconcile(
      ownerId,
      run.id,
      'Checked provider invoice; retain unknown charge evidence',
    );
    expect(acknowledged).toMatchObject({
      status: 'cancelled',
      failureCode: 'UNKNOWN_ACKNOWLEDGED',
    });
    expect(acknowledged.execution!.invocations[0]!.status).toBe('unknown');
    expect(acknowledged.execution!.reconciliations).toEqual([
      expect.objectContaining({ note: 'Checked provider invoice; retain unknown charge evidence' }),
    ]);
    expect((await creation.get(ownerId, run.id)).execution!.reconciliations).toEqual(
      acknowledged.execution!.reconciliations,
    );
  });

  it('interrupts an in-flight request on cancel without claiming a free cancellation', async () => {
    let entered!: () => void;
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    handler = () => {
      entered();
    };
    const run = await create();
    const running = execute(run.id);
    await sent;
    await creation.cancel(ownerId, run.id);
    const done = await running;
    expect(done.status).toBe('needs_review');
    expect(done.execution!.invocations[0]!.status).toBe('unknown');
    await execute(run.id);
    expect(requests).toHaveLength(1);
  });

  it('resumes a confirmed response from its ledger without a second network request', async () => {
    const run = await create();
    const done = await execute(run.id);
    expect(done.status).toBe('succeeded');
    await db.query("UPDATE agent_runs SET status='running',result=NULL WHERE run_id=$1", [run.id]);
    await db.getRepository(RunEntity).update(run.id, {
      status: 'running',
      output: null,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(0),
    });
    const recovered = await execute(run.id);
    expect(recovered).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(requests).toHaveLength(1);
  });

  it('fences an interrupted worker, retains unknown invocations and releases unsent reservations', async () => {
    const run = await create();
    const lease = randomUUID();
    await db.getRepository(RunEntity).update(run.id, {
      status: 'running',
      leaseToken: lease,
      leaseExpiresAt: new Date(0),
      startedAt: new Date(),
    });
    const store = new RuntimeStore(db, run.id, lease);
    const agents = planAgents(run.id, run.snapshot);
    await store.addAgents(agents);
    await store.agentState(agents[0]!.id, 'running');
    const sent = await store.reserve(agents[0]!.id, 1, 3000, 'first');
    await store.startInvocation(sent.id);
    await store.reserve(agents[0]!.id, 2, 2500, 'unsent');
    const done = await execute(run.id);
    expect(done).toMatchObject({
      status: 'needs_review',
      execution: { usage: { reservedTokens: 3000 } },
    });
    expect(done.execution!.invocations.map((call) => call.status).sort()).toEqual([
      'rejected',
      'unknown',
    ]);
    await expect(store.agentState(agents[0]!.id, 'succeeded', 'late result')).rejects.toMatchObject(
      { code: 'LEASE_LOST' },
    );
    expect(requests).toHaveLength(0);
  });

  it('treats truncated responses as unknown rather than retryable failures', async () => {
    handler = (_body, response) => {
      response.end(
        JSON.stringify({
          choices: [
            { finish_reason: 'length', message: { role: 'assistant', content: 'Incomplete' } },
          ],
        }),
      );
    };
    const run = await create();
    expect((await execute(run.id)).status).toBe('needs_review');
    await execute(run.id);
    expect(requests).toHaveLength(1);
  });

  it('does not follow a redirect or expose the key to a second destination', async () => {
    handler = (_body, response) => {
      response.writeHead(307, { Location: 'http://127.0.0.1:1/forbidden' }).end();
    };
    const done = await execute((await create()).id);
    expect(done.status).toBe('needs_review');
    expect(done.execution!.invocations[0]!.failureCode).toBe('PROVIDER_HTTP_307');
    expect(requests).toHaveLength(1);
  });
});
