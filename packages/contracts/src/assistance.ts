import { z } from 'zod';
import { documentSchema, type SafeDocument } from './document';
import type { Account, RunStatus } from './index';
import type { WritingProfileReceipt } from './writing-cards';

export const contentAnnotationSchema = z
  .strictObject({
    id: z.uuid(),
    blockIndex: z.number().int().min(0).max(199).nullable(),
    blockText: z.string().max(200000).default(''),
    quote: z.string().max(2000).default(''),
    kind: z.enum(['change', 'keep']),
    note: z.string().trim().max(1500).default(''),
  })
  .refine(
    (a) => (a.kind === 'keep' ? a.blockIndex !== null : a.note.length > 0),
    'A change needs a note; keep applies to a specific block',
  );
export const contentTurnInputSchema = z
  .strictObject({
    baseRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    document: documentSchema,
    mode: z.enum(['discuss', 'revise']),
    message: z.string().trim().max(4000).default(''),
    annotations: z.array(contentAnnotationSchema).max(20).default([]),
    modelConnectionId: z.uuid().optional(),
    accountProfileRevision: z.number().int().positive().optional(),
  })
  .refine(
    (v) => v.message.length >= 2 || v.annotations.length > 0,
    'Please add a message or annotation',
  );
export const contentSuggestionSchema = z.strictObject({
  id: z.string().min(1).max(80),
  blockIndex: z.number().int().min(0).max(199).nullable(),
  before: z.string().max(200000),
  after: z.string().max(20000),
  reason: z.string().trim().min(1).max(1500),
  annotationIds: z.array(z.uuid()).max(20).default([]),
});
export const contentAssistantResultSchema = z.strictObject({
  reply: z.string().trim().min(1).max(8000),
  suggestions: z.array(contentSuggestionSchema).max(20),
});
export type ContentAnnotation = z.infer<typeof contentAnnotationSchema>;
export type ContentSuggestion = z.infer<typeof contentSuggestionSchema>;
export type ContentTurnInput = z.infer<typeof contentTurnInputSchema>;
export type ContentAssistantResult = z.infer<typeof contentAssistantResultSchema>;
export interface ContentSelection {
  blockIndex: number;
  blockText: string;
  quote: string;
}
export const localAssistantDraftSchema = z.strictObject({
  mode: z.enum(['discuss', 'revise']),
  message: z.string().max(4000),
  annotations: z.array(contentAnnotationSchema).max(20),
  modelConnectionId: z.union([z.uuid(), z.literal('')]),
  note: z.string().max(1500),
  accountProfileRevision: z.number().int().positive().optional(),
});
export interface Manuscript {
  title: string;
  document: SafeDocument;
}
export interface ContentAssistanceContext extends Manuscript {
  contentId: string;
  baseRevision: number;
  baseVersion: number;
  mode: ContentTurnInput['mode'];
  message: string;
  annotations: ContentAnnotation[];
  history: { role: 'user' | 'assistant'; content: string }[];
  historyTruncated: boolean;
  writingProfile?: WritingProfileReceipt;
}
export interface ContentTurn {
  id: string;
  contentId: string;
  baseRevision: number;
  baseVersion: number;
  mode: ContentTurnInput['mode'];
  message: string;
  annotations: ContentAnnotation[];
  status: RunStatus;
  modelName: string;
  isMock: boolean;
  result: ContentAssistantResult | null;
  failureCode: string | null;
  historyTruncated: boolean;
  createdAt: string;
  writingProfile?: WritingProfileReceipt;
}
export interface ContentWritingProfiles {
  original: Omit<Account, 'revision'> & { revision?: number };
  current: Account;
}
export interface ContentTurnDetail extends ContentTurn {
  manuscript: Manuscript;
}
export const contentAssistanceLimits = {
  maxCalls: 4,
  maxTotalTokens: 64000,
  maxDurationSeconds: 180,
};
export const blockText = (block: SafeDocument['content'][number]) =>
  block.content.map((t) => t.text).join('');
