import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertComposeVersion, redact } from './docker-smoke.mjs';
import { assertProductionCompose, productionProcessEnv, readProductionEnv } from './production.mjs';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function executeDocker(args, { cwd, env, secrets, interactive, outputFile } = {}) {
  const output = outputFile ? await open(outputFile, 'wx', 0o600) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: interactive ? 'inherit' : ['ignore', output?.fd ?? 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        20 * 60 * 1000,
      );
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-12000);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            error.code === 'ENOENT'
              ? 'Docker is not installed. Install Docker Engine and Compose >= 2.24.4.'
              : 'Unable to start Docker.',
          ),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut)
          reject(new Error('Docker command timed out. Inspect containers before retrying.'));
        else if (code !== 0)
          reject(new Error(`Docker command failed (${code}). ${redact(stderr, secrets ?? [])}`));
        else resolve(stdout.trim());
      });
    });
  } finally {
    if (output) {
      await output.sync();
      await output.close();
    }
  }
}

export async function createProductionOperator({
  root,
  envFile,
  run = executeDocker,
  log = console.log,
}) {
  const config = await readProductionEnv(envFile);
  const env = productionProcessEnv();
  const secrets = [config.DB_PASSWORD, config.MODEL_ENCRYPTION_KEY];
  const base = [
    'compose',
    '--project-name',
    config.COMPOSE_PROJECT_NAME,
    '--project-directory',
    root,
    '--env-file',
    envFile,
    '-f',
    join(root, 'compose.yaml'),
    '-f',
    join(root, 'compose.production.yaml'),
  ];
  const docker = (args, options = {}) => run(args, { cwd: root, env, secrets, ...options });
  const compose = (args, options) => docker([...base, ...args], options);
  let rendered;

  async function check() {
    assertComposeVersion(await docker(['compose', 'version', '--short']));
    if ((await docker(['info', '--format', '{{.OSType}}'])) !== 'linux')
      throw new Error('A Linux-container Docker engine is required.');
    rendered = JSON.parse(await compose(['config', '--format', 'json']));
    assertProductionCompose(rendered, config);
    log(`Production configuration checked: ${config.COMPOSE_PROJECT_NAME} / ${config.APP_ORIGIN}`);
  }

  async function locked(operation, action) {
    const directory = join(root, 'data');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'production-operation.lock');
    let lock;
    try {
      lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          'Another production operation owns data/production-operation.lock. Inspect it before retrying.',
        );
      throw error;
    }
    try {
      await lock.writeFile(
        JSON.stringify({ operation, pid: process.pid, at: new Date().toISOString() }),
      );
      return await action();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }

  const start = () => compose(['up', '-d', '--wait', '--wait-timeout', '180']);
  const admin = () =>
    compose(['run', '--rm', '--no-deps', 'api', 'node', 'dist/cli.js', 'admin:create'], {
      interactive: true,
    });
  const migrate = () =>
    compose(['run', '--rm', '--no-deps', '-T', 'api', 'node', 'dist/cli.js', 'migrate']);

  async function pause() {
    const running = (await compose(['ps', '--status', 'running', '--services']))
      .split(/\s+/)
      .filter(Boolean);
    if (!running.includes('database')) throw new Error('The database must already be running.');
    const apps = ['gateway', 'api', 'worker'];
    const resume = apps.filter((name) => running.includes(name));
    // Stop ingress and API before draining the Worker, so no new work can be submitted.
    await compose(['stop', '--timeout', '60', 'gateway', 'api']);
    await compose(['stop', '--timeout', '60', 'worker']);
    const remaining = (await compose(['ps', '--status', 'running', '--services'])).split(/\s+/);
    if (remaining.some((name) => apps.includes(name)))
      throw new Error('Application writers did not stop.');
    return resume;
  }

  async function dump() {
    const parent = join(root, 'data', 'production-backups');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
    const directory = join(
      parent,
      `${config.COMPOSE_PROJECT_NAME}-${stamp}-${randomBytes(3).toString('hex')}`,
    );
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'database.dump');
    await compose(
      [
        'exec',
        '-T',
        'database',
        'pg_dump',
        '-U',
        'creator',
        '-d',
        'creator',
        '--format=custom',
        '--no-owner',
        '--no-privileges',
      ],
      { outputFile: path },
    );
    // This checks archive readability; only an isolated restore can prove recoverability.
    const checkPath = `/tmp/creator-ai-backup-${randomBytes(8).toString('hex')}.dump`;
    await compose(['cp', path, `database:${checkPath}`]);
    try {
      await compose(['exec', '-T', 'database', 'pg_restore', '--list', checkPath]);
    } finally {
      await compose(['exec', '-T', 'database', 'rm', '-f', checkPath]);
    }
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const metadata = {
      format: 'creator-ai-database-backup-v1',
      createdAt: new Date().toISOString(),
      operatorVersion: version,
      project: config.COMPOSE_PROJECT_NAME,
      databaseSha256: await sha256File(path),
      includes: ['PostgreSQL business data and invocation ledger'],
      excludes: [
        'production env and encryption key',
        'Redis queue and rate limits',
        'Caddy certificates',
      ],
      restoreVerified: false,
      workerMustStayStoppedOnRestore: true,
    };
    const manifest = await open(join(directory, 'backup.json'), 'wx', 0o600);
    try {
      await manifest.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    log(`Database backup saved: ${directory}`);
    log(
      'Back up .env.production separately. Restore into a fresh project with the Worker stopped.',
    );
    return directory;
  }

  async function perform(command) {
    if (command === 'check') return check();
    if (command === 'status') {
      await check();
      log(await compose(['ps']));
      return;
    }
    return locked(command, async () => {
      await check();
      if (command === 'install') {
        const containers = await compose(['ps', '-a', '-q']);
        const volumes = new Set(
          (await docker(['volume', 'ls', '--format', '{{.Name}}'])).split(/\s+/),
        );
        if (containers || Object.values(rendered.volumes).some((v) => volumes.has(v.name)))
          throw new Error(
            'This project already has containers or data volumes. Use upgrade or start.',
          );
        log('Building production images. This may take several minutes.');
        await compose(['build']);
        await compose(['up', '-d', '--wait', '--wait-timeout', '180', 'database', 'redis']);
        await migrate();
        await admin();
        await start();
      } else if (command === 'start') await start();
      else if (command === 'admin') await admin();
      else if (command === 'backup' || command === 'upgrade') {
        if (command === 'upgrade') {
          log('Building production images before the maintenance window.');
          await compose(['build']);
        }
        let paused = false;
        try {
          paused = true;
          const resume = await pause();
          const directory = await dump();
          if (command === 'upgrade') {
            // --no-deps on the application restart must not leave old security-pinned
            // infrastructure running. Refresh it only after the verified backup.
            await compose([
              'up',
              '-d',
              '--no-deps',
              '--wait',
              '--wait-timeout',
              '180',
              'database',
              'redis',
            ]);
            await migrate();
            if (resume.length)
              await compose([
                'up',
                '-d',
                '--no-deps',
                '--wait',
                '--wait-timeout',
                '180',
                ...resume,
              ]);
            log('Upgrade completed. Previously stopped application services remain stopped.');
          } else if (resume.length) {
            await compose(['start', '--wait', '--wait-timeout', '180', ...resume]);
          }
          return directory;
        } catch (error) {
          if (paused) {
            try {
              await compose(['stop', '--timeout', '60', 'gateway', 'api', 'worker']);
            } catch {
              log('Could not confirm all application containers stopped. Check Docker manually.');
            }
            log(
              'Maintenance failed. Inspect the error and database before using the start command.',
            );
          }
          throw error;
        }
      } else throw new Error('Unsupported production command.');
      log(`Production ${command} completed: ${config.APP_ORIGIN}`);
    });
  }
  return { perform };
}
