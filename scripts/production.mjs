import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createProductionConfig, writeProductionEnv } from './lib/production.mjs';
import { createProductionOperator, sha256File } from './lib/production-operations.mjs';
import { readFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'env-file': { type: 'string', default: '.env.production' },
      origin: { type: 'string' },
      'model-hosts': { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, backupPath] = positionals;
  if (values.help || !command) {
    console.log(`Creator-AI production operations (Node.js 24 + Docker Compose >= 2.24.4)

  init --origin https://YOUR_DOMAIN --model-hosts YOUR_MODEL_HOST [--project creator-ai]
  check       Validate production configuration and Docker without starting services
  install     Build, migrate, interactively create the first admin, and start a fresh project
  status      Show production service status
  backup      Pause writers, create a database archive, and resume previously running services
  upgrade     Build, pause writers, back up, migrate, and start; leave apps stopped on failure
  start       Start an initialized project after inspecting any previous failure
  admin       Retry interactive first-admin initialization after an interrupted fresh install
  verify-backup PATH  Verify a database archive checksum (does not restore it)

All service commands use .env.production; override with --env-file PATH.
Installation does not create accounts, sample articles, model connections or paid calls.`);
    return;
  }
  if (
    ![
      'init',
      'check',
      'install',
      'status',
      'backup',
      'upgrade',
      'start',
      'admin',
      'verify-backup',
    ].includes(command)
  )
    throw new Error('Unknown command. Use --help.');
  if (positionals.length !== (command === 'verify-backup' ? 2 : 1))
    throw new Error('Unexpected command arguments. Use --help.');
  if (command !== 'init' && (values.origin || values['model-hosts'] || values.project))
    throw new Error('Origin, model hosts and project options apply only to init.');
  if (command === 'verify-backup') {
    const directory = resolve(backupPath);
    const manifest = JSON.parse(await readFile(resolve(directory, 'backup.json'), 'utf8'));
    if (
      manifest.format !== 'creator-ai-database-backup-v1' ||
      !/^[a-f0-9]{64}$/.test(manifest.databaseSha256 ?? '') ||
      manifest.databaseSha256 !== (await sha256File(resolve(directory, 'database.dump')))
    )
      throw new Error('Backup checksum verification failed. Do not restore this archive.');
    console.log(
      'Database archive checksum verified. A separate isolated restore is still required.',
    );
    return;
  }
  const envFile = resolve(root, values['env-file']);
  if (command === 'init') {
    await writeProductionEnv(
      envFile,
      createProductionConfig({
        origin: values.origin,
        modelHosts: values['model-hosts'],
        project: values.project,
      }),
    );
    console.log(
      `Private configuration created: ${envFile}\nSecrets were generated locally and are not printed. Back up this file separately.`,
    );
    return;
  }
  const operator = await createProductionOperator({ root, envFile });
  await operator.perform(command);
}

void main().catch((error) => {
  console.error(
    error.code === 'EEXIST'
      ? 'The target file already exists. Existing production secrets were preserved.'
      : error.code === 'ENOENT'
        ? 'A required file is missing. Run init or check the selected path; see --help.'
        : error.message,
  );
  process.exitCode = 1;
});
