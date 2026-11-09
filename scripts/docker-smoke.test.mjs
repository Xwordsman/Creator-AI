import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertComposeVersion,
  assertIsolatedConfig,
  assertLocalEndpoint,
  createIdentity,
  redact,
  runProcess,
} from './lib/docker-smoke.mjs';

function fixture() {
  const identity = createIdentity();
  const port = 18080;
  const app = {
    image: identity.serverImage,
    networks: { private: null },
    environment: { MODEL_MODE: 'mock', APP_ORIGIN: `http://127.0.0.1:${port}` },
  };
  const config = {
    name: identity.project,
    services: {
      api: structuredClone(app),
      worker: structuredClone(app),
      gateway: {
        image: identity.webImage,
        ports: [{ host_ip: '127.0.0.1', published: String(port), target: 80, protocol: 'tcp' }],
      },
      database: {
        volumes: [{ type: 'volume', source: 'database_data', target: '/var/lib/postgresql/data' }],
      },
      redis: {},
    },
    volumes: { database_data: { name: `${identity.project}_database_data` } },
    networks: {
      private: { name: `${identity.project}_private`, internal: true },
      public: { name: `${identity.project}_public` },
    },
  };
  return { identity, port, config };
}

test('smoke identities are fresh and do not reuse application image tags', () => {
  const first = createIdentity();
  const second = createIdentity();
  assert.match(first.project, /^creator-ai-smoke-[a-f0-9]{12}$/);
  assert.notEqual(first.project, second.project);
  assert.equal(first.serverImage, `${first.project}-server:local`);
  assert.ok(/^[a-f0-9]{64}$/.test(first.adminSecret));
  assert.ok(/^[a-f0-9]{64}$/.test(first.databaseSecret));
  assert.ok(first.adminSecret !== first.databaseSecret);
});

test('requires Compose support for !override rather than merging production ports', () => {
  for (const version of ['v2.24.4', '2.39.0', '2.24.4-desktop.1', '3.0.0'])
    assertComposeVersion(version);
  for (const version of ['2.24.3', '2.23.9', '1.29.2', 'not-a-version'])
    assert.throws(() => assertComposeVersion(version), /Compose/);
});

test('accepts local Docker sockets and refuses remote/TCP endpoints', () => {
  for (const endpoint of [
    'unix:///var/run/docker.sock',
    'npipe:////./pipe/dockerDesktopLinuxEngine',
  ])
    assertLocalEndpoint(endpoint);
  for (const endpoint of [
    'ssh://server',
    'tcp://127.0.0.1:2375',
    'https://server',
    'npipe:////server/pipe/docker_engine',
  ])
    assert.throws(() => assertLocalEndpoint(endpoint), /local/);
});

test('allows only a fresh isolated Compose project with a loopback gateway', () => {
  const { config, identity, port } = fixture();
  assertIsolatedConfig(config, identity, port);
});

test('rejects inherited production ports, public bindings and published database ports', () => {
  for (const mutate of [
    (c) => c.services.gateway.ports.push({ target: 443, published: '443' }),
    (c) => {
      c.services.gateway.ports[0].host_ip = '0.0.0.0';
    },
    (c) => {
      c.services.gateway.ports[0].published = '80';
    },
    (c) => {
      c.services.database.ports = [{ target: 5432 }];
    },
  ]) {
    const { config, identity, port } = fixture();
    mutate(config);
    assert.throws(() => assertIsolatedConfig(config, identity, port), /isolation/);
  }
});

test('rejects existing resource names, external volumes and non-project images', () => {
  for (const mutate of [
    (c) => {
      c.name = 'creator-ai';
    },
    (c) => {
      c.services.worker.image = 'creator-ai-server:0.0.1';
    },
    (c) => {
      c.volumes.database_data.name = 'production_data';
    },
    (c) => {
      c.volumes.database_data.external = true;
    },
    (c) => {
      c.networks.private.external = true;
    },
    (c) => {
      c.networks.private.internal = false;
    },
  ]) {
    const { config, identity, port } = fixture();
    mutate(config);
    assert.throws(() => assertIsolatedConfig(config, identity, port), /isolation/);
  }
});

test('rejects host mounts, fixed containers, env files and non-mock application networking', () => {
  for (const mutate of [
    (c) => {
      c.services.api.volumes = [{ type: 'bind', source: '/var/run/docker.sock' }];
    },
    (c) => {
      c.services.api.container_name = 'shared-api';
    },
    (c) => {
      c.services.api.privileged = true;
    },
    (c) => {
      c.services.api.env_file = ['.env'];
    },
    (c) => {
      c.services.api.networks = { public: null, private: null };
    },
    (c) => {
      c.services.api.networks = { private: null, model_egress: null };
    },
    (c) => {
      c.services.worker.networks = { private: null, model_egress: null };
    },
    (c) => {
      c.services.api.environment.MODEL_MODE = 'real';
    },
  ]) {
    const { config, identity, port } = fixture();
    mutate(config);
    assert.throws(() => assertIsolatedConfig(config, identity, port), /isolation/);
  }
});

test('redacts credentials without mutating the caller list', () => {
  const values = ['test-key', 'test-key-long', ''];
  assert.equal(redact('test-key-long / test-key', values), '[redacted] / [redacted]');
  assert.deepEqual(values, ['test-key', 'test-key-long', '']);
});

test('process runner passes arguments without a shell and captures failures', async () => {
  const text = 'literal & echo not-a-command';
  const result = await runProcess(process.execPath, [
    '-e',
    'console.log(process.argv[1]); process.exitCode=3',
    text,
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), text);
});

test('process runner times out instead of leaving a helper running', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 50 }),
    /timed out/,
  );
});

test('an aborted operation does not prevent a subsequent independent cleanup command', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  const result = await runProcess(process.execPath, ['-e', 'console.log("cleanup")']);
  assert.equal(result.stdout.trim(), 'cleanup');
});
