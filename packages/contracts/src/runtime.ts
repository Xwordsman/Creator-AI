import { z } from 'zod';

export const modelConnectionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url().max(500),
  model: z.string().trim().min(1).max(120),
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  tokenParameter: z.enum(['max_completion_tokens', 'max_tokens']).default('max_completion_tokens'),
  maxInputTokens: z.number().int().min(1000).max(64000).default(16000),
  maxOutputTokens: z.number().int().min(256).max(16000).default(4096),
});
export type ModelConnectionInput = z.infer<typeof modelConnectionInputSchema>;
export interface ModelSnapshot extends Omit<ModelConnectionInput, 'apiKey'> {
  id: string;
}
export interface ModelConnection extends ModelSnapshot {
  enabled: boolean;
  createdAt: string;
  hasKey: true;
}
export interface RuntimeCapabilities {
  modelMode: 'mock' | 'configured';
  canConfigureModels: boolean;
  allowedHosts: string[];
  tools: string[];
}
export const runLimitsSchema = z.strictObject({
  maxCalls: z.number().int().min(1).max(100).default(24),
  maxTotalTokens: z.number().int().min(2000).max(1000000).default(200000),
  maxDurationSeconds: z.number().int().min(30).max(1800).default(600),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;
export type InvocationStatus = 'reserved' | 'in_flight' | 'succeeded' | 'rejected' | 'unknown';
export interface ModelInvocation {
  id: string;
  agentRunId: string;
  turn: number;
  status: InvocationStatus;
  reservedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  providerRequestId: string | null;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface AgentExecution {
  id: string;
  agentId: string;
  name: string;
  role: 'agent' | 'member' | 'lead' | 'planner';
  phase: number;
  task: string;
  dependencies: string[];
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  loadedSkillKeys: string[];
  result: string | null;
  failureCode: string | null;
}
export interface ToolExecution {
  id: string;
  agentRunId: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  status: 'succeeded' | 'denied';
  createdAt: string;
}
export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  kind: 'assignment' | 'report' | 'question' | 'answer' | 'plan' | 'confirmation';
  content: string;
  createdAt: string;
}
export interface RunExecution {
  agents: AgentExecution[];
  invocations: ModelInvocation[];
  tools: ToolExecution[];
  messages: TeamMessage[];
  reconciliations: { id: string; note: string; createdAt: string }[];
  collaboration?: TeamAction[];
  usage: {
    calls: number;
    chargedTokens: number;
    reservedTokens: number;
    reportedInputTokens: number;
    reportedOutputTokens: number;
    hasEstimatedUsage: boolean;
  };
}
export const reconciliationSchema = z.strictObject({
  note: z.string().trim().min(10).max(2000),
});

const question = z.string().trim().min(2).max(2000);
export const teamDirectiveSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('delegate'),
    summary: question,
    tasks: z
      .array(
        z.strictObject({
          memberId: z.string().min(1).max(80),
          task: question,
          dependencies: z.array(z.uuid()).max(24),
        }),
      )
      .min(1)
      .max(11),
  }),
  z.strictObject({ action: z.literal('ask_user'), question }),
  z.strictObject({ action: z.literal('confirm'), question }),
  z.strictObject({ action: z.literal('finalize'), summary: question }),
  z.strictObject({ action: z.literal('deliver'), content: z.string().trim().min(1).max(100000) }),
  z.strictObject({
    action: z.literal('request_peer'),
    memberId: z.string().min(1).max(80),
    question,
  }),
]);
export type TeamDirective = z.infer<typeof teamDirectiveSchema>;
export const teamResponseSchema = z.strictObject({
  answer: z.string().trim().min(2).max(2000),
  approved: z.boolean().optional(),
});
export type TeamResponse = z.infer<typeof teamResponseSchema>;
export interface TeamAction {
  id: string;
  sourceAgentRunId: string;
  directive: TeamDirective;
  state: 'waiting' | 'applied' | 'peer_wait';
  response: TeamResponse | null;
  spawnedAgentIds: string[];
  createdAt: string;
}
