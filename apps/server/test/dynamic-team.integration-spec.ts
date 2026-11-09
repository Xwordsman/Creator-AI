import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import {
  isTerminal,
  type Account,
  type CreationRun,
  type Expert,
  type ExpertInput,
  type ModelConnection,
  type RunLimits,
  type TeamAction,
  type TeamDirective,
  type TeamResponse,
} from '@creator-ai/contracts';
import { createDataSource } from '../src/database/data-source';
import { OutboxEntity, RunEntity, UserEntity } from '../src/database/entities';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { CreationService } from '../src/modules/creation/creation.service';
import { ModelService } from '../src/modules/models/model.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';

type Body = {
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools?: unknown[];
};
type Handler = (
  body: Body,
  response: ServerResponse,
  request: IncomingMessage,
) => void | Promise<void>;
type Protocol = 'planner' | 'member' | 'peer' | 'lead';
type Step = {
  protocol: Protocol;
  reply: TeamDirective | string | ((body: Body) => TeamDirective | string);
  inspect?: (body: Body) => void;
  usage?: { prompt_tokens: number; completion_tokens: number };
};
type Assignment = {
  assignment: string;
  dependencyResults: { agentId: string; name: string; result: string }[];
};
type History = {
  collaborationHistory: {
    sourceTaskId: string;
    directive: TeamDirective;
    response: TeamResponse | null;
  }[];
};

const protocol = (body: Body): Protocol => {
  const systems = body.messages.filter((message) => message.role === 'system');
  if (systems.some((message) => message.content?.includes('\u52a8\u6001\u56e2\u961f\u534f\u8bae')))
    return 'planner';
  if (systems.some((message) => message.content?.includes('\u540c\u4f34\u7b54\u590d\u534f\u8bae')))
    return 'peer';
  if (systems.some((message) => message.content?.includes('\u52a8\u6001\u6210\u5458\u534f\u8bae')))
    return 'member';
  return 'lead';
};
const assignment = (body: Body) => JSON.parse(body.messages[1]!.content!) as Assignment;
const history = (body: Body): History['collaborationHistory'] => {
  const message = body.messages.find(
    (item) => item.role === 'user' && item.content?.includes('"collaborationHistory"'),
  );
  expect(message).toBeDefined();
  return (JSON.parse(message!.content!) as History).collaborationHistory;
};
const delegate = (memberId = 'writer', dependencies: string[] = []): TeamDirective => ({
  action: 'delegate',
  summary: 'Propose an independently authored delivery',
  tasks: [{ memberId, task: `Prepare the ${memberId} delivery`, dependencies }],
});
const deliver = (content = 'Independent member delivery'): TeamDirective => ({
  action: 'deliver',
  content,
});
const finalize: TeamDirective = {
  action: 'finalize',
  summary: 'Synthesize the confirmed deliveries',
};
const finalText = '## Candidate draft\n\nA complete lead synthesis, pending human review.';
const success = (
  response: ServerResponse,
  content: string,
  usage = { prompt_tokens: 80, completion_tokens: 30 },
) =>
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: 'dynamic-fixture-response',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage,
    }),
  );

