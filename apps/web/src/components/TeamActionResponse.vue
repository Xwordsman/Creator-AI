<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  teamResponseSchema,
  type CreationRun,
  type TeamAction,
  type TeamResponse,
} from '@creator-ai/contracts';
import { errorMessage, post, RequestError } from '../api/client';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ runId: string; action: TeamAction; disabled: boolean }>();
const emit = defineEmits<{ resolved: [run: CreationRun]; refresh: [] }>();
const session = useSessionStore();
const owner = session.info?.user.id;
const runId = props.runId;
const actionId = props.action.id;
const storageKey = `creator-ai:team-response:${owner}:${runId}:${actionId}`;
const answer = ref('');
const submitted = ref<TeamResponse | null>(null);
const busy = ref(false);
const error = ref('');
const storageWarning = ref('');
const needsApproval = computed(() => props.action.directive.action !== 'ask_user');
const validAnswer = computed(
  () => answer.value.trim().length >= 2 && answer.value.trim().length <= 2000,
);
let active = true;

try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
  if (saved && typeof saved.answer === 'string' && saved.answer.length <= 2000) {
    answer.value = saved.answer;
    const parsed = teamResponseSchema.safeParse(saved.submitted);
    if (
      parsed.success &&
      (needsApproval.value
        ? typeof parsed.data.approved === 'boolean'
        : parsed.data.approved === undefined)
    ) {
      submitted.value = parsed.data;
      answer.value = parsed.data.answer;
    }
  }
} catch {
  storageWarning.value =
    '浏览器未能读取本地答复。若之前提交结果不明确，请先刷新快照核对，不要更改原答复重复提交。';
}
function persist() {
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ answer: answer.value, submitted: submitted.value }),
    );
  } catch {
    storageWarning.value =
      '浏览器无法保存答复。请保留本页；请求结果不明确时，只用原答复和原决定重试，或先刷新快照。';
  }
}
watch(answer, persist, { flush: 'sync' });
onUnmounted(() => {
  active = false;
});

async function submit(approved?: boolean) {
  if (busy.value || props.disabled || !owner || session.info?.user.id !== owner) return;
  if (!submitted.value) {
    if (needsApproval.value && typeof approved !== 'boolean') return;
    const fallback = approved ? '同意继续执行' : '不同意继续执行';
    const payload = {
      answer: answer.value.trim() || (needsApproval.value ? fallback : ''),
      ...(needsApproval.value ? { approved } : {}),
    };
    const parsed = teamResponseSchema.safeParse(payload);
    if (!parsed.success) return;
    // Freeze the exact payload before sending: this action, not a new key, is the idempotency scope.
    submitted.value = parsed.data;
    answer.value = parsed.data.answer;
  }
  persist();
  busy.value = true;
  error.value = '';
  try {
    const result = await post<CreationRun>(
      `/creation-runs/${runId}/actions/${actionId}/respond`,
      submitted.value,
    );
    if (active && props.runId === runId && session.info?.user.id === owner)
      emit('resolved', result);
  } catch (reason) {
    if (active)
      error.value =
        reason instanceof RequestError && reason.status === 409
          ? '此交互已有不同答复或状态已变化。请刷新快照核对；不要改写原提交内容。'
          : `${errorMessage(reason)} 未自动重发。可刷新快照核对，或手动原样重试。`;
  } finally {
    if (active) busy.value = false;
  }
}
</script>

<template>
  <el-form class="team-response" label-position="top" @submit.prevent="submit()">
    <el-form-item
      :label="needsApproval ? '补充说明（可选）' : '你的答复'"
      :for="`team-answer-${action.id}`"
    >
      <el-input
        :id="`team-answer-${action.id}`"
        v-model="answer"
        type="textarea"
        :rows="3"
        :maxlength="2000"
        show-word-limit
        :disabled="busy || disabled || !!submitted"
        :aria-describedby="`team-answer-help-${action.id}`"
        :placeholder="
          needsApproval ? '补充你的理由；留空时记录所选决定。' : '请回答团队的问题（2–2000 字）。'
        "
      />
    </el-form-item>
    <p :id="`team-answer-help-${action.id}`" class="fine-print">
      {{
        needsApproval
          ? '同意后可能继续调用模型并计费；拒绝会将你的意见交回团队。填写说明时至少 2 字。'
          : '答复后团队可能继续调用模型并计费；只提交给当前交互，不会创建新任务。'
      }}
    </p>
    <p v-if="submitted" class="inline-note warning" role="status">
      已保留本次提交{{
        submitted.approved === undefined ? '' : submitted.approved ? ' · 同意' : ' · 拒绝'
      }}。核对结果前不修改内容；重试只发送相同答复与决定，不会自动重发。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="storageWarning" class="form-error" role="alert">{{ storageWarning }}</p>
    <div class="team-response__buttons">
      <el-button
        v-if="submitted"
        type="primary"
        :loading="busy"
        :disabled="disabled"
        @click="submit()"
        >原样重试本次答复</el-button
      >
      <template v-else-if="needsApproval">
        <el-button
          type="primary"
          :loading="busy"
          :disabled="disabled || (!!answer.trim() && !validAnswer)"
          @click="submit(true)"
          >同意并继续</el-button
        >
        <el-button
          :disabled="busy || disabled || (!!answer.trim() && !validAnswer)"
          @click="submit(false)"
          >拒绝并反馈</el-button
        >
      </template>
      <el-button
        v-else
        type="primary"
        native-type="submit"
        :loading="busy"
        :disabled="disabled || !validAnswer"
        >提交答复</el-button
      >
      <el-button v-if="submitted || error" :disabled="busy" @click="emit('refresh')"
        >核对最新快照</el-button
      >
    </div>
  </el-form>
</template>
