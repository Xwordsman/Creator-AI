<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  modelCheckLabels,
  modelFailureMessage,
  type ModelCheck,
  type ModelConnection,
} from '@creator-ai/contracts';
import { errorMessage, post, request, RequestError } from '../api/client';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ connection: ModelConnection; canCall: boolean }>();
const emit = defineEmits<{ close: [] }>();
const session = useSessionStore();
const endpoint = `/models/${props.connection.id}/checks`;
const storageKey = `creator-model-check:${session.info?.user.id}:${props.connection.id}`;
const checks = ref<ModelCheck[]>([]),
  busy = ref(false),
  loading = ref(true);
const error = ref(''),
  confirmed = ref(false),
  pendingKey = ref(''),
  storageError = ref('');
const note = ref('');
const visible = ref(true);
let active = true,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const unresolved = computed(() =>
  checks.value.find((c) => c.status === 'running' || (c.status === 'unknown' && !c.resolvedAt)),
);
const canStart = computed(
  () =>
    props.canCall &&
    props.connection.enabled &&
    !busy.value &&
    !loading.value &&
    !unresolved.value &&
    !pendingKey.value &&
    !storageError.value &&
    confirmed.value,
);
function store(key: string) {
  try {
    if (key) sessionStorage.setItem(storageKey, key);
    else sessionStorage.removeItem(storageKey);
    pendingKey.value = key;
    return true;
  } catch {
    storageError.value = '无法保存检查请求标识，请恢复浏览器存储后重新打开；新检查暂不可发送。';
    return false;
  }
}
try {
  const saved = sessionStorage.getItem(storageKey) ?? '';
  if (saved && !/^[a-zA-Z0-9_-]{16,128}$/.test(saved))
    storageError.value = '本地请求记录损坏，请先核对下方服务端检查记录，再处理浏览器存储。';
  else pendingKey.value = saved;
} catch {
  storageError.value = '浏览器存储不可用，新检查暂不可发送。';
}

async function load() {
  const current = ++generation;
  if (timer) clearTimeout(timer);
  try {
    const result = await request<ModelCheck[]>(endpoint);
    if (!active || current !== generation) return;
    checks.value = result;
    if (checks.value.some((c) => c.status === 'running')) timer = setTimeout(load, 2000);
  } catch (reason) {
    if (active && current === generation) error.value = errorMessage(reason);
  } finally {
    if (active && current === generation) loading.value = false;
  }
}
async function send(retry = false) {
  if (busy.value || (retry ? !pendingKey.value : !canStart.value)) return;
  const key = retry ? pendingKey.value : crypto.randomUUID();
  if (!store(key)) return;
  generation++;
  if (timer) clearTimeout(timer);
  busy.value = true;
  error.value = '';
  try {
    await request<ModelCheck>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
      headers: { 'Idempotency-Key': key },
      signal: AbortSignal.timeout(30000),
    });
    store('');
    if (!active) return;
    confirmed.value = false;
    await load();
  } catch (reason) {
    if (
      reason instanceof RequestError &&
      reason.status >= 400 &&
      reason.status < 500 &&
      ![408, 429].includes(reason.status)
    )
      store('');
    if (active) {
      error.value = errorMessage(reason);
      await load();
    }
  } finally {
    if (active) busy.value = false;
  }
}
async function resolve(check: ModelCheck) {
  const text = note.value.trim();
  if (busy.value || text.length < 10 || text.length > 2000) return;
  busy.value = true;
  error.value = '';
  try {
    await post(`${endpoint}/${check.id}/reconcile`, { note: text });
    if (!active) return;
    note.value = '';
    await load();
  } catch (reason) {
    if (active) error.value = errorMessage(reason);
  } finally {
    if (active) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  active = false;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`检查连接 · ${connection.name}`"
    width="680px"
    :close-on-click-modal="false"
    @closed="emit('close')"
  >
    <p>
      用固定短文本检查接口认证、模型响应和基础 JSON
      回复。不会发送文章、人设或技能，不验证写作质量、工具调用或图片能力。
    </p>
    <p class="fine-print">{{ connection.model }} · {{ connection.baseUrl }}</p>
    <div class="inline-note warning">
      每次新检查最多发送 1 次请求，输出上限 256 Token，可能计费。结果不确定时先核对，不自动重发。
    </div>
    <p v-if="error || storageError" class="form-error" role="alert">{{ error || storageError }}</p>
    <div v-if="pendingKey" class="panel">
      <p>上次检查的请求结果尚未确认。可以用原请求标识查询或补交，同一请求不会重复调用。</p>
      <el-button :disabled="busy || !!storageError" @click="send(true)">原样重试检查请求</el-button>
    </div>
    <el-checkbox
      v-model="confirmed"
      :disabled="busy || !!pendingKey || !!unresolved || !canCall || !connection.enabled"
      >我确认发送一次检查请求，可能产生费用</el-checkbox
    >
    <div class="dialog-actions">
      <el-button :loading="busy" type="primary" :disabled="!canStart" @click="send()"
        >发送一次检查</el-button
      >
      <el-button :disabled="busy" @click="load">刷新检查记录</el-button>
    </div>
    <h3>最近 10 次检查</h3>
    <p v-if="loading" class="muted">正在读取记录…</p>
    <p v-else-if="!checks.length" class="muted">尚未检查；保存连接和打开此窗口都不会调用模型。</p>
    <article v-for="check in checks" :key="check.id" class="model-check-record">
      <strong
        >{{ modelCheckLabels[check.status] }}{{ check.resolvedAt ? ' · 已人工核对' : '' }}</strong
      >
      <p class="fine-print">
        {{ new Date(check.createdAt).toLocaleString() }} · 请求 {{ check.id }}
      </p>
      <p v-if="check.status === 'passed'">
        基础文本与 JSON 协议已通过，可以进入文章协作试写。实际文风和事实仍需人工评价。
      </p>
      <p v-if="check.failureCode">{{ modelFailureMessage(check.failureCode) }}</p>
      <p v-if="check.failureCode" class="fine-print">类别：{{ check.failureCode }}</p>
      <p class="fine-print">
        服务商报告 Token：输入 {{ check.inputTokens ?? '未提供' }} / 输出
        {{ check.outputTokens ?? '未提供' }}。未提供不代表零费用。
      </p>
      <p v-if="check.resolutionNote">核对说明：{{ check.resolutionNote }}</p>
      <div v-if="check.status === 'unknown' && !check.resolvedAt">
        <label :for="`resolution-${check.id}`">核对服务商记录后的说明</label>
        <el-input
          :id="`resolution-${check.id}`"
          v-model="note"
          type="textarea"
          :maxlength="2000"
          placeholder="至少 10 个字；记录你核对到的结果。"
          :disabled="busy"
        />
        <el-button :disabled="busy || note.trim().length < 10" @click="resolve(check)"
          >保存核对说明</el-button
        >
        <p class="fine-print">保留原未知结果，不退款、不重发，也不导入回复。</p>
      </div>
    </article>
  </el-dialog>
</template>

<style scoped>
.model-check-record {
  border-top: 1px solid var(--el-border-color);
  margin-top: 18px;
  padding-top: 18px;
  overflow-wrap: anywhere;
}
.el-checkbox {
  max-width: 100%;
  height: auto;
  margin: 16px 0;
}
:deep(.el-checkbox__label) {
  white-space: normal;
}
</style>
