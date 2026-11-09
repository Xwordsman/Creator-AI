<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { continueRunSchema, type CreationRun } from '@creator-ai/contracts';
import { errorMessage, post } from '../api/client';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ run: CreationRun }>();
const router = useRouter();
const session = useSessionStore();
const instruction = ref('');
const busy = ref(false);
const error = ref('');
const storageWarning = ref('');
const usingModel = computed(() => props.run.snapshot.provider === 'compatible');
const valid = computed(
  () => continueRunSchema.safeParse({ instruction: instruction.value }).success,
);
const storageKey = `creator-ai:continuation:${session.info?.user.id}:${props.run.id}`;
let key: string | null = null;
let active = true;
function persist() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ instruction: instruction.value, key }));
  } catch {
    storageWarning.value =
      '浏览器暂不能保存重试标识。请求结果不明确时，请先查看创作记录，勿刷新后重复提交。';
  }
}
onMounted(() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (saved && typeof saved.instruction === 'string' && saved.instruction.length <= 2000) {
      instruction.value = saved.instruction;
      key =
        typeof saved.key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(saved.key)
          ? saved.key
          : null;
      persist();
    }
  } catch {
    /* A corrupt or unavailable tab-local record must not block creation. */
  }
});
watch(
  instruction,
  (value, previous) => {
    if (value.trim() !== previous.trim()) key = null;
    persist();
  },
  { flush: 'sync' },
);
onUnmounted(() => {
  active = false;
});
async function submit() {
  if (busy.value || !valid.value) return;
  busy.value = true;
  error.value = '';
  key ??= crypto.randomUUID();
  persist();
  const id = props.run.id;
  try {
    const result = await post<CreationRun>(
      `/creation-runs/${id}/continue`,
      { instruction: instruction.value.trim() },
      { 'Idempotency-Key': key },
    );
    if (active) await router.push(`/runs/${result.id}`);
  } catch (reason) {
    if (active)
      error.value = `${errorMessage(reason)} 请求结果不明确时可用相同要求重试，或先查看创作记录。`;
  } finally {
    if (active) busy.value = false;
  }
}
</script>

<template>
  <section class="panel continuation-panel">
    <span class="eyebrow">KEEP THE CONTEXT / MAKE IT BETTER</span>
    <h2>围绕这篇，继续创作</h2>
    <p class="muted">
      不必重复人设。沿用这份稿件的账号、专家和技能版本，将原稿和修改要求交给下一轮。生成新分支，不覆盖原稿；尚未包含完整历史对话。
    </p>
    <div v-if="usingModel" class="inline-note warning">
      本轮会再次调用「{{ run.snapshot.model?.name }}」，可能产生新费用。独立预算：最多
      {{ run.snapshot.limits?.maxCalls }} 次调用、{{
        run.snapshot.limits?.maxTotalTokens
      }}
      tokens、{{ run.snapshot.limits?.maxDurationSeconds }} 秒。不是剩余额度，也不代表金额上限。
    </div>
    <p v-else class="fine-print">
      模拟模式：只验证原稿、修改要求与历史关联的保存，不会真正理解或改写正文，不调用付费模型。
    </p>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="这一轮，你想怎么改？" for="revision-instruction">
        <el-input
          id="revision-instruction"
          v-model="instruction"
          type="textarea"
          :rows="4"
          :maxlength="2000"
          show-word-limit
          :disabled="busy"
          placeholder="例如：保留主要观点，把开头改得更直接；删除空泛表述，补一段面向新手的行动建议。"
        />
      </el-form-item>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="storageWarning" class="form-error" role="alert">{{ storageWarning }}</p>
      <div class="compose-footer">
        <span class="fine-print">至少 2 字。相同要求的失败重试复用请求标识；不会自动重发。</span>
        <el-button
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="!valid || run.status !== 'succeeded'"
          >{{ usingModel ? '确认新调用，生成修改稿' : '生成模拟修改稿' }}</el-button
        >
      </div>
    </el-form>
  </section>
</template>
