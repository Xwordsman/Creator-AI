<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { continueRunSchema, runReceiptSchema, type CreationRun } from '@creator-ai/contracts';
import { errorMessage, isDefinitiveRequestError, post, RequestError } from '../api/client';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ run: CreationRun }>();
const router = useRouter();
const session = useSessionStore();
const instruction = ref('');
const busy = ref(false);
const error = ref('');
const storageWarning = ref('');
const uncertain = ref(false),
  corruptPending = ref(false);
const usingModel = computed(() => props.run.snapshot.provider === 'compatible');
const valid = computed(
  () => continueRunSchema.safeParse({ instruction: instruction.value }).success,
);
const storageKey = `creator-ai:continuation:${session.info?.user.id}:${props.run.id}`;
let key: string | null = null;
let active = true;
let hydrating = false;
let frozenInstruction: string | undefined;
function persist() {
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        instruction: uncertain.value ? frozenInstruction : instruction.value,
        key,
        uncertain: uncertain.value,
      }),
    );
    storageWarning.value = '';
    return true;
  } catch {
    storageWarning.value = '浏览器暂不能保存重试标识，暂不发送。请恢复会话存储，并先核对创作记录。';
    return false;
  }
}
onMounted(() => {
  hydrating = true;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (
      saved &&
      typeof saved.instruction === 'string' &&
      saved.instruction.length <= 2000 &&
      (saved.key === null ||
        (typeof saved.key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(saved.key))) &&
      (saved.uncertain === undefined || typeof saved.uncertain === 'boolean')
    ) {
      instruction.value = saved.instruction;
      key = saved.key;
      // Old records did not distinguish a lost response from a successful navigation.
      uncertain.value = !!key && (saved.uncertain ?? true);
      if (uncertain.value) frozenInstruction = instruction.value.trim();
    } else corruptPending.value = true;
  } catch {
    corruptPending.value = true;
  } finally {
    hydrating = false;
  }
});
watch(
  instruction,
  (value, previous) => {
    if (hydrating || uncertain.value || corruptPending.value) return;
    if (value.trim() !== previous.trim()) key = null;
    persist();
  },
  { flush: 'sync' },
);
onUnmounted(() => {
  active = false;
});
async function submit() {
  if (busy.value || corruptPending.value || props.run.status !== 'succeeded') return;
  const input = continueRunSchema.safeParse({
    instruction: uncertain.value ? frozenInstruction : instruction.value,
  });
  if (!input.success) return;
  error.value = '';
  const wasUncertain = uncertain.value;
  key ??= crypto.randomUUID();
  frozenInstruction = input.data.instruction;
  uncertain.value = true;
  if (!persist()) {
    // A failed attempt to preserve a retry must not unlock a previously sent request.
    uncertain.value = wasUncertain;
    if (!wasUncertain) frozenInstruction = undefined;
    return;
  }
  busy.value = true;
  const id = props.run.id;
  try {
    const result = await post<CreationRun>(`/creation-runs/${id}/continue`, input.data, {
      'Idempotency-Key': key,
    });
    if (!runReceiptSchema.safeParse(result).success)
      throw new RequestError('服务返回了无效任务收据，请保留原请求核对。', 200, 'INVALID_RESPONSE');
    if (active) {
      uncertain.value = false;
      frozenInstruction = undefined;
      persist();
      await router.push(`/runs/${result.id}`);
    }
  } catch (reason) {
    if (active) {
      if (isDefinitiveRequestError(reason)) {
        uncertain.value = false;
        frozenInstruction = undefined;
        key = null;
        persist();
      }
      error.value = `${errorMessage(reason)} 请求结果不明确时可用相同要求重试，或先查看创作记录。`;
    }
  } finally {
    if (active) busy.value = false;
  }
}
function editAfterCheck() {
  if (
    busy.value ||
    !window.confirm(
      '请先核对创作记录。更改要求会产生新请求，可能重复计费；这不会取消上次任务。确认已核对并开始新的修改要求？',
    )
  )
    return;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    storageWarning.value = '无法清除本地请求标识，请恢复会话存储后再继续。';
    return;
  }
  key = null;
  uncertain.value = false;
  corruptPending.value = false;
  frozenInstruction = undefined;
  error.value = '';
  persist();
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
    <div
      v-if="uncertain || corruptPending"
      class="inline-note warning request-recovery"
      role="status"
    >
      <p>
        {{
          corruptPending
            ? '本地请求记录无法恢复，已停止新提交。'
            : '上次请求结果待确认，修改要求已锁定；下面按钮只原样重试同一请求。'
        }}
        请先<router-link to="/runs">核对创作记录</router-link>，不会自动重发或取消任务。
      </p>
      <el-button :disabled="busy" @click="editAfterCheck">核对后修改要求</el-button>
    </div>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="这一轮，你想怎么改？" for="revision-instruction">
        <el-input
          id="revision-instruction"
          v-model="instruction"
          type="textarea"
          :rows="4"
          :maxlength="2000"
          show-word-limit
          :disabled="busy || uncertain || corruptPending"
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
          :disabled="!valid || corruptPending || run.status !== 'succeeded'"
          >{{ usingModel ? '确认新调用，生成修改稿' : '生成模拟修改稿' }}</el-button
        >
      </div>
    </el-form>
  </section>
</template>
