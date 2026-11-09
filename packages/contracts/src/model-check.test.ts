import { describe, expect, it } from 'vitest';
import { modelCheckInputSchema, modelFailureMessage } from './model-check';

describe('Explicit model protocol check', () => {
  it('requires explicit confirmation and never accepts custom text or credentials', () => {
    expect(modelCheckInputSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const input of [
      {},
      { confirm: false },
      { confirm: true, text: 'private article' },
      { confirm: true, apiKey: 'key' },
    ])
      expect(modelCheckInputSchema.safeParse(input).success).toBe(false);
  });
  it('explains credential, quota, format and unknown errors without implying free retries', () => {
    expect(modelFailureMessage('PROVIDER_HTTP_401')).toContain('API Key');
    expect(modelFailureMessage('PROVIDER_HTTP_429')).toContain('额度');
    expect(modelFailureMessage('MODEL_CHECK_INVALID_OUTPUT')).toContain('JSON');
    expect(modelFailureMessage('PROVIDER_TIMEOUT_UNKNOWN')).toContain('不会自动重发');
    expect(modelFailureMessage('MODEL_CHECK_EXPIRED')).toContain('不确定');
  });
});
