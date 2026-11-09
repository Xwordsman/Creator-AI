import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { runProcess } from './docker-smoke.mjs';
import { sha256File } from './production-operations.mjs';

const rootFiles = [
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.prettierignore',
  '.env.example',
  '.env.production.example',
  'compose.yaml',
  'compose.production.yaml',
  'compose.dev.yaml',
  'compose.smoke.yaml',
];
const sourceDirectories = ['apps', 'packages', 'scripts', 'infra', 'docs', '.github'];
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'data',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
]);
const extensions = /\.(?:ts|vue|css|html|json|yaml|yml|cjs|mjs|md|svg|txt)$/;

export async function collectReleaseFiles(root) {
  const files = [];
  const add = async (path, required = false) => {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release source must not contain symlinks: ${path}`);
    if (info.isDirectory()) {
      if (excludedDirectories.has(path.split('/').at(-1))) return;
      for (const entry of (await readdir(absolute)).sort()) await add(`${path}/${entry}`);
    } else if (info.isFile()) {
      const name = path.split('/').at(-1);
      if (
        required ||
        (name !== '.env' &&
          !name.startsWith('.env.') &&
          (extensions.test(name) ||
            ['Caddyfile', 'server.Dockerfile', 'web.Dockerfile'].includes(name)))
      )
        files.push(path);
    }
  };
  for (const path of rootFiles) await add(path, true);
  for (const path of sourceDirectories) await add(path);
  return files.sort();
}

export async function packageRelease({ root, output, run = runProcess }) {
  root = resolve(root);
  output = resolve(output);
  const within = relative(root, output);
  if (within && !within.startsWith(`dist${sep}`))
    throw new Error('Release output must be a new directory under the workspace dist directory.');
  if (!within) throw new Error('Release output must not be the workspace root.');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be an exact semver.');
  for (const path of ['apps/server', 'apps/web', 'packages/contracts'])
    if (JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')).version !== version)
      throw new Error('All workspace package versions must match before packaging.');
  const files = await collectReleaseFiles(root);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite a previous release or include its files.
  const name = `creator-ai-${version}`;
  const staging = join(output, name);
  await mkdir(staging);
  const manifest = {
    format: 'creator-ai-source-release-v1',
    version,
    createdAt: new Date().toISOString(),
    artifactType: 'source-build-on-server',
    files: [],
  };
  for (const path of files) {
    const source = join(root, path);
    const destination = join(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    manifest.files.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await writeFile(
    join(staging, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  const archive = join(output, `${name}.tar.gz`);
  const result = await run('tar', ['-czf', archive, '-C', output, name], {
    cwd: root,
    timeoutMs: 120000,
  });
  if (result.code !== 0)
    throw new Error('Unable to create release archive. Check tar availability.');
  const hash = await sha256File(archive);
  await writeFile(`${archive}.sha256`, `${hash}  ${name}.tar.gz\n`, { flag: 'wx' });
  return { archive, hash, files: files.length, version };
}
