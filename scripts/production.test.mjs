import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertProductionCompose,
  createProductionConfig,
  parseProductionEnv,
  productionProcessEnv,
  readProductionEnv,
  validateProductionConfig,
  writeProductionEnv,
} from './lib/production.mjs';
import { createProductionOperator, sha256File } from './lib/production-operations.mjs';

function config() {
  return createProductionConfig({
    origin: 'https://creator.example.com',
    modelHosts: 'api.example.com,models.example.com:8443',
  });
}

function renderedConfig(config) {
  const app = {
    environment: {
      NODE_ENV: 'production',
      APP_ORIGIN: config.APP_ORIGIN,
      MODEL_MODE: config.MODEL_MODE,
      MODEL_ENCRYPTION_KEY: config.MODEL_ENCRYPTION_KEY,
      MODEL_ALLOWED_HOSTS: config.MODEL_ALLOWED_HOSTS,
      DATABASE_URL: `postgres://creator:${config.DB_PASSWORD}@database:5432/creator`,
      REDIS_URL: 'redis://redis:6379/0',
    },
    networks: { private: null, model_egress: null },
    read_only: true,
    cap_drop: ['ALL'],
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  };
  return {
    name: config.COMPOSE_PROJECT_NAME,
    services: {
      api: structuredClone(app),
      worker: structuredClone(app),
      gateway: {
        environment: { SITE_ADDRESS: config.SITE_ADDRESS },
        logging: structuredClone(app.logging),
        ports: [80, 443].map((port) => ({
          target: port,
          published: String(port),
          protocol: 'tcp',
        })),
      },
      database: { logging: structuredClone(app.logging) },
      redis: { logging: structuredClone(app.logging) },
    },
    networks: {
      private: { internal: true, name: `${config.COMPOSE_PROJECT_NAME}_private` },
      model_egress: { name: `${config.COMPOSE_PROJECT_NAME}_model_egress` },
      public: { name: `${config.COMPOSE_PROJECT_NAME}_public` },
    },
    volumes: Object.fromEntries(
      ['database_data', 'redis_data', 'caddy_data', 'caddy_config'].map((name) => [
        name,
        { name: `${config.COMPOSE_PROJECT_NAME}_${name}` },
      ]),
    ),
  };
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'creator-ai-production-test-'));
  const absolute = resolve(directory);
  t.after(async () => {
    assert.equal(resolve(absolute, '..'), resolve(tmpdir()));
    assert.match(absolute.split(/[\\/]/).at(-1), /^creator-ai-production-test-/);
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}

test('production init creates distinct fixed secrets and configured model capability without credentials', () => {
  const first = config();
  const second = config();
  assert.match(first.DB_PASSWORD, /^[a-f0-9]{64}$/);
  assert.match(first.MODEL_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  assert.notEqual(first.DB_PASSWORD, first.MODEL_ENCRYPTION_KEY);
  assert.notEqual(first.MODEL_ENCRYPTION_KEY, second.MODEL_ENCRYPTION_KEY);
  assert.equal(first.MODEL_MODE, 'configured');
  assert.equal(first.SITE_ADDRESS, 'creator.example.com');
  assert.equal(
    Object.keys(first).some((key) => /API_KEY|ADMIN_PASSWORD/.test(key)),
    false,
  );
});

test('production init refuses unsuitable origins and mismatched proxy configuration', () => {
  for (const origin of [
    'http://creator.example.com',
    'https://creator.example.com/',
    'https://creator.example.com/path',
    'https://creator.example.com?query=1',
    'https://user@creator.example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://creator.example.com:8443',
    'https://server.local',
  ])
    assert.throws(() => createProductionConfig({ origin, modelHosts: 'api.example.com' }));
  for (const change of [
    { SITE_ADDRESS: 'other.example.com' },
    { HTTPS_PORT: '8443' },
    { MODEL_MODE: 'mock' },
    { COMPOSE_PROJECT_NAME: '../other' },
  ])
    assert.throws(() => validateProductionConfig({ ...config(), ...change }));
});

test('production model hosts are exact DNS authorities, never URLs or wildcard/private names', () => {
  for (const modelHosts of [
    '',
    'https://api.example.com',
    '*.example.com',
    'api.example.com/v1',
    'api.example.com:0',
    'api.example.com:65536',
    '127.0.0.1:3000',
    'localhost',
    'server.internal',
    'api.example.com, api.example.com',
    'api.example.com,api.example.com',
    'api.example.com$INJECTED',
    'API.example.com',
  ])
    assert.throws(() =>
      createProductionConfig({ origin: 'https://creator.example.com', modelHosts }),
    );
});

test('production env parser rejects shell interpolation, unsupported overrides and duplicate keys', () => {
  const valid = config();
  const text = Object.entries(valid)
    .map(([key, value]) => `${key}=${value}`)
    .join('\r\n');
  assert.deepEqual(parseProductionEnv(`\uFEFF# configuration\r\n${text}\r\n`), valid);
  for (const suffix of [
    '\nMODEL_MODE=mock',
    '\nMODEL_ALLOW_LOCAL=true',
    '\nEXTRA=$(echo leak)',
    '\nexport MODEL_MODE=configured',
  ])
    assert.throws(() => parseProductionEnv(text + suffix));
  assert.throws(() => parseProductionEnv(text.replace(valid.DB_PASSWORD, '"secret"')));
});

test('init refuses to overwrite an existing deployment key or .env.production', async (t) => {
  const root = await temporary(t);
  const path = join(root, '.env.production');
  const first = config();
  await writeProductionEnv(path, first);
  const bytes = await readFile(path, 'utf8');
  assert.deepEqual(await readProductionEnv(path), first);
  await assert.rejects(writeProductionEnv(path, config()), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('production Compose ignores deployment, preview and admin variables inherited from the shell', () => {
  assert.deepEqual(
    productionProcessEnv({
      PATH: 'tools',
      DOCKER_CONTEXT: 'trusted-server',
      APP_ORIGIN: 'http://localhost:5173',
      COMPOSE_FILE: 'compose.dev.yaml',
      COMPOSE_PROJECT_NAME: 'other',
      DB_PASSWORD: 'stale',
      ADMIN_PASSWORD: 'private',
      MODEL_ALLOW_LOCAL: 'true',
      MODEL_ENCRYPTION_KEY: 'stale',
    }),
    { PATH: 'tools', DOCKER_CONTEXT: 'trusted-server', COMPOSE_ANSI: 'never' },
  );
});

test('production rendered config rejects published internals, wrong volumes, mock and env mismatches', () => {
  const settings = config();
  assertProductionCompose(renderedConfig(settings), settings);
  for (const mutate of [
    (c) => {
      c.name = 'another-project';
    },
    (c) => {
      c.services.database.ports = [{ target: 5432, published: '5432' }];
    },
    (c) => {
      c.services.api.environment.MODEL_MODE = 'mock';
    },
    (c) => {
      c.services.worker.environment.APP_ORIGIN = 'http://localhost';
    },
    (c) => {
      c.services.gateway.environment.SITE_ADDRESS = 'wrong.example.com';
    },
    (c) => {
      c.services.gateway.ports.push({ target: 3000, published: '3000' });
    },
    (c) => {
      c.services.api.volumes = [{ type: 'bind', source: '/var/run/docker.sock' }];
    },
    (c) => {
      c.volumes.database_data.name = 'another-project_database_data';
    },
    (c) => {
      c.networks.private.internal = false;
    },
    (c) => {
      c.services.api.logging.options['max-size'] = 'unlimited';
    },
  ]) {
    const rendered = renderedConfig(settings);
    mutate(rendered);
    assert.throws(() => assertProductionCompose(rendered, settings));
  }
});

async function operatorFixture(
  t,
  { failOn, existingVolume = false, running = 'database\nredis\napi\ngateway' } = {},
) {
  const root = await temporary(t);
  const settings = config();
  const envFile = join(root, '.env.production');
  await writeProductionEnv(envFile, settings);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const calls = [];
  const logs = [];
  let paused = false;
  const run = async (args, options) => {
    const start = args.indexOf(join(root, 'compose.production.yaml'));
    const command = start < 0 ? args : args.slice(start + 1);
    calls.push({ command, options });
    if (failOn?.(command)) throw new Error('Injected operation failure.');
    if (args.join(' ') === 'compose version --short') return '2.39.0';
    if (command[0] === 'info') return 'linux';
    if (command[0] === 'config') return JSON.stringify(renderedConfig(settings));
    if (command.join(' ') === 'volume ls --format {{.Name}}')
      return existingVolume ? `${settings.COMPOSE_PROJECT_NAME}_database_data` : '';
    if (command[0] === 'ps' && command.includes('--services'))
      return paused ? 'database\nredis' : running;
    if (command[0] === 'stop') paused = true;
    if (options.outputFile)
      await writeFile(options.outputFile, 'PGDMP-test-only-archive', { flag: 'wx' });
    return '';
  };
  const operator = await createProductionOperator({
    root,
    envFile,
    run,
    log: (text) => logs.push(text),
  });
  return { operator, calls, root, settings, logs };
}

test('check renders production configuration but never builds, calls a model or starts a service', async (t) => {
  const { operator, calls } = await operatorFixture(t);
  await operator.perform('check');
  assert.deepEqual(
    calls.map((c) => c.command[0]),
    ['compose', 'info', 'config'],
  );
});

test('fresh install migrates and creates an interactive admin before starting the application', async (t) => {
  const { operator, calls, logs, settings } = await operatorFixture(t);
  await operator.perform('install');
  const migration = calls.findIndex((c) => c.command.at(-1) === 'migrate');
  const admin = calls.findIndex((c) => c.command.at(-1) === 'admin:create');
  assert.ok(migration > 0 && admin > migration);
  assert.equal(calls[admin].options.interactive, true);
  assert.equal(calls.at(-1).command[0], 'up');
  for (const value of [settings.DB_PASSWORD, settings.MODEL_ENCRYPTION_KEY])
    assert.equal(logs.join('\n').includes(value), false);
});

test('fresh install cannot bootstrap over existing data volumes', async (t) => {
  const { operator, calls } = await operatorFixture(t, { existingVolume: true });
  await assert.rejects(operator.perform('install'), /already has/);
  assert.equal(
    calls.some((c) => ['build', 'run', 'up'].includes(c.command[0])),
    false,
  );
});

test('backup freezes writes, verifies an archive, excludes secrets and resumes only previously running services', async (t) => {
  const { operator, calls, settings, root } = await operatorFixture(t);
  const directory = await operator.perform('backup');
  const dump = calls.findIndex((c) => c.command.includes('pg_dump'));
  assert.ok(
    calls.slice(0, dump).some((c) => c.command.includes('worker') && c.command[0] === 'stop'),
  );
  const metadata = JSON.parse(await readFile(join(directory, 'backup.json'), 'utf8'));
  assert.equal(metadata.databaseSha256, await sha256File(join(directory, 'database.dump')));
  assert.equal(metadata.restoreVerified, false);
  assert.equal(metadata.workerMustStayStoppedOnRestore, true);
  assert.equal(JSON.stringify(metadata).includes(settings.MODEL_ENCRYPTION_KEY), false);
  assert.deepEqual(calls.at(-1).command.slice(-2), ['gateway', 'api']);
  assert.equal(calls.at(-1).command.includes('worker'), false);
  assert.equal((await readdir(join(root, 'data'))).includes('production-operation.lock'), false);
});

test('failed upgrade backup cannot execute a migration or restart writers', async (t) => {
  const { operator, calls, root } = await operatorFixture(t, {
    failOn: (command) => command.includes('pg_dump'),
  });
  await assert.rejects(operator.perform('upgrade'), /Injected/);
  assert.equal(
    calls.some((c) => c.command.includes('migrate')),
    false,
  );
  assert.equal(
    calls.some((c) => ['up', 'start'].includes(c.command[0])),
    false,
  );
  assert.equal(calls.at(-1).command[0], 'stop');
  const [name] = await readdir(join(root, 'data', 'production-backups'));
  assert.equal(
    (await readdir(join(root, 'data', 'production-backups', name))).includes('backup.json'),
    false,
  );
});

test('failed migration leaves applications stopped and retains the verified pre-migration backup', async (t) => {
  const { operator, calls, root } = await operatorFixture(t, {
    failOn: (command) => command.at(-1) === 'migrate',
  });
  await assert.rejects(operator.perform('upgrade'), /Injected/);
  assert.equal(
    calls.some(
      (c) =>
        ['up', 'start'].includes(c.command[0]) &&
        ['gateway', 'api', 'worker'].some((name) => c.command.includes(name)),
    ),
    false,
  );
  assert.equal(calls.at(-1).command[0], 'stop');
  const [name] = await readdir(join(root, 'data', 'production-backups'));
  assert.ok(
    JSON.parse(
      await readFile(join(root, 'data', 'production-backups', name, 'backup.json'), 'utf8'),
    ).databaseSha256,
  );
});

test('successful upgrade backs up before migrating, preserves a stopped Worker and never deletes volumes', async (t) => {
  const { operator, calls } = await operatorFixture(t);
  await operator.perform('upgrade');
  const dump = calls.findIndex((c) => c.command.includes('pg_dump'));
  const migration = calls.findIndex((c) => c.command.at(-1) === 'migrate');
  assert.ok(migration > dump);
  assert.deepEqual(calls.at(-1).command, [
    'up',
    '-d',
    '--no-deps',
    '--wait',
    '--wait-timeout',
    '180',
    'gateway',
    'api',
  ]);
  assert.equal(
    calls.some((c) => c.command[0] === 'down' || c.command.includes('--volumes')),
    false,
  );
});

test('upgrade refreshes patched infrastructure only after backup and before migration', async (t) => {
  const { operator, calls } = await operatorFixture(t);
  await operator.perform('upgrade');
  const dump = calls.findIndex((c) => c.command.includes('pg_dump'));
  const infrastructure = calls.findIndex(
    (c) => c.command[0] === 'up' && c.command.includes('database') && c.command.includes('redis'),
  );
  const migration = calls.findIndex((c) => c.command.at(-1) === 'migrate');
  assert.ok(infrastructure > dump && migration > infrastructure);
  assert.equal(calls[infrastructure].command.includes('worker'), false);
  assert.equal(calls[infrastructure].command.includes('api'), false);
  assert.ok(calls[infrastructure].command.includes('--no-deps'));
});

test('failed infrastructure refresh preserves the backup and cannot migrate or restart writers', async (t) => {
  const { operator, calls, root } = await operatorFixture(t, {
    failOn: (command) => command[0] === 'up' && command.includes('redis'),
  });
  await assert.rejects(operator.perform('upgrade'), /Injected/);
  assert.equal(
    calls.some((c) => c.command.includes('migrate')),
    false,
  );
  assert.equal(
    calls.some(
      (c) =>
        ['up', 'start'].includes(c.command[0]) &&
        ['gateway', 'api', 'worker'].some((name) => c.command.includes(name)),
    ),
    false,
  );
  const [name] = await readdir(join(root, 'data', 'production-backups'));
  assert.ok(
    JSON.parse(
      await readFile(join(root, 'data', 'production-backups', name, 'backup.json'), 'utf8'),
    ).databaseSha256,
  );
  assert.equal(calls.at(-1).command[0], 'stop');
});

test('a production lock prevents concurrent operations without touching Docker', async (t) => {
  const { operator, calls, root } = await operatorFixture(t);
  await mkdir(join(root, 'data'));
  const path = join(root, 'data', 'production-operation.lock');
  await writeFile(path, 'owned by another operation');
  await assert.rejects(operator.perform('upgrade'), /Another production operation/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(path, 'utf8'), 'owned by another operation');
});
