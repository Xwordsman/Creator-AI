import { z } from 'zod';

export const modelCheckInputSchema = z.strictObject({ confirm: z.literal(true) });
export const modelCheckReceiptSchema = z.object({
  id: z.uuid(),
  modelConnectionId: z.uuid(),
  status: z.enum(['running', 'passed', 'failed', 'unknown']),
});
export interface ModelCheck {
  id: string;
  modelConnectionId: string;
  status: 'running' | 'passed' | 'failed' | 'unknown';
  failureCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  completedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}
export const modelCheckLabels: Record<ModelCheck['status'], string> = {
  running: '检查中',
  passed: '基础协议通过',
  failed: '检查未通过',
  unknown: '调用结果待核对',
};

export function modelFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    PROVIDER_HTTP_400: '接口拒绝了请求参数，请检查模型标识和输出额度参数。',
    PROVIDER_HTTP_401: '服务商拒绝了 API Key，请检查密钥是否有效。',
    PROVIDER_HTTP_403: '服务商拒绝访问，请检查模型权限、余额和服务商限制。',
    PROVIDER_HTTP_404: '接口或模型不存在，请检查基础地址和模型标识。',
    PROVIDER_HTTP_429: '服务商限制了请求，请检查额度或频率后再操作。',
    MODEL_DISABLED: '连接已停用，请启用后再调用。',
    MODELS_NOT_CONFIGURED: '服务器尚未配置真实模型，请联系部署者完成模型设置。',
    MODEL_ENDPOINT_DENIED: '接口地址不在服务器允许的范围内，请核对地址和出站白名单。',
    MODEL_ADDRESS_DENIED: '接口解析到了不允许的地址，请联系部署者核对。',
    MODEL_CHECK_INVALID_OUTPUT: '接口已响应，但未返回要求的 JSON；请核对模型的结构化输出能力。',
    MODEL_CHECK_PREPARATION_FAILED: '发送前准备失败，请检查网络解析和服务器密钥配置。',
    MODEL_CHECK_INTERRUPTED: '检查在发送前中断，没有确认发送外部请求。',
    ASSISTANCE_INVALID_OUTPUT: '模型回复不符合修改建议格式，本轮已停止；可换模型或缩小修改范围。',
  };
  if (messages[code]) return messages[code];
  if (code.includes('UNKNOWN') || code === 'MODEL_CHECK_EXPIRED')
    return '请求结果不确定，可能已产生费用；请先核对服务商记录，系统不会自动重发。';
  if (/^PROVIDER_HTTP_5\d\d$/.test(code))
    return '服务商返回异常，调用结果可能不确定，请先核对服务商记录。';
  return `调用已停止（${code}），请查看调用记录并核对配置。`;
}
