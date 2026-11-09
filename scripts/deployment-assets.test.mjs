import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('development, CI and container builds use the same patched Node and pnpm baseline', async () => {
  const version = (await source('.node-version')).trim();
  const pkg = JSON.parse(await source('package.json'));
  assert.equal(version, '24.22.2');
  assert.equal(pkg.engines.node, `>=${version} <25`);
  const ci = await source('.github/workflows/ci.yaml');
  assert.ok(ci.includes(`node-version: ${version}`));
  assert.ok(ci.includes(`pnpm@${pkg.packageManager.split('@')[1]}`));
  for (const name of ['server', 'web']) {
    const dockerfile = await source(`infra/docker/${name}.Dockerfile`);
    const nodeImages = [...dockerfile.matchAll(/^FROM node:([^\s]+)/gm)].map((m) => m[1]);
    assert.ok(nodeImages.length > 0);
    assert.ok(nodeImages.every((image) => image === `${version}-bookworm-slim`));
    assert.ok(dockerfile.includes(`pnpm@${pkg.packageManager.split('@')[1]}`));
  }
});

test('deployment and CI no longer pin vulnerable pre-patch database and Redis images', async () => {
  const compose = await source('compose.yaml');
  const ci = await source('.github/workflows/ci.yaml');
  for (const text of [compose, ci]) {
    assert.ok(text.includes('image: postgres:17.11-bookworm'));
    assert.ok(text.includes('image: redis:7.2.17-alpine'));
  }
  assert.match(await source('infra/docker/web.Dockerfile'), /^FROM caddy:2\.11\.9-alpine$/m);
  assert.ok(ci.includes('pnpm audit:security'));
  assert.ok(
    pkgAuditCommand(JSON.parse(await source('package.json'))).includes('registry.npmjs.org'),
  );
});

const pkgAuditCommand = (pkg) => pkg.scripts['audit:security'];
