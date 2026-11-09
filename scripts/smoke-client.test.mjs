import assert from 'node:assert/strict';
import test from 'node:test';
import { readCompletedRun, SmokeClient } from './lib/smoke-client.mjs';

function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7)
          controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('HTTP smoke client refuses public origins or an implicit default port', () => {
  for (const origin of [
    'http://127.0.0.1',
    'https://example.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000/path',
  ])
    assert.throws(() => new SmokeClient(origin), /loopback/);
  assert.equal(new SmokeClient('http://127.0.0.1:18080').origin, 'http://127.0.0.1:18080');
});

test('SSE reader handles partial UTF-8, CRLF, heartbeats and task revisions', async () => {
  const run = { id: 'test-run', status: 'succeeded', output: { title: '\u8349\u7a3f' } };
  const response = stream(
    `: connected\r\n\r\nevent: heartbeat\r\ndata: {}\r\n\r\nevent: run.snapshot\r\ndata: {"id":"test-run","status":"queued"}\r\n\r\nevent: run.snapshot\r\ndata: ${JSON.stringify(run)}\r\n\r\n`,
  );
  assert.deepEqual(await readCompletedRun(response, run.id), run);
});

test('SSE reader rejects task failure, session expiry and unavailable streams', async () => {
  await assert.rejects(
    readCompletedRun(
      stream('event: run.snapshot\ndata: {"id":"run","status":"failed"}\n\n'),
      'run',
    ),
    /task failed/,
  );
  for (const name of ['session.expired', 'stream.unavailable'])
    await assert.rejects(
      readCompletedRun(stream(`event: ${name}\ndata: {}\n\n`), 'run'),
      /SSE reported/,
    );
});

test('SSE reader does not accept premature EOF or a different task', async () => {
  await assert.rejects(
    readCompletedRun(stream('event: heartbeat\ndata: {}\n\n'), 'run'),
    /before the task completed/,
  );
  await assert.rejects(
    readCompletedRun(
      stream('event: run.snapshot\ndata: {"id":"other","status":"succeeded"}\n\n'),
      'run',
    ),
    { name: 'AssertionError' },
  );
});

test('SSE reader bounds response size and requires event-stream content', async () => {
  await assert.rejects(readCompletedRun(new Response('not SSE'), 'run'), /authenticated SSE/);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1000001));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  await assert.rejects(readCompletedRun(response, 'run'), /size limit/);
});

test('HTTP checks include origin, disable redirects and validate request envelopes', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18080/api/v1/accounts');
    assert.equal(options.headers.Origin, 'http://127.0.0.1:18080');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(
      { data: { items: [] }, requestId: 'request-1' },
      { headers: { 'X-Request-Id': 'request-1' } },
    );
  });
  const result = await new SmokeClient('http://127.0.0.1:18080').request('/accounts');
  assert.deepEqual(result.data, { items: [] });
});

test('HTTP failures do not expose response bodies or credentials', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('do-not-print-this-secret', { status: 500 }),
  );
  await assert.rejects(new SmokeClient('http://127.0.0.1:18080').request('/accounts'), (error) => {
    assert.match(error.message, /expected HTTP 200, received 500/);
    assert.ok(!error.message.includes('do-not-print'));
    return true;
  });
});

test('HTTP timeouts preserve user cancellation', () => {
  const controller = new AbortController();
  const client = new SmokeClient('http://127.0.0.1:18080', controller.signal);
  const signal = client.timeout(10000);
  controller.abort();
  assert.equal(signal.aborted, true);
});
