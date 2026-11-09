import { describe, expect, it } from 'vitest';
import {
  documentSchema,
  localContentDraftSchema,
  saveContentSchema,
  reviewContentSchema,
  contentDetailSchema,
  runReceiptSchema,
  contentTurnReceiptSchema,
  modelCheckReceiptSchema,
} from './index';

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
describe('content document boundary', () => {
  it('accepts empty paragraphs but rejects an empty saved heading', () => {
    expect(
      documentSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })
        .success,
    ).toBe(true);
    expect(
      documentSchema.safeParse({
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 2 }, content: [] }],
      }).success,
    ).toBe(false);
  });
  it('enforces total document length independently of per-node limits', () => {
    expect(
      documentSchema.safeParse({
        type: 'doc',
        content: Array.from({ length: 10 }, () => paragraph('x'.repeat(20000))),
      }).success,
    ).toBe(true);
    expect(
      documentSchema.safeParse({
        type: 'doc',
        content: Array.from({ length: 11 }, () => paragraph('x'.repeat(20000))),
      }).success,
    ).toBe(false);
  });
  it('rejects arbitrary attributes and executable rich content', () => {
    expect(
      documentSchema.safeParse({
        type: 'doc',
        content: [{ ...paragraph('ok'), attrs: { onclick: 'bad' } }],
      }).success,
    ).toBe(false);
    expect(
      documentSchema.safeParse({
        type: 'doc',
        content: [{ type: 'html', text: '<script>x</script>' }],
      }).success,
    ).toBe(false);
  });
  it('retains unfinished local edits without making them saveable', () => {
    const draft = {
      baseRevision: 1,
      title: '',
      note: '',
      document: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [] }] },
    };
    expect(localContentDraftSchema.safeParse(draft).success).toBe(true);
    expect(saveContentSchema.safeParse(draft).success).toBe(false);
  });
  it('requires a reason for change requests and rejects client approval flags', () => {
    expect(
      reviewContentSchema.safeParse({ baseRevision: 1, action: 'request_changes', note: '  ' })
        .success,
    ).toBe(false);
    expect(
      reviewContentSchema.safeParse({ baseRevision: 1, action: 'submit', approved: true }).success,
    ).toBe(false);
  });
  it('requires a matching saved version and immutable mock provenance in a content receipt', () => {
    const version = {
      version: 1,
      title: 'Saved title',
      document: { type: 'doc', content: [paragraph('Saved body')] },
      kind: 'generated',
      restoredFrom: null,
      note: '',
      createdAt: '2026-11-09T00:00:00Z',
    };
    const item = {
      id: '66666666-6666-4666-8666-666666666666',
      sourceRunId: '33333333-3333-4333-8333-333333333333',
      accountName: 'Account',
      platform: 'wechat',
      isMock: true,
      title: version.title,
      status: 'draft',
      currentVersion: 1,
      revision: 1,
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
    };
    expect(contentDetailSchema.safeParse({ item, version }).success).toBe(true);
    for (const change of [
      { currentVersion: 2 },
      { title: 'Different title' },
      { status: 'approved' },
    ])
      expect(contentDetailSchema.safeParse({ item: { ...item, ...change }, version }).success).toBe(
        false,
      );
    expect(contentDetailSchema.safeParse(null).success).toBe(false);
  });
  it('rejects missing identities and unsupported statuses in task and check receipts', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(runReceiptSchema.safeParse({ id, status: 'queued' }).success).toBe(true);
    expect(runReceiptSchema.safeParse({ id: '', status: 'queued' }).success).toBe(false);
    expect(runReceiptSchema.safeParse({ id, status: 'published' }).success).toBe(false);
    expect(contentTurnReceiptSchema.safeParse({ id, status: 'queued' }).success).toBe(false);
    expect(modelCheckReceiptSchema.safeParse({ id, status: 'passed' }).success).toBe(false);
    expect(
      modelCheckReceiptSchema.safeParse({ id, modelConnectionId: id, status: 'passed' }).success,
    ).toBe(true);
  });
});
