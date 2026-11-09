import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SessionInfo } from '@creator-ai/contracts';
import { errorMessage, post, request, RequestError, setCsrfToken } from '../api/client';

export const useSessionStore = defineStore('session', () => {
  const info = ref<SessionInfo | null>(null);
  const connectionError = ref('');
  function apply(value: SessionInfo | null) {
    info.value = value;
    setCsrfToken(value?.csrfToken ?? '');
  }
  async function refresh(): Promise<boolean> {
    try {
      apply(await request<SessionInfo>('/auth/session'));
      connectionError.value = '';
      return true;
    } catch (error) {
      apply(null);
      connectionError.value =
        error instanceof RequestError && error.status === 401 ? '' : errorMessage(error);
      return false;
    }
  }
  async function login(username: string, secret: string) {
    apply(await post<SessionInfo>('/auth/login', { username, password: secret }));
    connectionError.value = '';
  }
  async function logout() {
    await post('/auth/logout', {});
    apply(null);
  }
  function clear() {
    apply(null);
  }
  return { info, connectionError, refresh, login, logout, clear };
});
