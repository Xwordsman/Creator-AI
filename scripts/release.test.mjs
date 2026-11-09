import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { collectReleaseFiles, packageRelease } from './lib/release.mjs';
import { sha256File } from './lib/production-operations.mjs';

async function sourceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'creator-ai-release-test-'));
  t.after(async () => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()));
    assert.match(root.split(/[\\/]/).at(-1), /^creator-ai-release-test-/);
    await rm(root, { recursive: true, force: true });
  });
  const rootFiles = [
    'README.md',
    'CHANGELOG.md',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'eslint.config.mjs',
    '.npmrc',
    '.gitignore',
    '.dockerignore',
    '.prettierignore',
    '.prettierrc.json',
    '.node-version',
    '.gitattributes',
    '.env.example',
    '.env.production.example',
    'compose.yaml',
    'compose.production.yaml',
    'compose.dev.yaml',
    'compose.smoke.yaml',
  ];
  for (const file of rootFiles) await writeFile(join(root, file), 'public example');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  for (const path of ['apps/server', 'apps/web', 'packages/contracts']) {
    await mkdir(join(root, path, 'src'), { recursive: true });
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    await writeFile(join(root, path, 'src', 'index.ts'), '// source');
  }
  for (const directory of ['scripts', 'infra', 'docs', '.github'])
    await mkdir(join(root, directory));
  return root;
}

test('release allowlist excludes private env, local data, dependencies and generated outputs', async (t) => {
  const root = await sourceFixture(t);
  for (const file of ['.env', '.env.production', 'apps/server/.env.private', 'apps/web/token.pem'])
    await writeFile(join(root, file), 'private-test-value');
  for (const directory of [
    'data',
    'dist',
    'apps/web/node_modules',
    'apps/web/test-results',
    'packages/contracts/dist',
  ]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, 'private.json'), 'private-test-value');
  }
  const files = await collectReleaseFiles(root);
  assert.ok(files.includes('.env.production.example'));
  assert.ok(files.includes('apps/server/src/index.ts'));
  assert.ok(files.includes('.prettierrc.json'));
  assert.ok(files.includes('.node-version'));
  assert.ok(files.includes('.gitattributes'));
  assert.equal(
    files.some((path) => path.includes('private') || path.endsWith('token.pem')),
    false,
  );
  assert.equal(files.includes('.env') || files.includes('.env.production'), false);
});

test('release package contains byte hashes and a checksum without overwriting earlier output', async (t) => {
  const root = await sourceFixture(t);
  const output = join(root, 'dist', 'release');
  let command;
  const run = async (executable, args) => {
    command = { executable, args };
    await writeFile(args[1], 'fixture-tarball', { flag: 'wx' });
    return { code: 0 };
  };
  const result = await packageRelease({ root, output, run });
  assert.equal(command.executable, 'tar');
  assert.equal(command.args[0], '-czf');
  assert.equal(result.hash, await sha256File(result.archive));
  const manifest = JSON.parse(
    await readFile(join(output, 'creator-ai-0.1.0', 'release-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.files.length, result.files);
  for (const file of manifest.files)
    assert.equal(file.sha256, await sha256File(join(output, 'creator-ai-0.1.0', file.path)));
  assert.equal(
    await readFile(`${result.archive}.sha256`, 'utf8'),
    `${result.hash}  creator-ai-0.1.0.tar.gz\n`,
  );
  await assert.rejects(packageRelease({ root, output, run }), { code: 'EEXIST' });
});

test('release package refuses mismatched workspace versions and output outside dist', async (t) => {
  const root = await sourceFixture(t);
  await assert.rejects(
    packageRelease({ root, output: join(root, 'data', 'release') }),
    /under the workspace dist/,
  );
  await assert.rejects(packageRelease({ root, output: root }), /workspace root/);
  await writeFile(join(root, 'apps/web/package.json'), JSON.stringify({ version: '0.0.1' }));
  await assert.rejects(
    packageRelease({ root, output: join(root, 'dist', 'release') }),
    /versions must match/,
  );
});
