import type { ApiFailure, ApiSuccess, Page } from '@creator-ai/contracts';

let csrfToken = '';
export const setCsrfToken = (value: string) => {
  csrfToken = value;
};
let unauthorizedHandler = () => {};
export const setUnauthorizedHandler = (handler: () => void) => {
  unauthorizedHandler = handler;
};
export class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    throw new RequestError('无法连接服务，请检查网络和服务器状态。', 0, 'NETWORK_ERROR');
  }
  let body: ApiSuccess<T> | ApiFailure;
  try {
    body = (await response.json()) as ApiSuccess<T> | ApiFailure;
  } catch {
    throw new RequestError(
      '服务返回了无效响应，请检查 API 配置。',
      response.status,
      'INVALID_RESPONSE',
    );
  }
  if (!response.ok || 'error' in body) {
    if (response.status === 401 && path !== '/auth/login') unauthorizedHandler();
    const error =
      'error' in body ? body.error : { message: '请求失败，请重试。', code: 'REQUEST_FAILED' };
    throw new RequestError(error.message, response.status, error.code);
  }
  return body.data;
}
export function post<T>(path: string, body: unknown, headers?: HeadersInit) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
}
export async function downloadPackage(path: string, filename: string, body?: unknown) {
  const response = await fetch(`/api/v1${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        }),
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler();
    throw new RequestError(
      '导出失败，请刷新登录状态并检查资源是否可用。',
      response.status,
      'EXPORT_FAILED',
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function listAll<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<Page<T>>(`${path}?page=${page}&pageSize=100`);
    result.push(...batch.items);
    if (result.length >= batch.total || batch.items.length === 0) return result;
  }
}
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败，请重试。';
