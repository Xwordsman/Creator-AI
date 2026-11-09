import { describe, expect, it } from 'vitest';
import {
  documentSchema,
  localContentDraftSchema,
  saveContentSchema,
  reviewContentSchema,
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
});
