import { z } from 'zod';

const text = z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(20000) });
const block = (allowEmptyHeadings: boolean) =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('paragraph'), content: z.array(text).max(100) }),
    z.strictObject({
      type: z.literal('heading'),
      attrs: z.strictObject({ level: z.union([z.literal(2), z.literal(3)]) }),
      content: z
        .array(text)
        .min(allowEmptyHeadings ? 0 : 1)
        .max(100),
    }),
  ]);
const createDocumentSchema = (allowEmptyHeadings: boolean) =>
  z
    .strictObject({
      type: z.literal('doc'),
      content: z.array(block(allowEmptyHeadings)).min(1).max(200),
    })
    .refine(
      (doc) =>
        doc.content.reduce((n, b) => n + b.content.reduce((s, t) => s + t.text.length, 0), 0) <=
        200000,
      'Document is too large',
    );
export const documentSchema = createDocumentSchema(false);
// Local recovery must also retain an unfinished heading while the author is typing.
export const editingDocumentSchema = createDocumentSchema(true);
export type SafeDocument = z.infer<typeof documentSchema>;
