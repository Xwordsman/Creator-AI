import { z } from 'zod';
import { documentSchema, editingDocumentSchema, type SafeDocument } from './document';

export const promoteContentSchema = z.strictObject({ sourceRunId: z.uuid() });
export const saveContentSchema = z.strictObject({
  baseRevision: z.number().int().min(1),
  title: z.string().trim().min(1).max(300),
  document: documentSchema,
  note: z.string().trim().max(1000).default(''),
});
export const localContentDraftSchema = saveContentSchema.extend({
  title: z.string().max(300),
  document: editingDocumentSchema,
});
export const restoreContentSchema = z.strictObject({
  baseRevision: z.number().int().min(1),
  version: z.number().int().min(1),
});
export const reviewContentSchema = z
  .strictObject({
    baseRevision: z.number().int().min(1),
    action: z.enum(['submit', 'approve', 'request_changes']),
    note: z.string().trim().max(2000).default(''),
  })
  .refine(
    (v) => v.action !== 'request_changes' || v.note.length > 0,
    'A change request needs a note',
  );
export const exportContentSchema = z.strictObject({
  version: z.number().int().min(1),
  format: z.enum(['json', 'md', 'html']),
  acknowledgeUnreviewed: z.boolean().default(false),
});
export type SaveContentInput = z.infer<typeof saveContentSchema>;
export type RestoreContentInput = z.infer<typeof restoreContentSchema>;
export type ReviewContentInput = z.infer<typeof reviewContentSchema>;
export type ExportContentInput = z.infer<typeof exportContentSchema>;
export type ContentStatus = 'draft' | 'pending_review' | 'approved' | 'changes_requested';
export const contentStatusLabels: Record<ContentStatus, string> = {
  draft: '编辑中',
  pending_review: '待审核',
  approved: '已通过',
  changes_requested: '需修改',
};
export interface ContentItem {
  id: string;
  sourceRunId: string;
  accountName: string;
  platform: string;
  isMock: boolean;
  title: string;
  status: ContentStatus;
  currentVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ContentVersion {
  version: number;
  title: string;
  document: SafeDocument;
  kind: 'generated' | 'edit' | 'restore';
  restoredFrom: number | null;
  note: string;
  createdAt: string;
}
export interface ContentReview {
  id: string;
  version: number;
  action: ReviewContentInput['action'];
  note: string;
  createdAt: string;
}
export interface ContentDetail {
  item: ContentItem;
  version: ContentVersion;
}

export const contentVersionSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().min(1).max(300),
  document: documentSchema,
  kind: z.enum(['generated', 'edit', 'restore']),
  restoredFrom: z.number().int().min(1).nullable(),
  note: z.string().max(1000),
  createdAt: z.iso.datetime({ offset: true }),
});
// Validate a receipt before replacing a local manuscript or removing its recovery record.
export const contentDetailSchema = z
  .object({
    item: z.object({
      id: z.uuid(),
      sourceRunId: z.uuid(),
      accountName: z.string().min(1).max(80),
      platform: z.string().min(1).max(40),
      isMock: z.boolean(),
      title: z.string().min(1).max(300),
      status: z.enum(['draft', 'pending_review', 'approved', 'changes_requested']),
      currentVersion: z.number().int().min(1),
      revision: z.number().int().min(1),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
    version: contentVersionSchema,
  })
  .refine(
    ({ item, version }) =>
      item.currentVersion === version.version &&
      item.title === version.title &&
      !(item.isMock && item.status === 'approved'),
    'Content receipt does not match its saved version or provenance',
  );