// Compare semantic content, not JSON object key order (PostgreSQL JSONB reorders keys).
export function manuscriptKey(manuscript: Manuscript): string {
  return JSON.stringify([
    manuscript.title.trim(),
    manuscript.document.content.map((b) => [
      b.type,
      b.type === 'heading' ? b.attrs.level : null,
      blockText(b),
    ]),
  ]);
}
export function validateAnnotations(manuscript: Manuscript, annotations: ContentAnnotation[]) {
  if (new Set(annotations.map((a) => a.id)).size !== annotations.length)
    throw new Error('批注标识重复。');
  for (const a of annotations) {
    if (a.blockIndex === null) {
      if (a.kind === 'keep' || a.blockText || a.quote)
        throw new Error('整篇批注不能携带段落锚点。');
      continue;
    }
    const b = manuscript.document.content[a.blockIndex];
    if (!b || blockText(b) !== a.blockText || (a.quote && !a.blockText.includes(a.quote)))
      throw new Error('批注对应的段落已变化，请重新选择该段后提交。');
  }
}
export function validateAssistantResult(
  context: Pick<ContentAssistanceContext, 'mode' | 'title' | 'document' | 'annotations'>,
  result: ContentAssistantResult,
): ContentAssistantResult {
  validateAnnotations(context, context.annotations);
  if (context.mode === 'discuss' && result.suggestions.length)
    throw new Error('讨论模式不能修改正文。');
  const ids = new Set<string>(),
    targets = new Set<number | null>();
  const changed = context.annotations.filter((a) => a.kind === 'change');
  const scoped =
    changed.some((a) => a.blockIndex !== null) && !changed.some((a) => a.blockIndex === null);
  const next: SafeDocument = JSON.parse(JSON.stringify(context.document));
  for (const s of result.suggestions) {
    if (ids.has(s.id) || targets.has(s.blockIndex)) throw new Error('修改建议标识或目标重复。');
    ids.add(s.id);
    targets.add(s.blockIndex);
    if (
      s.annotationIds.some(
        (id) =>
          !context.annotations.some(
            (a) =>
              a.id === id &&
              a.kind === 'change' &&
              (a.blockIndex === null || a.blockIndex === s.blockIndex),
          ),
      )
    )
      throw new Error('修改建议引用了未知批注。');
    if (scoped && !changed.some((a) => a.blockIndex === s.blockIndex))
      throw new Error('修改超出了批注范围。');
    if (context.annotations.some((a) => a.kind === 'keep' && a.blockIndex === s.blockIndex))
      throw new Error('不能修改标记为保留的段落。');
    const b = s.blockIndex === null ? null : context.document.content[s.blockIndex];
    const before = s.blockIndex === null ? context.title : b ? blockText(b) : undefined;
    if (before === undefined || before !== s.before || s.before === s.after)
      throw new Error('修改建议的原文锚点无效。');
    if (s.blockIndex === null && (!s.after.trim() || s.after.length > 300))
      throw new Error('建议标题长度无效。');
    if (b?.type === 'heading' && !s.after.trim()) throw new Error('不能清空标题段落。');
    if (s.blockIndex !== null)
      next.content[s.blockIndex]!.content = s.after ? [{ type: 'text', text: s.after }] : [];
  }
  documentSchema.parse(next);
  return result;
}
export function applyContentSuggestions(
  current: Manuscript,
  turn: ContentTurnDetail,
  selectedIds: string[],
): Manuscript {
  if (turn.status !== 'succeeded' || turn.isMock || !turn.result || turn.mode !== 'revise')
    throw new Error('此轮没有可应用的真实修改建议。');
  if (manuscriptKey(current) !== manuscriptKey(turn.manuscript))
    throw new Error('正文或标题已变化。旧建议不会覆盖新稿，请基于当前稿重新提出修改。');
  if (
    !selectedIds.length ||
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !turn.result!.suggestions.some((s) => s.id === id))
  )
    throw new Error('请选择有效的修改建议。');
  validateAssistantResult(
    { ...turn.manuscript, mode: turn.mode, annotations: turn.annotations },
    turn.result,
  );
  const next: Manuscript = JSON.parse(JSON.stringify(current));
  for (const s of turn.result.suggestions.filter((s) => selectedIds.includes(s.id))) {
    if (s.blockIndex === null) next.title = s.after.trim();
    else
      next.document.content[s.blockIndex]!.content = s.after
        ? [{ type: 'text', text: s.after }]
        : [];
  }
  documentSchema.parse(next.document);
  return next;
}
