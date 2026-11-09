import { describe, expect, it } from 'vitest';
import {
  applyContentSuggestions,
  blockText,
  contentTurnInputSchema,
  contentAssistantResultSchema,
  manuscriptKey,
  validateAnnotations,
  validateAssistantResult,
  type ContentAnnotation,
  type ContentAssistanceContext,
  type ContentSuggestion,
  type ContentTurnDetail,
} from './assistance';

const note: ContentAnnotation = {
  id: 'c258e3c1-96b0-4486-b6fc-5b6c9bb36358',
  blockIndex: 0,
  blockText: 'Original first',
  quote: 'first',
  kind: 'change',
  note: 'Be specific',
};
const context: ContentAssistanceContext = {
  contentId: 'fixture',
  baseRevision: 1,
  baseVersion: 1,
  title: 'Article',
  mode: 'revise',
  message: 'Revise',
  annotations: [note],
  history: [],
  historyTruncated: false,
  document: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Original first' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
    ],
  },
};
const patch: ContentSuggestion = {
  id: 's1',
  blockIndex: 0,
  before: 'Original first',
  after: 'More concrete',
  reason: 'Specific',
  annotationIds: [note.id],
};
const result = (s = patch) => ({ reply: 'Suggested, not applied.', suggestions: [s] });
const turn: ContentTurnDetail = {
  id: 'turn',
  ...context,
  manuscript: context,
  status: 'succeeded',
  modelName: 'Fixture',
  isMock: false,
  failureCode: null,
  result: result(),
  createdAt: '',
};

describe('Article assistance boundaries', () => {
  it('takes the actual current draft and rejects client-supplied tools/history', () => {
    const input = {
      baseRevision: 1,
      title: context.title,
      document: context.document,
      mode: 'revise',
      annotations: [note],
    };
    expect(contentTurnInputSchema.parse(input).annotations).toEqual([note]);
    expect(contentTurnInputSchema.safeParse({ ...input, history: [] }).success).toBe(false);
    expect(
      contentTurnInputSchema.safeParse({ ...input, annotations: [{ ...note, note: '' }] }).success,
    ).toBe(false);
  });
  it('validates complete paragraph anchors, quotes and annotation identities', () => {
    expect(() => validateAnnotations(context, [note])).not.toThrow();
    for (const bad of [
      { ...note, blockText: 'old' },
      { ...note, quote: 'absent' },
      { ...note, blockIndex: 199 },
      { ...note, blockIndex: null },
    ])
      expect(() => validateAnnotations(context, [bad])).toThrow();
    expect(() => validateAnnotations(context, [note, note])).toThrow();
  });
  it('discussion never carries changes', () => {
    expect(() => validateAssistantResult({ ...context, mode: 'discuss' }, result())).toThrow();
    expect(() =>
      validateAssistantResult(
        { ...context, mode: 'discuss' },
        { reply: 'Question?', suggestions: [] },
      ),
    ).not.toThrow();
  });
  it('rejects out-of-scope, protected and wrongly attributed suggestions', () => {
    expect(() =>
      validateAssistantResult(context, result({ ...patch, blockIndex: 1, before: 'Heading' })),
    ).toThrow();
    expect(() =>
      validateAssistantResult(context, result({ ...patch, blockIndex: null, before: 'Article' })),
    ).toThrow();
    expect(() =>
      validateAssistantResult(
        { ...context, annotations: [{ ...note, kind: 'keep' }] },
        result({ ...patch, annotationIds: [] }),
      ),
    ).toThrow();
    expect(() =>
      validateAssistantResult(context, result({ ...patch, annotationIds: ['unknown'] })),
    ).toThrow();
  });
  it('whole-article requests still cannot change protected paragraphs', () => {
    const annotations: ContentAnnotation[] = [
      { ...note, blockIndex: null, blockText: '', quote: '' },
      { ...note, id: 'bcaf07b0-92f1-43e4-9f77-45d6ae6ad754', kind: 'keep' },
    ];
    expect(() => validateAssistantResult({ ...context, annotations }, result())).toThrow();
  });
  it.each([{ before: 'old' }, { after: patch.before }, { blockIndex: 199 }])(
    'rejects stale, no-op and missing targets %s',
    (bad) => {
      expect(() => validateAssistantResult(context, result({ ...patch, ...bad }))).toThrow();
    },
  );
  it('rejects duplicate targets and IDs', () => {
    expect(() =>
      validateAssistantResult(context, {
        reply: 'a',
        suggestions: [patch, { ...patch, id: 's2' }],
      }),
    ).toThrow();
  });
  it('validates title, heading and total document limits before offering edits', () => {
    const unscoped = { ...context, annotations: [] };
    for (const after of ['', 'x'.repeat(301)])
      expect(() =>
        validateAssistantResult(
          unscoped,
          result({ ...patch, blockIndex: null, before: 'Article', after, annotationIds: [] }),
        ),
      ).toThrow();
    expect(() =>
      validateAssistantResult(
        unscoped,
        result({ ...patch, blockIndex: 1, before: 'Heading', after: '', annotationIds: [] }),
      ),
    ).toThrow();
    const long = {
      ...unscoped,
      document: {
        type: 'doc' as const,
        content: Array.from({ length: 200 }, () => ({
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: 'x'.repeat(1000) }],
        })),
      },
    };
    expect(() =>
      validateAssistantResult(
        long,
        result({ ...patch, before: 'x'.repeat(1000), after: 'x'.repeat(1001), annotationIds: [] }),
      ),
    ).toThrow();
  });
  it('tolerates JSONB key order and equivalent text segmentation', () => {
    const reordered = JSON.parse(
      JSON.stringify(context, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    );
    reordered.document.content[0].content = [
      { type: 'text', text: 'Original ' },
      { type: 'text', text: 'first' },
    ];
    expect(manuscriptKey(reordered)).toBe(manuscriptKey(context));
    expect(blockText(applyContentSuggestions(reordered, turn, ['s1']).document.content[0]!)).toBe(
      patch.after,
    );
  });
  it('applies only selected changes, keeping the source and unselected title intact', () => {
    const titlePatch = {
      ...patch,
      id: 's2',
      blockIndex: null,
      before: 'Article',
      after: 'New title',
      annotationIds: [],
    };
    const changed = applyContentSuggestions(
      context,
      {
        ...turn,
        annotations: [],
        result: { reply: 'a', suggestions: [{ ...patch, annotationIds: [] }, titlePatch] },
      },
      ['s1'],
    );
    expect(changed.title).toBe('Article');
    expect(blockText(context.document.content[0]!)).toBe(patch.before);
  });
  it('never applies to a newer local draft or from mock, failed or invalid selection', () => {
    expect(() =>
      applyContentSuggestions({ ...context, title: 'My new title' }, turn, ['s1']),
    ).toThrow();
    expect(() => applyContentSuggestions(context, { ...turn, isMock: true }, ['s1'])).toThrow();
    expect(() => applyContentSuggestions(context, { ...turn, status: 'failed' }, ['s1'])).toThrow();
    for (const ids of [[], ['unknown'], ['s1', 's1']])
      expect(() => applyContentSuggestions(context, turn, ids)).toThrow();
  });
  it('enforces a strict output protocol, not model-controlled markup or operations', () => {
    expect(
      contentAssistantResultSchema.safeParse({ ...result(), html: '<script>x</script>' }).success,
    ).toBe(false);
    expect(
      contentAssistantResultSchema.safeParse(result({ ...patch, after: 'x'.repeat(20001) }))
        .success,
    ).toBe(false);
  });
});
