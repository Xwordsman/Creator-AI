import { afterEach, describe, expect, it, vi } from 'vitest';
import { post, request, setCsrfToken, setUnauthorizedHandler } from './client';

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
});
