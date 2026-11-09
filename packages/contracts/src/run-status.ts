import { z } from 'zod';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'cancelled',
  'needs_review',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
// A successful HTTP envelope alone is not proof that a task was accepted.
export const runReceiptSchema = z.object({ id: z.uuid(), status: runStatusSchema });
