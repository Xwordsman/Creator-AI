import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ModelCheck, ModelConnection, SessionInfo } from '@creator-ai/contracts';
import { createDataSource } from '../src/database/data-source';
import { createAdmin } from '../src/modules/auth/bootstrap';
import { bootstrapApi } from '../src/main-api';
import { ModelService } from '../src/modules/models/model.service';
import { ModelCheckService } from '../src/modules/models/model-check.service';
import { CompatibleProvider } from '../src/modules/models/compatible-provider';
import { UserEntity } from '../src/database/entities';

describe('Model checks: durable single dispatch, local HTTP only', () => {
  let db: DataSource, app: INestApplication, server: Server, base: string;
  let owner: string,
    other: string,
    model: ModelConnection,
    models: ModelService,
    checks: ModelCheckService;
  let headers: Record<string, string>, handler: (res: ServerResponse) => void;
  let requests: Record<string, unknown>[], fixtureError: unknown;
  const origin = 'http://127.0.0.1:5187',
    savedEnv = { ...process.env };
  const send = (res: ServerResponse, content = '{"ok":true}') =>
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        id: 'fixture',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 37, completion_tokens: 5 },
      }),
    );
  const http = (path = '', body?: unknown, key: string = randomUUID(), extra = headers) =>
    fetch(`${base}/models/${model.id}/checks${path}`, {
      headers: { ...extra, 'Idempotency-Key': key },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
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
      throw new Error('Dedicated test database and Redis DB15 required');
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        handler(res);
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
    await createAdmin(db, 'model-check-test', secret);
    app = await bootstrapApi(0);
    base = `${await app.getUrl()}/api/v1`.replace('0.0.0.0', '127.0.0.1');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'model-check-test', ['pass' + 'word']: secret }),
    });
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
      username: 'other-check-test',
      passwordHash: 'unused',
      createdAt: new Date(),
    });
    models = new ModelService(db);
    checks = new ModelCheckService(db);
    model = await models.create(owner, {
      name: 'Local fixture only',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'fixture',
      apiKey: 'not-a-real-secret',
      tokenParameter: 'max_tokens',
      maxInputTokens: 16000,
      maxOutputTokens: 4096,
    });
  });
  beforeEach(async () => {
    await db.query('TRUNCATE model_checks');
    await models.setEnabled(owner, model.id, true);
    requests = [];
    fixtureError = undefined;
    handler = send;
  });
  afterEach(() => expect(fixtureError).toBeUndefined());
  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db?.isInitialized) await db.destroy();
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'APP_ORIGIN',
      'NODE_ENV',
      'MODEL_MODE',
      'MODEL_ENCRYPTION_KEY',
      'MODEL_ALLOWED_HOSTS',
      'MODEL_ALLOW_LOCAL',
    ]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });
  it('requires confirmation, key, owner and CSRF; opening history never dispatches', async () => {
    expect((await http()).status).toBe(200);
    expect((await http('', {})).status).toBe(400);
    expect((await http('', { confirm: true, message: 'private' })).status).toBe(400);
    expect((await http('', { confirm: true }, 'short')).status).toBe(400);
    const withoutCsrf = { ...headers };
    delete withoutCsrf['X-CSRF-Token'];
    expect((await http('', { confirm: true }, randomUUID(), withoutCsrf)).status).toBe(403);
    await expect(checks.list(other, model.id)).rejects.toMatchObject({ status: 404 });
    await expect(checks.create(other, model.id, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    expect(requests).toHaveLength(0);
  });
  it('sends a fixed bounded prompt once and replays across service instances', async () => {
    const key = randomUUID();
    const response = await http('', { confirm: true }, key);
    expect(response.status).toBe(200);
    const result = ((await response.json()) as { data: ModelCheck }).data;
    expect(result).toMatchObject({
      status: 'passed',
      failureCode: null,
      inputTokens: 37,
      outputTokens: 5,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'fixture', max_tokens: 256, stream: false });
    expect(requests[0]).not.toHaveProperty('tools');
    expect(JSON.stringify(requests[0])).not.toContain('not-a-real-secret');
    expect((await new ModelCheckService(db).create(owner, model.id, key)).id).toBe(result.id);
    expect(requests).toHaveLength(1);
    expect(await db.query('SELECT id FROM creation_runs')).toHaveLength(0);
    expect(JSON.stringify(await checks.list(owner, model.id))).not.toContain('not-a-real-secret');
  });
  it('serializes identical and competing requests before a single dispatch', async () => {
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      handler = (res) => {
        finish = () => {
          send(res);
        };
        resolve();
      };
    });
    const key = randomUUID(),
      original = checks.create(owner, model.id, key);
    await entered;
    expect((await checks.create(owner, model.id, key)).status).toBe('running');
    await expect(checks.create(owner, model.id, randomUUID())).rejects.toMatchObject({
      status: 409,
    });
    finish();
    expect((await original).status).toBe('passed');
    expect(requests).toHaveLength(1);
  });
  it('does not send a disabled connection or reuse a key for a different model', async () => {
    const key = randomUUID();
    await checks.create(owner, model.id, key);
    const second = await models.create(owner, {
      name: 'Other',
      baseUrl: model.baseUrl,
      model: 'other',
      apiKey: 'unused',
      tokenParameter: 'max_tokens',
      maxInputTokens: 16000,
      maxOutputTokens: 4096,
    });
    await expect(checks.create(owner, second.id, key)).rejects.toMatchObject({ status: 409 });
    await models.setEnabled(owner, model.id, false);
    await expect(checks.create(owner, model.id, randomUUID())).rejects.toMatchObject({
      status: 422,
    });
    expect((await checks.create(owner, model.id, key)).status).toBe('passed');
    expect(requests).toHaveLength(1);
  });
  it('preserves known provider rejection without copying a sensitive response body', async () => {
    handler = (res) => {
      res.writeHead(401).end('sensitive provider details');
    };
    const check = await checks.create(owner, model.id, randomUUID());
    expect(check).toMatchObject({ status: 'failed', failureCode: 'PROVIDER_HTTP_401' });
    expect(JSON.stringify(check)).not.toContain('sensitive');
    expect(requests).toHaveLength(1);
  });
  it('records invalid JSON as a completed billed call without correction retries', async () => {
    handler = (res) => {
      send(res, 'Here is a lovely article.');
    };
    const check = await checks.create(owner, model.id, randomUUID());
    expect(check).toMatchObject({
      status: 'failed',
      failureCode: 'MODEL_CHECK_INVALID_OUTPUT',
      inputTokens: 37,
    });
    expect(requests).toHaveLength(1);
  });
  it('persists unknown on disconnect, blocks new calls, and keeps immutable reconciliation', async () => {
    handler = (res) => {
      res.destroy();
    };
    const key = randomUUID(),
      check = await checks.create(owner, model.id, key);
    expect(check.status).toBe('unknown');
    expect((await checks.create(owner, model.id, key)).id).toBe(check.id);
    await expect(checks.create(owner, model.id, randomUUID())).rejects.toMatchObject({
      status: 409,
    });
    const note = 'Checked provider history; result remains uncertain.';
    await expect(checks.resolve(other, model.id, check.id, note)).rejects.toMatchObject({
      status: 404,
    });
    expect((await http(`/${check.id}/reconcile`, { note: 'short' })).status).toBe(400);
    const response = await http(`/${check.id}/reconcile`, { note });
    expect(response.status).toBe(200);
    const resolved = ((await response.json()) as { data: ModelCheck }).data;
    expect(resolved.status).toBe('unknown');
    expect(resolved.resolvedAt).not.toBeNull();
    expect((await checks.resolve(owner, model.id, check.id, note)).resolvedAt).toBe(
      resolved.resolvedAt,
    );
    await expect(
      checks.resolve(owner, model.id, check.id, 'Another explanation cannot overwrite it.'),
    ).rejects.toMatchObject({ status: 409 });
    expect(requests).toHaveLength(1);
    handler = send;
    expect((await checks.create(owner, model.id, randomUUID())).status).toBe('passed');
  });
  it('expires interrupted dispatches without resending or accepting late replies', async () => {
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      handler = (res) => {
        finish = () => {
          send(res);
        };
        resolve();
      };
    });
    const key = randomUUID(),
      original = checks.create(owner, model.id, key);
    await entered;
    await db.query("UPDATE model_checks SET expires_at=now()-interval '1 second'");
    expect((await checks.list(owner, model.id))[0]).toMatchObject({
      status: 'unknown',
      failureCode: 'MODEL_CHECK_EXPIRED',
    });
    finish();
    expect((await original).status).toBe('unknown');
    expect((await checks.create(owner, model.id, key)).status).toBe('unknown');
    expect(requests).toHaveLength(1);
  });
  it('does not dispatch if its durable intent expires during preparation', async () => {
    const prepare = CompatibleProvider.prototype.prepare;
    const spy = jest
      .spyOn(CompatibleProvider.prototype, 'prepare')
      .mockImplementation(async function (this: CompatibleProvider, snapshot) {
        const target = await prepare.call(this, snapshot);
        await db.query("UPDATE model_checks SET expires_at=now()-interval '1 second'");
        return target;
      });
    try {
      expect(await checks.create(owner, model.id, randomUUID())).toMatchObject({
        status: 'failed',
        failureCode: 'MODEL_CHECK_INTERRUPTED',
      });
      expect(requests).toHaveLength(0);
      expect((await db.query('SELECT dispatched FROM model_checks'))[0].dispatched).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it('expires a pre-dispatch interruption as failed and lists a bounded recent history', async () => {
    for (let i = 0; i < 12; i++)
      await db.query(
        "INSERT INTO model_checks(id,owner_id,model_id,idempotency_key,status) VALUES($1,$2,$3,$4,'failed')",
        [randomUUID(), owner, model.id, randomUUID()],
      );
    const id = randomUUID();
    await db.query(
      "INSERT INTO model_checks(id,owner_id,model_id,idempotency_key,status,expires_at) VALUES($1,$2,$3,$4,'running',now()-interval '1 second')",
      [id, owner, model.id, randomUUID()],
    );
    const history = await checks.list(owner, model.id);
    expect(history).toHaveLength(10);
    expect(history.find((c) => c.id === id)).toMatchObject({
      status: 'failed',
      failureCode: 'MODEL_CHECK_INTERRUPTED',
    });
    expect(requests).toHaveLength(0);
  });
});
