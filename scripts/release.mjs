import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { packageRelease } from './lib/release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'output-dir': { type: 'string' } },
});
if (positionals.length)
  throw new Error('Usage: node scripts/release.mjs [--output-dir dist/releases/NAME]');
const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
const output = resolve(
  root,
  values['output-dir'] ?? join('dist', 'releases', `${stamp}-${randomBytes(3).toString('hex')}`),
);
void packageRelease({ root, output })
  .then(({ archive, hash, files, version }) => {
    console.log(
      `Creator-AI ${version}: ${archive}\nSHA-256: ${hash}\n${files} source/configuration files; no local data, credentials or dependencies included.`,
    );
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
