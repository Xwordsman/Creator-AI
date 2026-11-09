import { z } from 'zod';
import type { RunStatus } from './run-status';
export * from './run-status';
import { writingCardsSchema } from './writing-cards';
export * from './writing-cards';
import { documentSchema } from './document';
import {
  contentAssistantResultSchema,
  type ContentAssistantResult,
  type ContentAssistanceContext,
} from './assistance';
export * from './assistance';
export * from './document';
export * from './content';
import type { Expert, Skill } from './catalog';
import { runLimitsSchema, type ModelSnapshot, type RunExecution, type RunLimits } from './runtime';
export * from './catalog';
export * from './runtime';
export * from './model-check';

export const platformSchema = z.enum(['wechat', 'toutiao', 'generic']);
export const accountInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  platform: platformSchema,
  audience: z.string().trim().min(1).max(500),
  persona: z.string().trim().min(1).max(3000),
  defaultExpertId: z.uuid().nullable().optional(),
  writingCards: writingCardsSchema.optional(),
});
export type AccountInput = z.infer<typeof accountInputSchema>;
export interface Account extends AccountInput {
  id: string;
  revision: number;
  defaultExpertId: string | null;
  createdAt: string;
}
export const accountDefaultExpertSchema = z.strictObject({
  expertId: z.uuid().nullable(),
  baseRevision: z.number().int().positive(),
});
export type AccountDefaultExpertInput = z.infer<typeof accountDefaultExpertSchema>;

export const skillKeys = ['article-outline', 'plain-writing', 'fact-check'] as const;
export const BUILTIN_SKILLS: Skill[] = [
  {
    key: 'article-outline',
    version: 1,
    name: '文章大纲',
    description: '从读者的问题出发，组织清晰的文章结构。',
    instructions: '先明确读者问题，再组织开头、论点、行动建议；不要编造事实。',
    allowedTools: [],
  },
  {
    key: 'plain-writing',
    version: 1,
    name: '通俗表达',
    description: '减少术语与套话，遵循账号的人设和表达习惯。',
    instructions: '优先使用简洁、自然的表达。账号人设优先于专家的默认语气。',
    allowedTools: [],
  },
  {
    key: 'fact-check',
    version: 1,
    name: '疑点标注',
    description: '标记需要核实的观点，不把生成内容当作查证结果。',
    instructions: '对无来源的数据和事实标记待核实；不得声称完成外部事实核查。',
    allowedTools: [],
  },
];

export const loginSchema = z.strictObject({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
});
export interface SessionInfo {
  user: { id: string; username: string };
  csrfToken: string;
  expiresAt: string;
}
export const createRunSchema = z.strictObject({
  accountId: z.uuid(),
  expertId: z.uuid().optional(),
  accountRevision: z.number().int().positive().optional(),
  topic: z.string().trim().min(2).max(300),
  brief: z.string().trim().max(2000).default(''),
  modelConnectionId: z.uuid().optional(),
  teamMode: z.enum(['staged', 'dynamic']).optional(),
  limits: runLimitsSchema.optional(),
});
export type CreateRunInput = z.infer<typeof createRunSchema>;
export const continueRunSchema = z.strictObject({
  instruction: z.string().trim().min(2).max(2000),
});
export type ContinueRunInput = z.infer<typeof continueRunSchema>;
export interface RunLineage {
  parentRunId: string;
  rootRunId: string;
  depth: number;
}
export interface RunSnapshot {
  schemaVersion: 1;
  topic: string;
  brief: string;
  account: Account;
  expert: Expert;
  skills: Skill[];
  provider: 'mock' | 'compatible';
  workflow: 'mock-article-v1' | 'agent-v1' | 'team-v1' | 'team-dynamic-v1' | 'content-assist-v1';
  model?: ModelSnapshot;
  limits?: RunLimits;
  skillSelection?: { available: string[]; preloaded: string[]; loaded: string[] };
  continuation?: RunLineage & { instruction: string; previousOutput: RunOutput };
  assistance?: ContentAssistanceContext;
}
export interface DocumentNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
}
export interface RunOutput {
  schemaVersion: 1;
  title: string;
  document: DocumentNode;
  isMock: boolean;
  reviewStatus: 'pending_review';
  assistance?: ContentAssistantResult;
}
// Generated and human-edited drafts share the same plain-block safety boundary.
export const runOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(300),
  document: documentSchema,
  isMock: z.boolean(),
  reviewStatus: z.literal('pending_review'),
  assistance: contentAssistantResultSchema.optional(),
});
export interface CreationRun {
  id: string;
  status: RunStatus;
  revision: number;
  attempts: number;
  snapshot: RunSnapshot;
  output: RunOutput | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  execution?: RunExecution;
  cancelRequested?: boolean;
  lineage?: RunLineage;
}
export interface RunHistoryItem {
  id: string;
  status: RunStatus;
  createdAt: string;
  lineage?: RunLineage;
  instruction: string | null;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}
export interface ApiFailure {
  error: { code: string; message: string; retryable: boolean };
  requestId: string;
}
export const runStatusLabels: Record<RunStatus, string> = {
  queued: '排队中',
  running: '创作中',
  waiting_user: '等待你的答复',
  succeeded: '待审核',
  failed: '执行失败',
  cancelled: '已取消',
  needs_review: '调用结果待核对',
};
export function isTerminal(status: RunStatus): boolean {
  return ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(status);
}
