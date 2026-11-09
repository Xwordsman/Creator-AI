import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import type { ModelSnapshot } from '@creator-ai/contracts';
import { resolveModelAddress, validateModelUrl } from './model-security';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ModelReply {
  message: ChatMessage;
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
}
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly ambiguous: boolean,
  ) {
    super(code);
  }
}
const replySchema = z.object({
  id: z.string().max(300).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().max(100000).nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                type: z.literal('function'),
                function: z.object({
                  name: z.string().min(1).max(80),
                  arguments: z.string().max(8000),
                }),
              }),
            )
            .max(8)
            .optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().max(10000000),
      completion_tokens: z.number().int().nonnegative().max(10000000),
    })
    .optional(),
});
export const skillTools = [
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load the complete instructions for one skill available to you.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description:
        'Read a UTF-8 reference or asset from an already loaded skill. Never executes files.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' }, path: { type: 'string' } },
        required: ['key', 'path'],
        additionalProperties: false,
      },
    },
  },
];
export function makeModelBody(model: ModelSnapshot, messages: ChatMessage[], allowTools: boolean) {
  return {
    model: model.model,
    messages,
    [model.tokenParameter]: model.maxOutputTokens,
    ...(allowTools ? { tools: skillTools, tool_choice: 'auto' } : {}),
    stream: false,
  };
}

export class CompatibleProvider {
  // Resolve before dispatch, then pin the verified address on the actual socket.
  async prepare(model: ModelSnapshot) {
    const url = validateModelUrl(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`);
    return { url, address: await resolveModelAddress(url) };
  }
  async call(
    target: Awaited<ReturnType<CompatibleProvider['prepare']>>,
    apiKey: string,
    body: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<ModelReply> {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        target.url,
        {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': data.length,
            'X-Client-Request-Id': id,
          },
          family: target.address.family,
          lookup: (_hostname, _options, callback) =>
            callback(null, target.address.address, target.address.family),
          timeout: 60000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              request.destroy(new ProviderError('PROVIDER_RESPONSE_TOO_LARGE', true));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new ProviderError('PROVIDER_TRANSPORT_UNKNOWN', true)));
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new ProviderError(
                  `PROVIDER_HTTP_${status}`,
                  ![400, 401, 403, 404, 405, 413, 415, 422, 429].includes(status),
                ),
              );
              return;
            }
            try {
              const parsed = replySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              const choice = parsed.choices[0]!;
              const message: ChatMessage = {
                role: 'assistant',
                content: choice.message.content ?? null,
                ...(choice.message.tool_calls?.length
                  ? { tool_calls: choice.message.tool_calls }
                  : {}),
              };
              if (
                message.tool_calls &&
                new Set(message.tool_calls.map((tool) => tool.id)).size !==
                  message.tool_calls.length
              )
                throw new Error('Duplicate tool calls');
              if (!['stop', 'tool_calls'].includes(choice.finish_reason))
                throw new Error('Incomplete completion');
              resolve({
                message,
                inputTokens: parsed.usage?.prompt_tokens ?? null,
                outputTokens: parsed.usage?.completion_tokens ?? null,
                requestId:
                  (response.headers['x-request-id']?.toString() ?? parsed.id ?? '').slice(0, 300) ||
                  null,
              });
            } catch {
              reject(new ProviderError('PROVIDER_RESPONSE_UNKNOWN', true));
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new ProviderError('PROVIDER_TIMEOUT_UNKNOWN', true)),
      );
      request.on('error', (error) =>
        reject(
          error instanceof ProviderError
            ? error
            : new ProviderError('PROVIDER_TRANSPORT_UNKNOWN', true),
        ),
      );
      request.end(data);
    });
  }
}
