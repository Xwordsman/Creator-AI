import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { RuntimeCapabilities } from '@creator-ai/contracts';
import { errorMessage, request } from '../api/client';

export const useRuntimeStore = defineStore('runtime', () => {
  const capabilities = ref<RuntimeCapabilities | null>(null);
  const error = ref('');
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    error.value = '';
    try {
      const result = await request<RuntimeCapabilities>('/models/capabilities');
      if (current === generation) capabilities.value = result;
    } catch (reason) {
      if (current === generation) {
        capabilities.value = null;
        error.value = errorMessage(reason);
      }
    }
  }
  function clear() {
    generation++;
    capabilities.value = null;
    error.value = '';
  }
  return { capabilities, error, refresh, clear };
});
