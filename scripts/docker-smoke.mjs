import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assertComposeVersion,
  assertIsolatedConfig,
  assertLocalEndpoint,
  createIdentity,
  redact,
  runProcess,
} from './lib/docker-smoke.mjs';
import { SmokeClient } from './lib/smoke-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identity = createIdentity();
const secrets = [identity.databaseSecret, identity.adminSecret];
const interrupted = new AbortController();
const stop = () => interrupted.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function docker(
  args,
  { signal = interrupted.signal, timeoutMs, expectedCode = 0, env = process.env } = {},
) {
  let result;
  try {
    result = await runProcess('docker', args, {
      cwd: root,
      env,
      signal: signal ?? undefined,
      timeoutMs,
    });
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Docker CLI is not installed. A local Linux-container Docker engine and Compose >= 2.24.4 are required. No Docker resources were created.',
      );
    throw error;
  }
  if (result.code !== expectedCode) {
    throw new Error(
      `Docker ${args[0]} exited with ${result.code} (expected ${expectedCode}).\n${redact(result.stderr.slice(-6000), secrets)}`,
    );
  }
  return result.stdout.trim();
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForGateway(client) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted();
    try {
      await client.request('/health/ready');
      return;
    } catch {
      await delay(500, undefined, { signal: interrupted.signal });
    }
  }
  throw new Error('The gateway did not become ready within 45 seconds.');
}

