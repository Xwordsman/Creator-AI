import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ContentDetail, SessionInfo, SaveContentInput } from '@creator-ai/contracts';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { createAdmin } from '../src/modules/auth/bootstrap';
import { bootstrapApi } from '../src/main-api';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { CreationService } from '../src/modules/creation/creation.service';
import { ContentService } from '../src/modules/content/content.service';
import { MockTextProvider } from '../src/modules/models/mock-provider';
import { TaskRunner } from '../src/modules/tasks/task-runner';
import { RunEntity, UserEntity } from '../src/database/entities';

describe('Versioned content + reviews + safe exports', () => {
  let db: DataSource,
    app: INestApplication,
    base: string,
    ownerId: string,
    otherId: string,
    runId: string;
  let headers: Record<string, string>, contents: ContentService, creation: CreationService;
  let runInput: { accountId: string; expertId: string; topic: string; brief: string };
  const origin = 'http://127.0.0.1:5173';
  const document: SaveContentInput['document'] = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Human edit <script>alert(1)</script> & [click](https://evil.invalid)',
          },
        ],
      },
    ],
  };
  const request = (path: string, body?: unknown, key?: string) =>
    fetch(`${base}${path}`, {
      headers: { ...headers, ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  async function fixture(isMock = true) {
    const run = await creation.create(ownerId, runInput, randomUUID());
    await new TaskRunner(db, new MockTextProvider()).execute(run.id);
    if (!isMock) {
      // Explicit synthetic non-mock fixture; never calls a model or changes preview data.
      await db.query(
        `UPDATE creation_runs SET output=jsonb_set(output,'{isMock}','false'::jsonb),
          snapshot=jsonb_set(snapshot,'{provider}','"compatible"'::jsonb) WHERE id=$1`,
        [run.id],
      );
    }
    return contents.promote(ownerId, run.id);
  }
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL,
      redis = process.env.TEST_REDIS_URL;
    if (
      !url ||
      !new URL(url).pathname.endsWith('_test') ||
      !redis ||
      new URL(redis).pathname !== '/15'
    )
      throw new Error('Dedicated test services required');
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ORIGIN: origin,
      MODEL_MODE: 'mock',
      NODE_ENV: 'test',
    });
    db = await createDataSource(url).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE users CASCADE');
    const secret = randomUUID() + randomUUID();
    await createAdmin(db, 'content-test', secret);
    app = await bootstrapApi(0);
    base = `${await app.getUrl()}/api/v1`.replace('0.0.0.0', '127.0.0.1');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'content-test', ['pass' + 'word']: secret }),
    });
    expect(login.status).toBe(200);
    const info = ((await login.json()) as { data: SessionInfo }).data;
    ownerId = info.user.id;
    headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      Origin: origin,
      'X-CSRF-Token': info.csrfToken,
      'Content-Type': 'application/json',
    };
    otherId = randomUUID();
    await db.getRepository(UserEntity).insert({
      id: otherId,
      username: 'other-content-owner',
      passwordHash: 'not-a-login',
      createdAt: new Date(),
    });
    const catalog = new CatalogService(db);
    const account = await catalog.createAccount(ownerId, {
      name: 'Editorial test',
      platform: 'wechat',
      audience: 'Readers',
      persona: 'Precise',
    });
    const expert = await catalog.createExpert(ownerId, {
      name: 'Editor',
      description: 'Editor',
      instructions: 'Write clearly',
      skillKeys: [],
    });
    runInput = { accountId: account.id, expertId: expert.id, topic: 'Content test', brief: '' };
    creation = new CreationService(db);
    contents = new ContentService(db);
    const run = await creation.create(ownerId, runInput, randomUUID());
    runId = run.id;
    await new TaskRunner(db, new MockTextProvider()).execute(runId);
  });
  afterAll(async () => {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
  });

  it('adds only ready owned candidates and deduplicates concurrent promotions', async () => {
    const before = await db.getRepository(RunEntity).findOneByOrFail({ id: runId });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => contents.promote(ownerId, runId)),
    );
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect(results[0]!.version.document).toEqual(before.output!.document);
    expect(results[0]!.item).toMatchObject({
      isMock: true,
      status: 'draft',
      currentVersion: 1,
      revision: 1,
    });
    expect(await db.getRepository(RunEntity).findOneByOrFail({ id: runId })).toEqual(before);
    const queued = await creation.create(ownerId, runInput, randomUUID());
    await expect(contents.promote(ownerId, queued.id)).rejects.toMatchObject({ status: 422 });
    await expect(contents.promote(otherId, runId)).rejects.toMatchObject({ status: 404 });
  });
  it('enforces HTTP authentication, CSRF, strict inputs and owner isolation on every resource', async () => {
    const { item } = await fixture();
    expect((await fetch(`${base}/contents`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/contents/${item.id}/export`, {
          method: 'POST',
          headers: { ...headers, 'X-CSRF-Token': '' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await request('/contents', { sourceRunId: runId, ownerId: otherId })).status).toBe(400);
    expect(
      (
        await request(
          `/contents/${item.id}/versions`,
          { baseRevision: 1, title: 'Bad', document, isMock: false },
          randomUUID(),
        )
      ).status,
    ).toBe(400);
    await expect(contents.get(otherId, item.id)).rejects.toMatchObject({ status: 404 });
    await expect(contents.getVersion(otherId, item.id, 1)).rejects.toMatchObject({ status: 404 });
    await expect(contents.versions(otherId, item.id, 1, 10)).rejects.toMatchObject({ status: 404 });
    await expect(contents.reviews(otherId, item.id, 1, 10)).rejects.toMatchObject({ status: 404 });
    await expect(
      contents.mutate(otherId, item.id, 'restore', { baseRevision: 1, version: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      contents.export(otherId, item.id, {
        version: 1,
        format: 'json',
        acknowledgeUnreviewed: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await contents.list(otherId, 1, 10)).total).toBe(0);
  });
  it('cannot erase mock source provenance even when an output flag is inconsistent', async () => {
    const run = await creation.create(ownerId, runInput, randomUUID());
    await new TaskRunner(db, new MockTextProvider()).execute(run.id);
    await db.query(
      "UPDATE creation_runs SET output=jsonb_set(output,'{isMock}','false'::jsonb) WHERE id=$1",
      [run.id],
    );
    expect((await contents.promote(ownerId, run.id)).item.isMock).toBe(true);
  });
  it('appends immutable versions, replays exact old receipts and rejects altered keys', async () => {
    const original = await fixture();
    const id = original.item.id;
    const input = { baseRevision: 1, title: 'Human version', document, note: 'Edited' };
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => contents.mutate(ownerId, id, 'save', input, key)),
    );
    expect(results.every((r) => r.item.currentVersion === 2)).toBe(true);
    const latest = await contents.mutate(
      ownerId,
      id,
      'save',
      { ...input, baseRevision: 2, title: 'Next' },
      randomUUID(),
    );
    expect(latest.item.currentVersion).toBe(3);
    expect(await contents.mutate(ownerId, id, 'save', input, key)).toEqual(results[0]);
    expect((await contents.get(ownerId, id)).item.currentVersion).toBe(3);
    expect(await contents.getVersion(ownerId, id, 1)).toEqual(original.version);
    await expect(
      contents.mutate(ownerId, id, 'save', { ...input, title: 'Changed' }, key),
    ).rejects.toMatchObject({ status: 409 });
    expect(await contents.versions(ownerId, id, 1, 2)).toMatchObject({
      total: 3,
      items: [{ version: 3 }, { version: 2 }],
    });
    expect((await contents.versions(ownerId, id, 2, 2)).items).toHaveLength(1);
  });
  it('serializes concurrent independent editors and review/save races', async () => {
    const { item } = await fixture();
    const results = await Promise.allSettled([
      contents.mutate(
        ownerId,
        item.id,
        'save',
        { baseRevision: 1, title: 'Edit', document, note: '' },
        randomUUID(),
      ),
      contents.mutate(
        ownerId,
        item.id,
        'review',
        { baseRevision: 1, action: 'submit', note: '' },
        randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await contents.get(ownerId, item.id)).item.revision).toBe(2);
  });
  it('binds review decisions to exact saved versions and restores as a fresh draft', async () => {
    const { item } = await fixture(false);
    const id = item.id;
    await expect(
      contents.mutate(
        ownerId,
        id,
        'review',
        { baseRevision: 1, action: 'approve', note: '' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const submitted = await contents.mutate(
      ownerId,
      id,
      'review',
      { baseRevision: 1, action: 'submit', note: 'Ready' },
      randomUUID(),
    );
    expect(submitted.item).toMatchObject({
      revision: 2,
      currentVersion: 1,
      status: 'pending_review',
    });
    const approved = await contents.mutate(
      ownerId,
      id,
      'review',
      { baseRevision: 2, action: 'approve', note: 'Checked' },
      randomUUID(),
    );
    expect(approved.item.status).toBe('approved');
    expect(
      (
        await contents.export(ownerId, id, {
          version: 1,
          format: 'json',
          acknowledgeUnreviewed: false,
        })
      ).body,
    ).toContain('"approved": true');
    await contents.mutate(
      ownerId,
      id,
      'save',
      { baseRevision: 3, title: 'Edited after approval', document, note: '' },
      randomUUID(),
    );
    const restored = await contents.mutate(
      ownerId,
      id,
      'restore',
      { baseRevision: 4, version: 1 },
      randomUUID(),
    );
    expect(restored.item).toMatchObject({ status: 'draft', currentVersion: 3, revision: 5 });
    expect(restored.version).toMatchObject({ kind: 'restore', restoredFrom: 1 });
    expect(await contents.reviews(ownerId, id, 1, 1)).toMatchObject({
      total: 2,
      items: [{ version: 1, action: 'approve' }],
    });
    await expect(
      contents.export(ownerId, id, { version: 1, format: 'html', acknowledgeUnreviewed: false }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      contents.mutate(ownerId, id, 'restore', { baseRevision: 5, version: 999 }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    expect((await contents.get(ownerId, id)).item.revision).toBe(5);
  });
  it('keeps mock provenance through edits, prohibits approval, and records change requests', async () => {
    const { item } = await fixture();
    const id = item.id;
    await contents.mutate(
      ownerId,
      id,
      'review',
      { baseRevision: 1, action: 'submit', note: '' },
      randomUUID(),
    );
    await expect(
      contents.mutate(
        ownerId,
        id,
        'review',
        { baseRevision: 2, action: 'approve', note: 'Fine' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      (
        await request(
          `/contents/${id}/reviews`,
          { baseRevision: 2, action: 'request_changes', note: '' },
          randomUUID(),
        )
      ).status,
    ).toBe(400);
    const changed = await contents.mutate(
      ownerId,
      id,
      'review',
      { baseRevision: 2, action: 'request_changes', note: 'Need sources' },
      randomUUID(),
    );
    expect(changed.item.status).toBe('changes_requested');
    const saved = await contents.mutate(
      ownerId,
      id,
      'save',
      { baseRevision: 3, title: 'Still mock', document, note: '' },
      randomUUID(),
    );
    expect(saved.item).toMatchObject({ isMock: true, status: 'draft' });
  });
  it('rejects rich nodes, marks, excess text, oversized bodies and unknown review fields', async () => {
    const { item } = await fixture();
    for (const bad of [
      { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://evil.invalid' } }] },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'click',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        ],
      },
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(20001) }] }],
      },
    ])
      expect(
        (
          await request(
            `/contents/${item.id}/versions`,
            { baseRevision: 1, title: 'Bad', document: bad },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
    const oversized = await fetch(`${base}/contents/${item.id}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(2100000) }),
    });
    expect(oversized.status).toBe(413);
    expect(
      (
        await request(
          `/contents/${item.id}/versions`,
          { baseRevision: 1, title: 'Valid', document },
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/contents/${item.id}/reviews`,
          { baseRevision: 1, action: 'submit', approved: true },
          randomUUID(),
        )
      ).status,
    ).toBe(400);
    expect((await contents.get(ownerId, item.id)).item.currentVersion).toBe(1);
  });
  it('accepts bounded documents above the ordinary 64KB parser limit', async () => {
    const { item } = await fixture();
    const doc = {
      type: 'doc',
      content: Array.from({ length: 6 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x'.repeat(12000) }],
      })),
    };
    const response = await request(
      `/contents/${item.id}/versions`,
      { baseRevision: 1, title: 'Long valid draft', document: doc },
      randomUUID(),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: ContentDetail }).data.item.currentVersion).toBe(2);
  });
  it.each(['json', 'md', 'html'] as const)(
    'exports exact saved %s with escaped text, warnings and attachment headers',
    async (format) => {
      const { item } = await fixture();
      await contents.mutate(
        ownerId,
        item.id,
        'save',
        { baseRevision: 1, title: '<img src=x onerror=alert(1)>', document, note: '' },
        randomUUID(),
      );
      expect((await request(`/contents/${item.id}/export`, { version: 2, format })).status).toBe(
        422,
      );
      const response = await request(`/contents/${item.id}/export`, {
        version: 2,
        format,
        acknowledgeUnreviewed: true,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(`-v2.${format}`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).toContain('模拟内容');
      if (format === 'json')
        expect(JSON.parse(text)).toMatchObject({
          isMock: true,
          approved: false,
          version: 2,
          document,
        });
      else {
        expect(text).not.toContain('<script>');
        expect(text).not.toContain('<img');
        expect(text).toContain('&lt;script&gt;');
        if (format === 'html') {
          expect(text).toContain('Content-Security-Policy');
          expect(text).not.toContain('href=');
        }
        if (format === 'md') expect(text).toContain('\\[click\\]');
      }
      expect((await contents.get(ownerId, item.id)).item.revision).toBe(2);
    },
  );
});
