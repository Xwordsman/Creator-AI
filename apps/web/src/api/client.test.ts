import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDefinitiveRequestError,
  post,
  request,
  RequestError,
  setCsrfToken,
  setUnauthorizedHandler,
} from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken('');
  setUnauthorizedHandler(() => {});
});
describe('API client', () => {
  it('sends cookies and the session CSRF token without persisting secrets', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { saved: true }, requestId: 'request' }),
    });
    vi.stubGlobal('fetch', fetcher);
    setCsrfToken('test-csrf');
    expect(await post('/accounts', { name: 'Test' })).toEqual({ saved: true });
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect((options.headers as Headers).get('X-CSRF-Token')).toBe('test-csrf');
    expect(options.credentials).toBe('same-origin');
  });
  it('preserves conflict error details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Conflict', retryable: false },
        }),
      }),
    );
    await expect(request('/creation-runs')).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('shows a readable network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('/accounts')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
  it('invalidates expired sessions but not a failed login attempt', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'AUTH_REQUIRED', message: 'Login required', retryable: false },
        }),
      }),
    );
    await expect(post('/auth/login', {})).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    await expect(request('/accounts')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it.each(
    [null, [], 42, 'invalid', {}, { requestId: 'request' }, { error: null }, { error: {} }].map(
      (body) => ({ body }),
    ),
  )('rejects malformed JSON envelopes instead of treating $body as success', async ({ body }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }),
    );
    await expect(post('/contents/id/versions', {})).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    });
  });
  it('allows an explicit null data value in a valid success envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) }),
    );
    expect(await request('/nullable')).toBeNull();
  });
  it('invalidates a session even when a proxy returns a non-JSON 401 response', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => {
          throw new SyntaxError('Invalid JSON');
        },
      }),
    );
    await expect(request('/accounts')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_RESPONSE',
    });
    expect(handler).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 400, code: 'INVALID_INPUT', definitive: true },
    { status: 409, code: 'CONTENT_CONFLICT', definitive: true },
    { status: 408, code: 'REQUEST_TIMEOUT', definitive: false },
    { status: 429, code: 'RATE_LIMIT', definitive: false },
    { status: 503, code: 'UNAVAILABLE', definitive: false },
    { status: 400, code: 'INVALID_RESPONSE', definitive: false },
    { status: 0, code: 'NETWORK_ERROR', definitive: false },
  ])(
    'classifies $status / $code without discarding uncertain requests',
    ({ status, code, definitive }) => {
      expect(isDefinitiveRequestError(new RequestError('fixture', status, code))).toBe(definitive);
    },
  );
});
