import { z } from 'zod';

export const writingCardKindLabels = {
  persona: '人物卡',
  writing: '写作卡',
  sample: '范文',
};
export const writingCardSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['persona', 'writing', 'sample']),
  title: z.string().trim().min(1).max(80),
  content: z
    .string()
    .min(1)
    .max(8000)
    .refine(
      (text) =>
        text.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),
      '资料不能为空或包含控制字符',
    ),
  enabled: z.boolean(),
});
export const writingCardsSchema = z
  .array(writingCardSchema)
  .max(8)
  .superRefine((cards, ctx) => {
    if (new Set(cards.map((c) => c.id)).size !== cards.length)
      ctx.addIssue({ code: 'custom', message: '资料标识不能重复' });
    if (cards.reduce((sum, c) => sum + c.content.length, 0) > 24000)
      ctx.addIssue({ code: 'custom', message: '全部资料正文合计不能超过 24,000 字符' });
  });
export const saveWritingCardsSchema = z.strictObject({
  baseRevision: z.number().int().positive(),
  writingCards: writingCardsSchema,
});
export type WritingCard = z.infer<typeof writingCardSchema>;
export type SaveWritingCardsInput = z.infer<typeof saveWritingCardsSchema>;
export interface WritingProfileReceipt {
  source: 'original' | 'current';
  accountRevision: number | null;
  cards: Pick<WritingCard, 'id' | 'kind' | 'title'>[];
}
