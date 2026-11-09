import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function readCompletedRun(response, runId) {
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    await response.body?.cancel();
    throw new Error('The gateway did not return an authenticated SSE stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE ended before the task completed.');
      bytes += chunk.value.length;
      if (bytes > 1000000) throw new Error('Smoke SSE response exceeded its size limit.');
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const lines = buffer.slice(0, boundary).split('\n');
        buffer = buffer.slice(boundary + 2);
        const event = lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        if (event === 'session.expired' || event === 'stream.unavailable') {
          throw new Error(`SSE reported ${event}.`);
        }
        if (event !== 'run.snapshot') continue;
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        const run = JSON.parse(data);
        assert.equal(run.id, runId);
        if (run.status === 'failed') throw new Error('The mock task failed.');
        if (run.status === 'succeeded') return run;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class SmokeClient {
  constructor(origin, signal) {
    const url = new URL(origin);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.origin !== origin ||
      !url.port
    ) {
      throw new Error('Smoke HTTP requests must use the allocated loopback origin.');
    }
    this.origin = origin;
    this.signal = signal;
    this.headers = { Origin: origin, 'Content-Type': 'application/json' };
  }

  timeout(milliseconds) {
    const timeout = AbortSignal.timeout(milliseconds);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  async request(path, { method = 'GET', body, status = 200, headers = {} } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid smoke API path.');
    const response = await fetch(`${this.origin}/api/v1${path}`, {
      method,
      headers: { ...this.headers, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: this.timeout(10000),
    });
    if (response.status !== status) {
      await response.body?.cancel();
      throw new Error(`${method} ${path}: expected HTTP ${status}, received ${response.status}.`);
    }
    const envelope = await response.json();
    assert.equal(typeof envelope.requestId, 'string');
    assert.equal(envelope.requestId, response.headers.get('x-request-id'));
    if (status >= 400) assert.equal(typeof envelope.error?.code, 'string');
    return { data: envelope.data, response };
  }

  async verifyShell() {
    const response = await fetch(this.origin, { signal: this.timeout(10000), redirect: 'error' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const html = await response.text();
    const script = /src="(\/assets\/[^"?#]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'The built frontend must reference a bundled script.');
    const bundle = await fetch(`${this.origin}${script}`, {
      signal: this.timeout(10000),
      redirect: 'error',
    });
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    await bundle.body.cancel();
    const { data } = await this.request('/health/ready');
    assert.deepEqual(data, { status: 'ok', modelMode: 'mock' });
    await this.request('/accounts', { status: 401 });
  }

  async login(username, secret) {
    const { data, response } = await this.request('/auth/login', {
      method: 'POST',
      body: { username, password: secret },
    });
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie ?? '', /HttpOnly/i);
    assert.match(cookie ?? '', /SameSite=Strict/i);
    this.headers.Cookie = cookie.split(';')[0];
    this.headers['X-CSRF-Token'] = data.csrfToken;
    return [this.headers.Cookie, this.headers.Cookie.split('=')[1], data.csrfToken];
  }

  async createFixtures() {
    const accountInput = {
      name: 'Docker smoke account',
      platform: 'wechat',
      audience: 'Test readers',
      persona: 'Use precise, plain language.',
    };
    const expertInput = {
      name: 'Docker smoke expert',
      description: 'Isolated verification only.',
      instructions: 'Do not invent facts.',
      skillKeys: ['article-outline', 'plain-writing'],
    };
    await this.request('/accounts', {
      method: 'POST',
      body: accountInput,
      status: 403,
      headers: { Origin: 'https://invalid.example' },
    });
    await this.request('/accounts', {
      method: 'POST',
      body: accountInput,
      status: 403,
      headers: { 'X-CSRF-Token': '' },
    });
    const { data: account } = await this.request('/accounts', {
      method: 'POST',
      status: 201,
      body: accountInput,
    });
    const { data: expert } = await this.request('/experts', {
      method: 'POST',
      status: 201,
      body: expertInput,
    });
    const input = {
      accountId: account.id,
      expertId: expert.id,
      topic: 'Docker mock verification',
      brief: 'No external calls.',
    };
    const key = randomUUID();
    const submissions = await Promise.all(
      Array.from({ length: 3 }, () => this.createRun(input, key)),
    );
    const run = submissions[0];
    assert.ok(
      submissions.every((row) => row.id === run.id),
      'Concurrent submissions must deduplicate.',
    );
    await this.request('/creation-runs', {
      method: 'POST',
      status: 409,
      body: { ...input, topic: 'Conflicting submission' },
      headers: { 'Idempotency-Key': key },
    });
    const completed = await this.completed(run.id);
    assert.equal(completed.output?.isMock, true);
    assert.equal(completed.output?.reviewStatus, 'pending_review');
    assert.equal(completed.output?.document?.type, 'doc');
    assert.equal(completed.attempts, 1);
    const { data: updated } = await this.request(`/experts/${expert.id}/versions?baseVersion=1`, {
      method: 'POST',
      status: 201,
      body: { ...expertInput, instructions: 'Version two: ask for sources.' },
    });
    assert.equal(updated.version, 2);
    await this.request(`/experts/${expert.id}/versions?baseVersion=1`, {
      method: 'POST',
      status: 409,
      body: expertInput,
    });
    return { account, expert: updated, input, completed };
  }

  async createRun(input, key = randomUUID()) {
    return (
      await this.request('/creation-runs', {
        method: 'POST',
        status: 202,
        body: input,
        headers: { 'Idempotency-Key': key },
      })
    ).data;
  }

  async completed(runId) {
    const response = await fetch(`${this.origin}/api/v1/creation-runs/${runId}/events`, {
      headers: { ...this.headers, Accept: 'text/event-stream' },
      signal: this.timeout(60000),
      redirect: 'error',
    });
    return readCompletedRun(response, runId);
  }

  async verifyPersistence(fixtures, queued) {
    await this.request('/auth/session');
    const { data: accounts } = await this.request('/accounts');
    assert.deepEqual(accounts.items, [fixtures.account]);
    const { data: experts } = await this.request('/experts');
    assert.deepEqual(experts.items, [fixtures.expert]);
    const { data: completed } = await this.request(`/creation-runs/${fixtures.completed.id}`);
    assert.deepEqual(completed, fixtures.completed);
    assert.equal(completed.snapshot.expert.version, 1);
    const { data: pending } = await this.request(`/creation-runs/${queued.id}`);
    assert.equal(pending.status, 'queued');
    assert.equal(pending.attempts, 0);
    assert.equal(pending.snapshot.expert.version, 2);
  }

  async logout() {
    await this.request('/auth/logout', { method: 'POST', body: {} });
    await this.request('/auth/session', { status: 401 });
  }
}