async function main() {
  console.log('[docker-smoke] Checking local Docker prerequisites.');
  assertComposeVersion(await docker(['compose', 'version', '--short']));
  const endpoint =
    process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : JSON.parse(
          await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']),
        );
  assertLocalEndpoint(endpoint);
  if ((await docker(['info', '--format', '{{.OSType}}'])) !== 'linux')
    throw new Error('Switch Docker to Linux containers before running this test.');

  for (const args of [
    ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${identity.project}`],
    ['volume', 'ls', '-q', '--filter', `name=${identity.project}`],
    ['network', 'ls', '-q', '--filter', `name=${identity.project}`],
    ['image', 'ls', '-q', '--filter', `reference=${identity.project}-*`],
  ]) {
    if (await docker(args))
      throw new Error('The generated project name is already in use. No resources were changed.');
  }

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), 'creator-ai-smoke-'));
  const envFile = join(directory, 'empty.env');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
    ),
    COMPOSE_ANSI: 'never',
    DB_PASSWORD: identity.databaseSecret,
    APP_ORIGIN: origin,
    SITE_ADDRESS: 'http://:80',
    HTTP_PORT: String(port),
    HTTPS_PORT: '443',
    SMOKE_HTTP_PORT: String(port),
    SMOKE_SERVER_IMAGE: identity.serverImage,
    SMOKE_WEB_IMAGE: identity.webImage,
    ADMIN_USERNAME: identity.adminUsername,
    ADMIN_PASSWORD: identity.adminSecret,
  };
  const composeArgs = [
    'compose',
    '--project-name',
    identity.project,
    '--project-directory',
    root,
    '--env-file',
    envFile,
    '-f',
    join(root, 'compose.yaml'),
    '-f',
    join(root, 'compose.smoke.yaml'),
  ];
  const compose = (args, options = {}) => docker([...composeArgs, ...args], { ...options, env });
  let ownsResources = false;
  let ownsImages = false;
  let failure;
  try {
    // Explicit empty env file prevents loading the developer's .env, including in cleanup.
    await writeFile(
      envFile,
      '# Intentionally empty. Credentials only exist in process environment.\n',
      { flag: 'wx', mode: 0o600 },
    );
    assertIsolatedConfig(JSON.parse(await compose(['config', '--format', 'json'])), identity, port);
    console.log(`[docker-smoke] Isolated project: ${identity.project}; gateway: ${origin}.`);
    console.log('[docker-smoke] Building production images (may take several minutes).');
    ownsImages = true;
    await compose(['build', '--quiet'], { timeoutMs: 1200000 });
    ownsResources = true;
    await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'database', 'redis'], {
      timeoutMs: 180000,
    });

    console.log('[docker-smoke] Checking explicit migrations and one-time admin bootstrap.');
    const cli = ['run', '--rm', '--no-deps', '-T'];
    await compose([...cli, 'api', 'node', 'dist/cli.js', 'migrate']);
    const secondMigration = await compose([...cli, 'api', 'node', 'dist/cli.js', 'migrate']);
    assert.match(secondMigration, /Applied 0 migration\(s\)\./);
    const bootstrap = [
      ...cli,
      '-e',
      'ADMIN_USERNAME',
      '-e',
      'ADMIN_PASSWORD',
      'api',
      'node',
      'dist/cli.js',
      'admin:create',
    ];
    await compose(bootstrap);
    await compose(bootstrap, { expectedCode: 1 });
    await compose(['up', '-d', '--wait', '--wait-timeout', '120'], { timeoutMs: 180000 });
    assert.equal(await compose(['port', 'gateway', '80']), `127.0.0.1:${port}`);

    const client = new SmokeClient(origin, interrupted.signal);
    await waitForGateway(client);
    console.log(
      '[docker-smoke] Checking the built frontend, auth, CSRF, idempotency and SSE through Caddy.',
    );
    await client.verifyShell();
    secrets.push(...(await client.login(identity.adminUsername, identity.adminSecret)));
    const fixtures = await client.createFixtures();

    console.log(
      '[docker-smoke] Recreating data/API containers with a queued task and the Worker stopped.',
    );
    await compose(['stop', 'worker']);
    const queued = await client.createRun({
      ...fixtures.input,
      topic: 'Survive container recreation',
    });
    assert.equal(queued.status, 'queued');
    await compose(
      ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'database', 'redis'],
      { timeoutMs: 180000 },
    );
    await compose(
      ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'api'],
      { timeoutMs: 180000 },
    );
    await waitForGateway(client);
    await client.verifyPersistence(fixtures, queued);
    await compose(
      ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'worker'],
      { timeoutMs: 180000 },
    );
    const recovered = await client.completed(queued.id);
    assert.equal(recovered.output?.isMock, true);
    assert.equal(recovered.attempts, 1);
    await client.logout();
    console.log('[docker-smoke] Runtime checks passed. Cleaning up only this test project.');
  } catch (error) {
    failure = error;
    if (ownsResources) {
      try {
        console.error(
          redact(
            await compose(['logs', '--no-color', '--tail', '25'], {
              signal: null,
              timeoutMs: 30000,
            }),
            secrets,
          ),
        );
      } catch {
        /* Diagnostics must not prevent cleanup. */
      }
    }
  } finally {
    try {
      if (ownsResources)
        await compose(['down', '--volumes', '--remove-orphans', '--timeout', '15'], {
          signal: null,
          timeoutMs: 120000,
        });
      if (ownsImages) {
        const images = await docker(
          [
            'image',
            'ls',
            '--format',
            '{{.Repository}}:{{.Tag}}',
            '--filter',
            `reference=${identity.project}-*`,
          ],
          { signal: null },
        );
        const names = [...new Set(images.split(/\r?\n/).filter(Boolean))];
        if (names.some((name) => ![identity.serverImage, identity.webImage].includes(name)))
          throw new Error('Unexpected image name; cleanup stopped.');
        if (names.length) await docker(['image', 'rm', ...names], { signal: null });
      }
    } catch (error) {
      console.error(
        `[docker-smoke] Cleanup incomplete for ${identity.project}. Inspect only resources carrying this project name/label.`,
      );
      console.error(redact(error.message ?? String(error), secrets));
      failure ??= error;
    }
    await unlink(envFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
  if (failure) throw failure;
  console.log('[docker-smoke] PASS: isolated Docker runtime, persistence and cleanup verified.');
}

try {
  await main();
} catch (error) {
  console.error(`[docker-smoke] FAILED: ${redact(error.message ?? String(error), secrets)}`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