describe('Dynamic teams with a durable PostgreSQL ledger and a local HTTP model (no paid API)', () => {
  let db: DataSource;
  let server: Server;
  let model: ModelConnection;
  let catalog: CatalogService;
  let creation: CreationService;
  let account: Account;
  let team: Expert;
  let ownerId: string;
  let handler: Handler;
  let requests: Body[];
  let requestIds: string[];
  let fixtureError: unknown;
  let steps: Step[] | undefined;
  const env = { ...process.env };
  const apiKey = `fixture-${randomUUID()}`;
  const defaults: RunLimits = { maxCalls: 40, maxTotalTokens: 200000, maxDurationSeconds: 60 };
  const definition: ExpertInput = {
    name: 'Dynamic fixture team',
    description: 'Local integration fixture',
    instructions: 'Keep each delivery independent and never invent another member response',
    skillKeys: [],
    expertType: 'team',
    team: {
      leadAgent: 'lead',
      members: ['lead', 'writer', 'reviewer'].map((id) => ({
        agentId: id,
        name: id,
        description: `${id} responsibility`,
        instructions: `Use the ${id} method`,
        skillKeys: [],
        maxTurns: 9,
      })),
      phases: [{ name: 'Reference only', agents: ['reviewer'], task: 'Do not auto-dispatch this' }],
    },
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('A dedicated *_test database is required');
    server = createServer((request, response) => {
      void (async () => {
        expect(request.url).toBe('/v1/chat/completions');
        expect(request.headers.authorization === `Bearer ${apiKey}`).toBe(true);
        expect(request.headers['x-client-request-id']).toMatch(/^[a-f\d-]{36}$/);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
        requests.push(body);
        requestIds.push(request.headers['x-client-request-id'] as string);
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
      username: `dynamic-${randomUUID()}`,
      passwordHash: 'not-used',
      createdAt: new Date(),
    });
    catalog = new CatalogService(db);
    creation = new CreationService(db);
    account = await catalog.createAccount(ownerId, {
      name: 'Dynamic fixture account',
      platform: 'wechat',
      audience: 'Readers',
      persona: 'Account voice takes priority',
    });
    team = await catalog.createExpert(ownerId, definition);
    model = await new ModelService(db).create(ownerId, {
      name: 'Local dynamic fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'dynamic-fixture',
      apiKey,
      maxInputTokens: 32000,
      maxOutputTokens: 512,
      tokenParameter: 'max_completion_tokens',
    });
  });

  beforeEach(() => {
    requests = [];
    requestIds = [];
    fixtureError = undefined;
    steps = undefined;
    handler = () => {
      throw new Error('Unexpected model dispatch');
    };
  });
  afterEach(() => {
    expect(fixtureError).toBeUndefined();
    if (steps) expect(steps).toHaveLength(0);
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

  const script = (...expected: Step[]) => {
    steps = [...expected];
    handler = (body, response) => {
      const step = steps!.shift();
      expect(step).toBeDefined();
      expect(protocol(body)).toBe(step!.protocol);
      if (step!.protocol === 'planner') expect(body.tools).toBeUndefined();
      step!.inspect?.(body);
      const reply = typeof step!.reply === 'function' ? step!.reply(body) : step!.reply;
      success(response, typeof reply === 'string' ? reply : JSON.stringify(reply), step!.usage);
    };
  };
  const create = (limits: Partial<RunLimits> = {}, selected = team) =>
    creation.create(
      ownerId,
      {
        accountId: account.id,
        expertId: selected.id,
        topic: 'Dynamic runtime topic',
        brief: 'Use only confirmed facts',
        modelConnectionId: model.id,
        teamMode: 'dynamic',
        limits: { ...defaults, ...limits },
      },
      randomUUID(),
    );
  const execute = async (id: string) => {
    await new TaskRunner(db, new MockTextProvider()).execute(id);
    return new CreationService(db).get(ownerId, id);
  };
  const actions = (run: CreationRun) => {
    expect(run.execution?.collaboration).toBeDefined();
    return run.execution!.collaboration!;
  };
  const pending = (run: CreationRun, action: TeamDirective['action']): TeamAction => {
    expect(run.status).toBe('waiting_user');
    expect(isTerminal(run.status)).toBe(false);
    expect(run.output).toBeNull();
    expect(run.failureCode).toBeNull();
    const waiting = actions(run).filter((item) => item.state === 'waiting' && !item.response);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.directive.action).toBe(action);
    return waiting[0]!;
  };
  const answer = (run: CreationRun, input: TeamResponse) => {
    const action = actions(run).find((item) => item.state === 'waiting' && !item.response)!;
    return new CreationService(db).respond(ownerId, run.id, action.id, input);
  };
  const approve = (run: CreationRun) =>
    answer(run, { answer: 'Approved as proposed', approved: true });
  const standardScript = () =>
    script(
      { protocol: 'planner', reply: delegate() },
      { protocol: 'member', reply: deliver() },
      { protocol: 'planner', reply: finalize },
      { protocol: 'lead', reply: finalText },
    );

  it('pauses before any member dispatch, persists concurrent approvals, and resumes with fresh runners', async () => {
    script(
      { protocol: 'planner', reply: delegate() },
      {
        protocol: 'member',
        reply: deliver(),
        inspect: (body) => {
          expect(assignment(body)).toMatchObject({
            assignment: 'Prepare the writer delivery',
            dependencyResults: [],
          });
          expect(history(body)[0]!.response).toEqual({ answer: 'Proceed once', approved: true });
        },
      },
      { protocol: 'planner', reply: finalize },
      {
        protocol: 'lead',
        reply: finalText,
        inspect: (body) => {
          expect(assignment(body).dependencyResults).toMatchObject([
            { agentId: 'writer', name: 'writer', result: JSON.stringify(deliver()) },
          ]);
        },
      },
    );
    const run = await create();
    expect(run.snapshot).toMatchObject({ provider: 'compatible', workflow: 'team-dynamic-v1' });
    expect(JSON.stringify(run).includes(apiKey)).toBe(false);
    const waiting = await execute(run.id);
    const plan = pending(waiting, 'delegate');
    expect(plan).toMatchObject({
      sourceAgentRunId: waiting.execution!.agents[0]!.id,
      directive: delegate(),
      state: 'waiting',
      response: null,
      spawnedAgentIds: [],
    });
    expect(plan.id).toMatch(/^[a-f\d-]{36}$/);
    expect(Number.isNaN(Date.parse(plan.createdAt))).toBe(false);
    expect(waiting.execution!.agents.map((agent) => agent.role)).toEqual(['planner']);
    expect(waiting.execution!.usage).toMatchObject({ calls: 1, reservedTokens: 0 });
    expect(await new CreationService(db).get(ownerId, run.id)).toEqual(waiting);
    const idle = await Promise.all([execute(run.id), execute(run.id), execute(run.id)]);
    expect(idle.every((item) => item.revision === waiting.revision)).toBe(true);
    expect(idle.every((item) => item.attempts === 1)).toBe(true);
    expect(requests).toHaveLength(1);

    await db.getRepository(RunEntity).update(run.id, { recoveryAttempts: 2 });
    await db.getRepository(OutboxEntity).update(run.id, {
      sequence: 3,
      lastDispatchedAt: new Date(),
    });
    const response = { answer: 'Proceed once', approved: true };
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        new CreationService(db).respond(ownerId, run.id, plan.id, response),
      ),
    );
    expect(new Set(replies.map((item) => item.revision)).size).toBe(1);
    expect(replies[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(actions(replies[0]!)[0]).toMatchObject({
      state: 'waiting',
      response,
      spawnedAgentIds: [],
    });
    expect(replies[0]!.execution!.agents).toHaveLength(1);
    expect(
      replies[0]!.execution!.messages.filter((message) => message.kind === 'answer'),
    ).toHaveLength(1);
    expect(await db.getRepository(RunEntity).findOneByOrFail({ id: run.id })).toMatchObject({
      recoveryAttempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(await db.getRepository(OutboxEntity).findOneByOrFail({ runId: run.id })).toMatchObject({
      sequence: 3,
      lastDispatchedAt: null,
    });
    expect(requests).toHaveLength(1);
    for (const changed of [
      { ...response, answer: 'Different answer' },
      { ...response, approved: false },
    ]) {
      await expect(creation.respond(ownerId, run.id, plan.id, changed)).rejects.toMatchObject({
        status: 409,
      });
    }

    await Promise.all([execute(run.id), execute(run.id)]);
    const done = await creation.get(ownerId, run.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      failureCode: null,
      output: { isMock: false, reviewStatus: 'pending_review' },
      execution: { usage: { calls: 4, chargedTokens: 440, reservedTokens: 0 } },
    });
    expect(JSON.stringify(done.output)).toContain('A complete lead synthesis');
    expect(done.execution!.agents.map((agent) => agent.role)).toEqual([
      'planner',
      'member',
      'planner',
      'lead',
    ]);
    expect(actions(done).every((action) => action.state === 'applied')).toBe(true);
    expect(actions(done)[0]!.spawnedAgentIds).toEqual([done.execution!.agents[1]!.id]);
    expect(done.execution!.agents.at(-1)!.dependencies).toEqual([done.execution!.agents[1]!.id]);
    expect(new Set(requestIds).size).toBe(4);
    expect(done.execution!.invocations.map((item) => item.id).sort()).toEqual(
      [...requestIds].sort(),
    );
    const repeated = await creation.respond(ownerId, run.id, plan.id, response);
    expect(repeated.revision).toBe(done.revision);
    expect((await execute(run.id)).revision).toBe(done.revision);
    expect(requests).toHaveLength(4);
  });

  it('strips planner skill tools and preloads and limits each planner to one actual model turn', async () => {
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      skillKeys: ['plain-writing'],
      team: {
        ...definition.team!,
        members: definition.team!.members.map((member) =>
          member.agentId === 'lead'
            ? { ...member, skillKeys: ['plain-writing'], preloadSkillKeys: ['plain-writing'] }
            : member,
        ),
      },
    });
    script({ protocol: 'planner', reply: delegate() });
    const waiting = await execute((await create({}, selected)).id);
    pending(waiting, 'delegate');
    const rows: { definition: unknown }[] = await db.query(
      "SELECT definition FROM agent_runs WHERE run_id=$1 AND role='planner'",
      [waiting.id],
    );
    expect(rows[0]!.definition).toMatchObject({
      skillKeys: [],
      preloadSkillKeys: [],
      maxTurns: 1,
    });
    expect(waiting.snapshot.expert.team!.members[0]).toMatchObject({
      skillKeys: ['plain-writing'],
      preloadSkillKeys: ['plain-writing'],
      maxTurns: 9,
    });
    expect(waiting.execution!.tools).toEqual([]);
    expect(waiting.execution!.invocations).toHaveLength(1);
    expect(waiting.execution!.invocations[0]!.turn).toBe(1);
    expect(requests[0]!.tools).toBeUndefined();
    await creation.cancel(ownerId, waiting.id);
  });

  it('rejects a plan without spawning members and sends the persisted rejection into a new proposal', async () => {
    const rejection = { answer: 'Use the reviewer instead of the writer', approved: false };
    script(
      { protocol: 'planner', reply: delegate() },
      {
        protocol: 'planner',
        reply: delegate('reviewer'),
        inspect: (body) => expect(history(body)[0]!.response).toEqual(rejection),
      },
      { protocol: 'member', reply: deliver('Reviewer delivery') },
      { protocol: 'planner', reply: finalize },
      { protocol: 'lead', reply: finalText },
    );
    const first = await execute((await create()).id);
    const firstPlan = pending(first, 'delegate');
    const queued = await answer(first, rejection);
    expect(queued.status).toBe('queued');
    expect(queued.execution!.agents).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const replanned = await execute(first.id);
    const nextPlan = pending(replanned, 'delegate');
    expect(nextPlan.id).not.toBe(firstPlan.id);
    expect(actions(replanned)[0]).toMatchObject({
      state: 'applied',
      response: rejection,
      spawnedAgentIds: [],
    });
    expect(replanned.execution!.agents.every((agent) => agent.role === 'planner')).toBe(true);
    expect(requests).toHaveLength(2);
    await approve(replanned);
    const done = await execute(first.id);
    expect(done.status).toBe('succeeded');
    expect(
      done
        .execution!.agents.filter((agent) => agent.role === 'member')
        .map((agent) => agent.agentId),
    ).toEqual(['reviewer']);
    expect(requests).toHaveLength(5);
  });

  it('allows four human resume segments without exhausting recovery attempts or charging human wait time', async () => {
    const responses: TeamResponse[] = [
      { answer: 'Researchers are the intended audience' },
      { answer: 'Reject speculative facts and keep a narrow scope', approved: false },
      { answer: 'Use only the supplied verified dataset' },
      { answer: 'The revised assignment is approved', approved: true },
    ];
    const directives: TeamDirective[] = [
      { action: 'ask_user', question: 'Who is the intended audience?' },
      { action: 'confirm', question: 'May we include speculative facts?' },
      { action: 'ask_user', question: 'Which source may we use?' },
      delegate(),
    ];
    script(
      ...directives.map((reply, index): Step => ({
        protocol: 'planner',
        reply,
        inspect: (body) =>
          expect(history(body).map((item) => item.response)).toEqual(responses.slice(0, index)),
      })),
      { protocol: 'member', reply: deliver() },
      {
        protocol: 'planner',
        reply: finalize,
        inspect: (body) =>
          expect(
            history(body)
              .filter((item) => item.response)
              .map((item) => item.response),
          ).toEqual(responses),
      },
      { protocol: 'lead', reply: finalText },
    );
    const run = await create({ maxDurationSeconds: 30 });
    for (const [index, directive] of directives.entries()) {
      const waiting = await execute(run.id);
      pending(waiting, directive.action);
      expect(waiting.attempts).toBe(index + 1);
      const row = await db.getRepository(RunEntity).findOneByOrFail({ id: run.id });
      expect(row).toMatchObject({ recoveryAttempts: 1, activeStartedAt: null, leaseToken: null });
      // Simulate a long human pause without sleeping or changing the active execution budget.
      await db.getRepository(RunEntity).update(run.id, { startedAt: new Date(0) });
      await db.getRepository(OutboxEntity).update(run.id, { lastDispatchedAt: new Date() });
      await answer(waiting, responses[index]!);
      expect(await db.getRepository(RunEntity).findOneByOrFail({ id: run.id })).toMatchObject({
        status: 'queued',
        recoveryAttempts: 0,
      });
      expect(await db.getRepository(OutboxEntity).findOneByOrFail({ runId: run.id })).toMatchObject(
        {
          lastDispatchedAt: null,
        },
      );
    }
    const done = await execute(run.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 5, failureCode: null });
    expect(done.execution!.usage).toMatchObject({
      calls: 7,
      chargedTokens: 770,
      reservedTokens: 0,
    });
    expect(actions(done).filter((action) => action.response)).toHaveLength(4);
    expect(requests).toHaveLength(7);
  });

  it('actually calls a peer, then calls the requester as a new task with the real peer delivery dependency', async () => {
    const peerDelivery = deliver('Peer independently verified the supplied source');
    const requesterDelivery = deliver('Writer incorporated the real peer answer');
    script(
      { protocol: 'planner', reply: delegate() },
      {
        protocol: 'member',
        reply: {
          action: 'request_peer',
          memberId: 'reviewer',
          question: 'Which source supports this?',
        },
        inspect: (body) => expect(assignment(body).dependencyResults).toEqual([]),
      },
      {
        protocol: 'peer',
        reply: peerDelivery,
        inspect: (body) => {
          expect(body.messages[0]!.content).toContain('reviewer');
          expect(assignment(body).assignment).toContain('Which source supports this?');
          expect(assignment(body).dependencyResults).toEqual([]);
        },
      },
      {
        protocol: 'member',
        reply: requesterDelivery,
        inspect: (body) => {
          expect(body.messages[0]!.content).toContain('writer');
          expect(assignment(body)).toMatchObject({
            assignment: 'Prepare the writer delivery',
            dependencyResults: [
              { agentId: 'reviewer', name: 'reviewer', result: JSON.stringify(peerDelivery) },
            ],
          });
          expect(history(body).some((item) => item.directive.action === 'request_peer')).toBe(true);
        },
      },
      { protocol: 'planner', reply: finalize },
      {
        protocol: 'lead',
        reply: finalText,
        inspect: (body) =>
          expect(
            assignment(body)
              .dependencyResults.map((item) => item.result)
              .sort(),
          ).toEqual([JSON.stringify(peerDelivery), JSON.stringify(requesterDelivery)].sort()),
      },
    );
    const waiting = await execute((await create()).id);
    await approve(waiting);
    const done = await execute(waiting.id);
    expect(done.status).toBe('succeeded');
    const members = done.execution!.agents.filter((agent) => agent.role === 'member');
    expect(members.map((agent) => agent.agentId)).toEqual(['writer', 'reviewer', 'writer']);
    expect(members[0]!.id).not.toBe(members[2]!.id);
    expect(members[2]!.task).toBe(members[0]!.task);
    expect(members[2]!.dependencies).toEqual([members[1]!.id]);
    const peer = actions(done).find((action) => action.directive.action === 'request_peer')!;
    expect(peer).toMatchObject({
      sourceAgentRunId: members[0]!.id,
      state: 'applied',
      response: null,
      spawnedAgentIds: [members[1]!.id, members[2]!.id],
    });
    expect(
      done.execution!.invocations.every((invocation) => invocation.status === 'succeeded'),
    ).toBe(true);
    expect(
      new Set(done.execution!.invocations.map((invocation) => invocation.agentRunId)).size,
    ).toBe(6);
    expect(done.execution!.usage.calls).toBe(6);
    expect(requests.map(protocol)).toEqual([
      'planner',
      'member',
      'peer',
      'member',
      'planner',
      'lead',
    ]);
  });

  it('resumes a member question as a fresh task using the persisted user answer, without rerunning its first call', async () => {
    const response = { answer: 'Use the supplied annual report only' };
    script(
      { protocol: 'planner', reply: delegate() },
      {
        protocol: 'member',
        reply: { action: 'ask_user', question: 'Which source should I quote?' },
      },
      {
        protocol: 'member',
        reply: deliver(),
        inspect: (body) => {
          expect(assignment(body)).toMatchObject({
            assignment: 'Prepare the writer delivery',
            dependencyResults: [],
          });
          expect(history(body).at(-1)!.response).toEqual(response);
        },
      },
      { protocol: 'planner', reply: finalize },
      { protocol: 'lead', reply: finalText },
    );
    const initial = await execute((await create()).id);
    await approve(initial);
    const waiting = await execute(initial.id);
    const question = pending(waiting, 'ask_user');
    expect(waiting.execution!.usage.calls).toBe(2);
    const source = waiting.execution!.agents.find(
      (agent) => agent.id === question.sourceAgentRunId,
    )!;
    expect(source).toMatchObject({ role: 'member', agentId: 'writer', status: 'succeeded' });
    await expect(answer(waiting, { ...response, approved: false })).rejects.toMatchObject({
      status: 422,
    });
    expect((await execute(waiting.id)).revision).toBe(waiting.revision);
    await answer(waiting, response);
    const done = await execute(waiting.id);
    expect(done.status).toBe('succeeded');
    const continued = done.execution!.agents.filter((agent) => agent.role === 'member');
    expect(continued).toHaveLength(2);
    expect(continued[1]!.id).not.toBe(source.id);
    expect(actions(done).find((action) => action.id === question.id)).toMatchObject({
      state: 'applied',
      response,
      spawnedAgentIds: [continued[1]!.id],
    });
    expect(done.execution!.usage.calls).toBe(5);
    expect(requests).toHaveLength(5);
  });

  it('uses completed task UUIDs for later approved assignments, not member names or configured phases', async () => {
    let deliveryId: string;
    script(
      { protocol: 'planner', reply: delegate() },
      { protocol: 'member', reply: deliver() },
      {
        protocol: 'planner',
        reply: (body) => {
          deliveryId = history(body).find(
            (item) => item.directive.action === 'deliver',
          )!.sourceTaskId;
          return delegate('reviewer', [deliveryId]);
        },
      },
      {
        protocol: 'member',
        reply: deliver('Review of the actual prior delivery'),
        inspect: (body) =>
          expect(assignment(body).dependencyResults).toMatchObject([
            { agentId: 'writer', name: 'writer', result: JSON.stringify(deliver()) },
          ]),
      },
      { protocol: 'planner', reply: finalize },
      { protocol: 'lead', reply: finalText },
    );
    const initial = await execute((await create()).id);
    await approve(initial);
    const second = await execute(initial.id);
    const proposal = pending(second, 'delegate');
    expect(proposal.spawnedAgentIds).toEqual([]);
    expect(second.execution!.agents.filter((agent) => agent.agentId === 'reviewer')).toHaveLength(
      0,
    );
    expect(requests).toHaveLength(3);
    await approve(second);
    const done = await execute(initial.id);
    expect(done.status).toBe('succeeded');
    expect(
      done.execution!.agents.find((agent) => agent.agentId === 'reviewer')!.dependencies,
    ).toEqual([deliveryId!]);
    expect(requests).toHaveLength(6);
  });

  it('reuses the confirmed final invocation ledger after an interrupted worker, without any network replay', async () => {
    standardScript();
    const waiting = await execute((await create()).id);
    await approve(waiting);
    const done = await execute(waiting.id);
    expect(done.status).toBe('succeeded');
    const lead = done.execution!.agents.find((agent) => agent.role === 'lead')!;
    await db.query("UPDATE agent_runs SET status='running',result=NULL WHERE id=$1", [lead.id]);
    await db.getRepository(RunEntity).update(done.id, {
      status: 'running',
      output: null,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(0),
    });
    const recovered = await execute(done.id);
    expect(recovered).toMatchObject({ status: 'succeeded', attempts: 3, output: done.output });
    expect(recovered.execution!.invocations).toEqual(done.execution!.invocations);
    expect(recovered.execution!.collaboration).toEqual(done.execution!.collaboration);
    expect(recovered.execution!.usage.calls).toBe(4);
    expect(requests).toHaveLength(4);
  });

  it('validates owner, run/action binding and required explicit approval without mutating the pending plan', async () => {
    script({ protocol: 'planner', reply: delegate() }, { protocol: 'planner', reply: delegate() });
    const waiting = await execute((await create()).id);
    const plan = pending(waiting, 'delegate');
    const other = await execute((await create()).id);
    for (const approved of [undefined, null, 'true', 1]) {
      await expect(
        creation.respond(ownerId, waiting.id, plan.id, {
          answer: 'Proceed',
          ...(approved === undefined ? {} : { approved }),
        } as TeamResponse),
      ).rejects.toBeDefined();
    }
    await expect(
      creation.respond(ownerId, waiting.id, plan.id, { answer: 'Proceed' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      creation.respond(randomUUID(), waiting.id, plan.id, { answer: 'Proceed', approved: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(creation.get(randomUUID(), waiting.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      creation.respond(ownerId, waiting.id, randomUUID(), { answer: 'Proceed', approved: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      creation.respond(ownerId, other.id, plan.id, { answer: 'Proceed', approved: true }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await creation.get(ownerId, waiting.id)).toEqual(waiting);
    expect(requests).toHaveLength(2);
    await creation.cancel(ownerId, waiting.id);
    await creation.cancel(ownerId, other.id);
  });

  it('serializes conflicting simultaneous answers so exactly one response and one answer message are committed', async () => {
    script({ protocol: 'planner', reply: delegate() });
    const waiting = await execute((await create()).id);
    const plan = pending(waiting, 'delegate');
    const results = await Promise.allSettled([
      creation.respond(ownerId, waiting.id, plan.id, {
        answer: 'Proceed with the assignment',
        approved: true,
      }),
      creation.respond(ownerId, waiting.id, plan.id, {
        answer: 'Reject and reconsider the assignment',
        approved: false,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const queued = await creation.get(ownerId, waiting.id);
    expect(queued.status).toBe('queued');
    expect(queued.execution!.messages.filter((message) => message.kind === 'answer')).toHaveLength(
      1,
    );
    expect(actions(queued)[0]!.response).not.toBeNull();
    expect(queued.execution!.agents).toHaveLength(1);
    expect(requests).toHaveLength(1);
    await creation.cancel(ownerId, waiting.id);
  });

  it('requires boolean approval for confirmations and forbids approval fields on information questions', async () => {
    script(
      {
        protocol: 'planner',
        reply: { action: 'confirm', question: 'Do you approve the narrower scope?' },
      },
      {
        protocol: 'planner',
        reply: { action: 'ask_user', question: 'Which audience should we address?' },
      },
    );
    const confirmation = await execute((await create()).id);
    pending(confirmation, 'confirm');
    await expect(answer(confirmation, { answer: 'Narrow the scope' })).rejects.toMatchObject({
      status: 422,
    });
    expect(await creation.get(ownerId, confirmation.id)).toEqual(confirmation);
    await answer(confirmation, { answer: 'Narrow the scope', approved: true });
    const question = await execute(confirmation.id);
    pending(question, 'ask_user');
    for (const approved of [true, false]) {
      await expect(answer(question, { answer: 'Researchers', approved })).rejects.toMatchObject({
        status: 422,
      });
    }
    expect(await creation.get(ownerId, question.id)).toEqual(question);
    await answer(question, { answer: 'Researchers' });
    expect(requests).toHaveLength(2);
    await creation.cancel(ownerId, question.id);
  });

  it('retains unknown member charges and never retries the request or restarts planning automatically', async () => {
    handler = (body, response) => {
      if (requests.length === 1) {
        expect(protocol(body)).toBe('planner');
        success(response, JSON.stringify(delegate()));
      } else {
        expect(protocol(body)).toBe('member');
        response.destroy();
      }
    };
    const waiting = await execute((await create()).id);
    await approve(waiting);
    const unknown = await execute(waiting.id);
    expect(unknown).toMatchObject({
      status: 'needs_review',
      output: null,
      execution: { usage: { calls: 2, chargedTokens: 110, hasEstimatedUsage: true } },
    });
    expect(unknown.execution!.invocations.map((invocation) => invocation.status)).toEqual([
      'succeeded',
      'unknown',
    ]);
    expect(unknown.execution!.usage.reservedTokens).toBeGreaterThan(0);
    expect(unknown.execution!.agents.some((agent) => agent.role === 'lead')).toBe(false);
    expect((await execute(waiting.id)).revision).toBe(unknown.revision);
    expect((await execute(waiting.id)).revision).toBe(unknown.revision);
    expect(requests).toHaveLength(2);
  });

  it('cancels a durable waiting run and rejects a late answer without dispatching its proposed members', async () => {
    script({ protocol: 'planner', reply: delegate() });
    const waiting = await execute((await create()).id);
    const plan = pending(waiting, 'delegate');
    await expect(creation.cancel(randomUUID(), waiting.id)).rejects.toMatchObject({ status: 404 });
    const cancelled = await creation.cancel(ownerId, waiting.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      failureCode: 'CANCELLED',
      cancelRequested: true,
    });
    expect((await execute(waiting.id)).revision).toBe(cancelled.revision);
    await expect(
      creation.respond(ownerId, waiting.id, plan.id, {
        answer: 'Too late to approve',
        approved: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(actions(await creation.get(ownerId, waiting.id))[0]).toMatchObject({
      response: null,
      spawnedAgentIds: [],
    });
    expect(requests).toHaveLength(1);
  });

  it.each(['not-in-the-team', 'lead'])(
    'rejects an out-of-scope delegate target %s before member dispatch',
    async (memberId) => {
      script({ protocol: 'planner', reply: delegate(memberId) });
      const done = await execute((await create()).id);
      expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_MEMBER_OUT_OF_SCOPE' });
      expect(done.execution!.agents.map((agent) => agent.role)).toEqual(['planner']);
      expect(actions(done)).toEqual([]);
      expect(requests).toHaveLength(1);
      await execute(done.id);
      expect(requests).toHaveLength(1);
    },
  );

  it('rejects cyclic references to future task UUIDs atomically, before any proposed member can run', async () => {
    const futureWriter = randomUUID();
    const futureReviewer = randomUUID();
    script({
      protocol: 'planner',
      reply: {
        action: 'delegate',
        summary: 'A cyclic future proposal must not dispatch',
        tasks: [
          {
            memberId: 'writer',
            task: 'Depend on a future reviewer',
            dependencies: [futureReviewer],
          },
          { memberId: 'reviewer', task: 'Depend on a future writer', dependencies: [futureWriter] },
        ],
      },
    });
    const done = await execute((await create()).id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_INVALID_DEPENDENCY' });
    expect(done.execution!.agents).toHaveLength(1);
    expect(actions(done)).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('rejects a dependency on the planner itself, even though that UUID is an existing succeeded task', async () => {
    const run = await create();
    handler = async (_body, response) => {
      const rows: { id: string }[] = await db.query(
        "SELECT id FROM agent_runs WHERE run_id=$1 AND role='planner'",
        [run.id],
      );
      success(response, JSON.stringify(delegate('writer', [rows[0]!.id])));
    };
    const done = await execute(run.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_INVALID_DEPENDENCY' });
    expect(done.execution!.agents).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('does not finalize or spawn a lead summary without a real member delivery', async () => {
    script({ protocol: 'planner', reply: finalize });
    const done = await execute((await create()).id);
    expect(done).toMatchObject({
      status: 'failed',
      failureCode: 'TEAM_NO_DELIVERABLE',
      output: null,
    });
    expect(done.execution!.agents).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [
      'fenced JSON',
      '```json\n{"action":"ask_user","question":"Which source?"}\n```',
      'TEAM_PROTOCOL_INVALID',
    ],
    [
      'extra properties',
      '{"action":"ask_user","question":"Which source?","execute":true}',
      'TEAM_PROTOCOL_INVALID',
    ],
    ['planner impersonating a member', JSON.stringify(deliver()), 'TEAM_ACTION_NOT_ALLOWED'],
  ])('rejects %s without another model turn', async (_name, reply, failureCode) => {
    script({ protocol: 'planner', reply });
    const done = await execute((await create()).id);
    expect(done).toMatchObject({ status: 'failed', failureCode });
    expect(requests).toHaveLength(1);
  });

  it.each<TeamDirective>([
    { action: 'ask_user', question: 'May I ask another question?' },
    { action: 'request_peer', memberId: 'writer', question: 'Please ask somebody else?' },
  ])('restricts a peer answer to deliver rather than $action', async (reply) => {
    script(
      { protocol: 'planner', reply: delegate() },
      {
        protocol: 'member',
        reply: {
          action: 'request_peer',
          memberId: 'reviewer',
          question: 'Please verify the source?',
        },
      },
      { protocol: 'peer', reply },
    );
    const waiting = await execute((await create()).id);
    await approve(waiting);
    const done = await execute(waiting.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_ACTION_NOT_ALLOWED' });
    expect(done.execution!.agents.filter((agent) => agent.role === 'member')).toHaveLength(2);
    expect(requests).toHaveLength(3);
  });

  it.each([1, 2, 3])(
    'shares the %i-call budget across approved members, replanning and final lead synthesis',
    async (maxCalls) => {
      script(
        ...([
          { protocol: 'planner', reply: delegate() },
          { protocol: 'member', reply: deliver() },
          { protocol: 'planner', reply: finalize },
        ].slice(0, maxCalls) as Step[]),
      );
      const waiting = await execute((await create({ maxCalls })).id);
      await approve(waiting);
      const done = await execute(waiting.id);
      expect(done).toMatchObject({
        status: 'failed',
        failureCode: 'BUDGET_EXHAUSTED',
        output: null,
      });
      expect(done.execution!.usage).toMatchObject({
        calls: maxCalls,
        chargedTokens: 110 * maxCalls,
        reservedTokens: 0,
      });
      expect(done.execution!.invocations).toHaveLength(maxCalls);
      expect(requests).toHaveLength(maxCalls);
      await execute(waiting.id);
      expect(requests).toHaveLength(maxCalls);
    },
  );

  it('reserves the initial planner token budget before making any HTTP request', async () => {
    const done = await execute((await create({ maxTotalTokens: 2000 })).id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(done.execution!.usage).toMatchObject({ calls: 0, chargedTokens: 0, reservedTokens: 0 });
    expect(requests).toHaveLength(0);
  });

  it('retains charged planner tokens across approval and refuses an unaffordable member reservation', async () => {
    script({
      protocol: 'planner',
      reply: delegate(),
      usage: { prompt_tokens: 9500, completion_tokens: 100 },
    });
    const waiting = await execute((await create({ maxTotalTokens: 10000 })).id);
    pending(waiting, 'delegate');
    await approve(waiting);
    const done = await execute(waiting.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(done.execution!.usage).toMatchObject({
      calls: 1,
      chargedTokens: 9600,
      reservedTokens: 0,
    });
    expect(requests).toHaveLength(1);
  });

  it('stops after six real planner calls, not after three legitimate human resumes', async () => {
    script(
      ...Array.from({ length: 6 }, (_, index): Step => ({
        protocol: 'planner',
        reply: { action: 'ask_user', question: `Clarify question number ${index + 1}?` },
      })),
    );
    const run = await create();
    for (let index = 0; index < 6; index++) {
      const waiting = await execute(run.id);
      pending(waiting, 'ask_user');
      await answer(waiting, { answer: `Answer number ${index + 1}` });
    }
    const done = await execute(run.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_PLAN_LIMIT', attempts: 7 });
    expect(done.execution!.agents.filter((agent) => agent.role === 'planner')).toHaveLength(6);
    expect(actions(done)).toHaveLength(6);
    expect(requests).toHaveLength(6);
  });

  it('allows four actual peer calls but cannot dispatch a fifth peer or a synthetic follow-up', async () => {
    const askPeer: TeamDirective = {
      action: 'request_peer',
      memberId: 'reviewer',
      question: 'Please independently verify this point?',
    };
    const expected: Step[] = [
      { protocol: 'planner', reply: delegate() },
      { protocol: 'member', reply: askPeer },
    ];
    for (let index = 0; index < 4; index++) {
      expected.push({ protocol: 'peer', reply: deliver(`Peer answer ${index + 1}`) });
      expected.push({ protocol: 'member', reply: askPeer });
    }
    script(...expected);
    const waiting = await execute((await create()).id);
    await approve(waiting);
    const done = await execute(waiting.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_PEER_LIMIT' });
    expect(
      actions(done).filter((action) => action.directive.action === 'request_peer'),
    ).toHaveLength(4);
    expect(requests.filter((body) => protocol(body) === 'peer')).toHaveLength(4);
    expect(done.execution!.agents.filter((agent) => agent.role === 'member')).toHaveLength(9);
    expect(requests).toHaveLength(10);
  });

  it('shares the eight-interaction ceiling between delegate approval and repeated member questions', async () => {
    script(
      { protocol: 'planner', reply: delegate() },
      ...Array.from({ length: 8 }, (_, index): Step => ({
        protocol: 'member',
        reply: { action: 'ask_user', question: `Supply source number ${index + 1}?` },
      })),
    );
    let waiting = await execute((await create()).id);
    pending(waiting, 'delegate');
    await approve(waiting);
    for (let index = 0; index < 7; index++) {
      waiting = await execute(waiting.id);
      pending(waiting, 'ask_user');
      await answer(waiting, { answer: `Verified source number ${index + 1}` });
    }
    const done = await execute(waiting.id);
    expect(done).toMatchObject({
      status: 'failed',
      failureCode: 'TEAM_INTERACTION_LIMIT',
      attempts: 9,
    });
    expect(actions(done)).toHaveLength(8);
    expect(actions(done).every((action) => action.state === 'applied')).toBe(true);
    expect(done.execution!.agents.filter((agent) => agent.role === 'planner')).toHaveLength(1);
    expect(requests).toHaveLength(9);
  });

  it('permits 24 real member tasks across approved plans but refuses a proposal for task 25 atomically', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `member-${index}`);
    const selected = await catalog.createExpert(ownerId, {
      ...definition,
      team: {
        leadAgent: 'lead',
        members: ['lead', ...ids].map((id) => ({
          agentId: id,
          name: id,
          description: 'Independent member',
          instructions: 'Deliver a concise finding',
          skillKeys: [],
        })),
      },
    });
    const expected: Step[] = [];
    for (const [round, batch] of [ids, ids, ids.slice(0, 2)].entries()) {
      expected.push({
        protocol: 'planner',
        reply: {
          action: 'delegate',
          summary: `Approve independent batch ${round + 1}`,
          tasks: batch.map((memberId) => ({
            memberId,
            task: `Delivery for batch ${round + 1}`,
            dependencies: [],
          })),
        },
      });
      expected.push(
        ...batch.map((id): Step => ({
          protocol: 'member',
          reply: deliver(`Finding from ${id} in batch ${round + 1}`),
        })),
      );
    }
    expected.push({ protocol: 'planner', reply: delegate(ids[0]!) });
    script(...expected);
    const run = await create({ maxCalls: 100, maxTotalTokens: 1000000 }, selected);
    for (let round = 0; round < 3; round++) {
      const waiting = await execute(run.id);
      pending(waiting, 'delegate');
      await approve(waiting);
    }
    const done = await execute(run.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'TEAM_TASK_LIMIT' });
    const members = done.execution!.agents.filter((agent) => agent.role === 'member');
    expect(members).toHaveLength(24);
    expect(members.every((agent) => agent.status === 'succeeded')).toBe(true);
    expect(actions(done).filter((action) => action.directive.action === 'delegate')).toHaveLength(
      3,
    );
    expect(requests).toHaveLength(28);
    expect(done.execution!.usage).toMatchObject({ calls: 28, reservedTokens: 0 });
  });
});
