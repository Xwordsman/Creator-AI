<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  blockText,
  contentTurnInputSchema,
  contentTurnReceiptSchema,
  documentSchema,
  localAssistantDraftSchema,
  manuscriptKey,
  modelFailureMessage,
  runStatusLabels,
  validateAnnotations,
  writingCardKindLabels,
  type ContentAnnotation,
  type ContentSelection,
  type ContentTurn,
  type ContentTurnDetail,
  type ContentTurnInput,
  type DocumentNode,
  type ModelConnection,
  type Page,
} from '@creator-ai/contracts';
import { errorMessage, isDefinitiveRequestError, post, request, RequestError } from '../api/client';
import { useSessionStore } from '../stores/session';
import ContentWritingProfile from './ContentWritingProfile.vue';

const props = defineProps<{
  contentId: string;
  title: string;
  document: DocumentNode;
  baseRevision: number;
  disabled: boolean;
  selection: ContentSelection | null;
}>();
const emit = defineEmits<{
  apply: [turn: ContentTurnDetail, ids: string[]];
  attention: [value: boolean];
  conflict: [];
}>();
const session = useSessionStore();
const storageKey = `creator-assistant:${session.info?.user.id}:${props.contentId}`;
const endpoint = `/contents/${props.contentId}/assistant-turns`;
const open = ref(false),
  busy = ref(false),
  loading = ref(false),
  ready = ref(false);
const error = ref(''),
  notice = ref(''),
  storageFailed = ref(false),
  corruptPending = ref(false);
const mode = ref<'discuss' | 'revise'>('discuss'),
  message = ref(''),
  note = ref('');
const annotations = ref<ContentAnnotation[]>([]),
  modelConnectionId = ref('');
const target = ref('selection');
const accountProfileRevision = ref<number | undefined>();
const models = ref<ModelConnection[]>([]),
  turns = ref<ContentTurn[]>([]),
  page = ref(1),
  total = ref(0);
const viewed = ref<ContentTurnDetail | null>(null),
  selected = ref<string[]>([]);
const pending = ref<{ key: string; input: ContentTurnInput } | null>(null);
let active = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  listToken = 0,
  viewToken = 0;
const safeDoc = computed(() => documentSchema.safeParse(props.document));
const blocks = computed(() => (safeDoc.value.success ? safeDoc.value.data.content : []));
const blockedTurn = ref(false);
const locked = computed(
  () => props.disabled || busy.value || !!pending.value || corruptPending.value,
);
const stale = computed(
  () =>
    !viewed.value ||
    !safeDoc.value.success ||
    viewed.value.baseRevision !== props.baseRevision ||
    manuscriptKey({ title: props.title, document: safeDoc.value.data }) !==
      manuscriptKey(viewed.value.manuscript),
);
const hasDraft = computed(
  () =>
    !!message.value ||
    !!note.value ||
    annotations.value.length > 0 ||
    !!pending.value ||
    corruptPending.value,
);
watch(hasDraft, (value) => emit('attention', value), { immediate: true });
function store(suffix: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(`${storageKey}:${suffix}`);
    else sessionStorage.setItem(`${storageKey}:${suffix}`, JSON.stringify(value));
    storageFailed.value = false;
    return true;
  } catch {
    storageFailed.value = true;
    return false;
  }
}
try {
  const draft = localAssistantDraftSchema.safeParse(
    JSON.parse(sessionStorage.getItem(`${storageKey}:draft`) ?? 'null'),
  );
  if (draft.success) {
    mode.value = draft.data.mode;
    message.value = draft.data.message;
    annotations.value = draft.data.annotations;
    modelConnectionId.value = draft.data.modelConnectionId;
    note.value = draft.data.note;
    accountProfileRevision.value = draft.data.accountProfileRevision;
    open.value = !!message.value || !!note.value || annotations.value.length > 0;
  }
} catch {
  storageFailed.value = true;
}
try {
  const raw = sessionStorage.getItem(`${storageKey}:pending`);
  if (raw !== null) {
    const op = JSON.parse(raw);
    const parsed = contentTurnInputSchema.safeParse(op?.input);
    if (typeof op?.key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(op.key) && parsed.success)
      pending.value = { key: op.key, input: parsed.data };
    else corruptPending.value = true;
    open.value = true;
  }
} catch {
  storageFailed.value = true;
  corruptPending.value = true;
  open.value = true;
}
watch(
  [mode, message, annotations, modelConnectionId, note, accountProfileRevision],
  () => {
    store('draft', {
      mode: mode.value,
      message: message.value,
      annotations: annotations.value,
      modelConnectionId: modelConnectionId.value,
      note: note.value,
      ...(accountProfileRevision.value === undefined
        ? {}
        : { accountProfileRevision: accountProfileRevision.value }),
    });
  },
  { deep: true, flush: 'sync' },
);

async function loadHistory() {
  const token = ++listToken;
  clearTimeout(timer);
  loading.value = true;
  try {
    const data = await request<Page<ContentTurn>>(`${endpoint}?page=${page.value}&pageSize=10`);
    // The first page holds the newest (and possibly active) task even when browsing older history.
    const latest =
      page.value === 1 ? data : await request<Page<ContentTurn>>(`${endpoint}?page=1&pageSize=1`);
    if (!active || token !== listToken) return;
    turns.value = data.items;
    total.value = data.total;
    blockedTurn.value = latest.items.some((t) =>
      ['queued', 'running', 'waiting_user', 'needs_review'].includes(t.status),
    );
    ready.value = true;
    if (open.value && latest.items.some((t) => ['queued', 'running'].includes(t.status)))
      timer = setTimeout(() => {
        void loadHistory();
      }, 2000);
  } catch (reason) {
    if (active && token === listToken) {
      error.value = errorMessage(reason);
      ready.value = false;
    }
  } finally {
    if (active && token === listToken) loading.value = false;
  }
}
async function initialize() {
  error.value = '';
  const results = await Promise.allSettled([request<ModelConnection[]>('/models'), loadHistory()]);
  if (!active) return;
  if (results[0].status === 'fulfilled') models.value = results[0].value.filter((m) => m.enabled);
  else error.value = `模型列表暂不可用：${errorMessage(results[0].reason)}。不会自动切换模型。`;
}
watch(
  open,
  (value) => {
    if (value) void initialize();
    else clearTimeout(timer);
  },
  { immediate: true },
);
function addAnnotation(kind: 'change' | 'keep') {
  if (locked.value || annotations.value.length >= 20) return;
  error.value = '';
  let anchor: ContentSelection | null = null;
  if (target.value === 'selection') anchor = props.selection;
  else if (target.value !== 'whole') {
    const index = Number(target.value),
      block = blocks.value[index];
    if (block) anchor = { blockIndex: index, blockText: blockText(block), quote: '' };
  }
  if ((target.value !== 'whole' && !anchor) || (kind === 'keep' && !anchor)) {
    error.value = '请在正文中点选一个段落，或从列表选择；保留标记不能用于整篇。';
    return;
  }
  if (kind === 'change' && !note.value.trim()) {
    error.value = '请填写这处想改什么。';
    return;
  }
  annotations.value = [
    ...annotations.value,
    {
      id: crypto.randomUUID(),
      kind,
      blockIndex: anchor?.blockIndex ?? null,
      blockText: anchor?.blockText ?? '',
      quote: anchor?.quote ?? '',
      note: note.value.trim(),
    },
  ];
  note.value = '';
}
async function submit() {
  if (locked.value || !ready.value || blockedTurn.value) return;
  if (note.value.trim()) {
    error.value = '还有未加入的批注，请先加入批注或清空批注输入框。';
    return;
  }
  const input = contentTurnInputSchema.safeParse({
    baseRevision: props.baseRevision,
    title: props.title,
    document: props.document,
    mode: mode.value,
    message: message.value,
    annotations: annotations.value,
    ...(modelConnectionId.value ? { modelConnectionId: modelConnectionId.value } : {}),
    ...(accountProfileRevision.value === undefined
      ? {}
      : { accountProfileRevision: accountProfileRevision.value }),
  });
  if (!input.success) {
    error.value = '请完成有效标题和正文，并输入至少 2 字的要求或添加批注。';
    return;
  }
  try {
    validateAnnotations(input.data, input.data.annotations);
  } catch (reason) {
    error.value = errorMessage(reason);
    return;
  }
  const op = { key: crypto.randomUUID(), input: input.data };
  if (!store('pending', op)) {
    error.value = '无法保存请求标识，暂不发送，以免重试重复计费。';
    return;
  }
  pending.value = op;
  await sendPending();
}
async function sendPending() {
  if (!pending.value || busy.value) return;
  const op = JSON.parse(JSON.stringify(pending.value)) as NonNullable<typeof pending.value>;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const response = await post<ContentTurn>(endpoint, op.input, { 'Idempotency-Key': op.key });
    if (!active) return;
    const receipt = contentTurnReceiptSchema.safeParse(response);
    if (
      !receipt.success ||
      receipt.data.contentId !== props.contentId ||
      receipt.data.baseRevision !== op.input.baseRevision ||
      receipt.data.mode !== op.input.mode
    )
      throw new RequestError(
        '服务返回了无效协作任务收据，请保留原请求核对。',
        200,
        'INVALID_RESPONSE',
      );
    if (!store('pending', null))
      throw new Error('任务已接收，但无法清除本地标识。请原样重试核对。');
    pending.value = null;
    message.value = '';
    annotations.value = [];
    note.value = '';
    viewed.value = null;
    notice.value = '已发送当前编辑稿（含未保存修改）。不会保存或覆盖正文，结果将在本页出现。';
    page.value = 1;
    await loadHistory();
  } catch (reason) {
    if (!active) return;
    if (isDefinitiveRequestError(reason)) {
      if (store('pending', null)) pending.value = null;
      if (reason.code === 'CONTENT_CONFLICT') emit('conflict');
      if (reason.code === 'ASSISTANCE_IN_PROGRESS') await loadHistory();
    }
    error.value = errorMessage(reason);
  } finally {
    if (active) busy.value = false;
  }
}
async function view(turn: ContentTurn) {
  const token = ++viewToken;
  error.value = '';
  try {
    const detail = await request<ContentTurnDetail>(`${endpoint}/${turn.id}`);
    if (!active || token !== viewToken) return;
    viewed.value = detail;
    selected.value = [];
  } catch (reason) {
    if (active && token === viewToken) error.value = errorMessage(reason);
  }
}
async function cancel(turn: ContentTurn) {
  if (busy.value) return;
  busy.value = true;
  try {
    await post(`/creation-runs/${turn.id}/cancel`, {});
    if (active) await loadHistory();
  } catch (reason) {
    if (active) error.value = errorMessage(reason);
  } finally {
    if (active) busy.value = false;
  }
}
onBeforeUnmount(() => {
  active = false;
  clearTimeout(timer);
  listToken++;
  viewToken++;
});
</script>

<template>
  <section class="panel assistant-panel" aria-label="AI 协作编辑">
    <span class="eyebrow">AN EDITOR BY YOUR SIDE</span>
    <div class="section-heading">
      <h2>和 AI 一起打磨</h2>
      <el-button :aria-expanded="open" @click="open = !open">{{
        open ? '收起协作' : '打开 AI 协作'
      }}</el-button>
    </div>
    <p class="fine-print">
      围绕当前稿聊一聊，或攒好几处批注一起改。保留你的表达，每处修改由你决定。
    </p>
    <template v-if="open">
      <p v-if="error" role="alert" class="form-error">{{ error }}</p>
      <p v-if="notice" role="status" class="notice-banner">{{ notice }}</p>
      <p v-if="storageFailed" role="alert" class="form-error">
        浏览器会话存储不可用，请不要关闭页面。批注和原请求标识可能无法恢复。
      </p>
      <p v-if="corruptPending" role="alert" class="form-error">
        本地请求记录损坏，已停止新提交。请先在创作记录核对是否已接收，不要假定未执行。
      </p>
      <div v-if="pending" class="notice-banner">
        <strong>发送结果待确认</strong>
        <p>保持原稿快照、要求和标识不变，重试只核对同一次任务，不重新生成。</p>
        <el-button :loading="busy" @click="sendPending">原样重试 AI 请求</el-button>
      </div>
      <label class="field-label" for="assistant-model">本轮模型</label>
      <select id="assistant-model" v-model="modelConnectionId" :disabled="locked">
        <option value="">本地模拟 · 不调用 AI</option>
        <option
          v-if="modelConnectionId && !models.some((m) => m.id === modelConnectionId)"
          :value="modelConnectionId"
        >
          此前选择的模型（待核对可用性）
        </option>
        <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }} · {{ m.model }}</option>
      </select>
      <p class="fine-print">
        专家与技能沿用原稿快照；专家团由负责人单独协助。<router-link to="/models"
          >管理模型</router-link
        >
      </p>
      <p v-if="modelConnectionId" class="notice-banner">
        发送将调用所选模型，可能计费。每轮最多 4 次调用、64,000 tokens、180
        秒，不是金额上限。长文可能超过模型输入上限。
      </p>
      <p v-else class="fine-print">模拟仅验证流程，不理解或改写正文。</p>
      <ContentWritingProfile
        v-model="accountProfileRevision"
        :content-id="contentId"
        :disabled="locked"
      />
      <label class="field-label" for="assistant-mode">协作方式</label>
      <select id="assistant-mode" v-model="mode" :disabled="locked">
        <option value="discuss">先讨论 · 不修改正文</option>
        <option value="revise">给修改建议 · 我来选择采用</option>
      </select>
      <label class="field-label" for="assistant-message">这一轮，你想说什么？</label>
      <textarea
        id="assistant-message"
        v-model="message"
        :disabled="locked"
        rows="4"
        maxlength="4000"
        placeholder="例如：开头太像在讲道理了，先和我讨论怎么从一个真实细节切入。"
      />
      <details class="assistant-annotations" open>
        <summary>批注清单 · {{ annotations.length }}/20</summary>
        <label class="field-label" for="annotation-target">这条意见针对哪里？</label>
        <select id="annotation-target" v-model="target" :disabled="locked">
          <option value="selection">
            正文当前选中段落{{
              selection ? `（第 ${selection.blockIndex + 1} 段）` : '（尚未选择）'
            }}
          </option>
          <option value="whole">整篇文章（含标题）</option>
          <option v-for="(b, index) in blocks" :key="index" :value="String(index)">
            第 {{ index + 1 }} 段 · {{ blockText(b).slice(0, 35) || '空段落' }}
          </option>
        </select>
        <blockquote v-if="target === 'selection' && selection?.quote" class="assistant-quote">
          {{ selection.quote }}
        </blockquote>
        <label class="field-label" for="annotation-note">这处想改什么？</label>
        <textarea
          id="annotation-note"
          v-model="note"
          :disabled="locked"
          rows="2"
          maxlength="1500"
          placeholder="太空泛、重复、语气不对……也可以标记“保留原文”。"
        />
        <div class="content-actions">
          <el-button :disabled="locked || annotations.length >= 20" @click="addAnnotation('change')"
            >加入批注</el-button
          >
          <el-button
            :disabled="locked || annotations.length >= 20 || target === 'whole'"
            @click="addAnnotation('keep')"
            >保留原文，不要改</el-button
          >
        </div>
        <ul class="assistant-note-list">
          <li v-for="a in annotations" :key="a.id">
            <strong
              >{{ a.kind === 'keep' ? '保留' : '修改' }} ·
              {{ a.blockIndex === null ? '整篇' : `第 ${a.blockIndex + 1} 段` }}</strong
            >
            <p>{{ a.note || '保持此段原文' }}</p>
            <blockquote v-if="a.quote" class="assistant-quote">{{ a.quote }}</blockquote>
            <el-button
              text
              :disabled="locked"
              :aria-label="`移除${a.blockIndex === null ? '整篇' : `第 ${a.blockIndex + 1} 段`}批注`"
              @click="annotations = annotations.filter((n) => n.id !== a.id)"
              >移除</el-button
            >
          </li>
        </ul>
        <p class="fine-print">
          选中一段添加一条，可累积多处。仅有段落修改批注时，不改其他段和标题；“保留”始终优先。
        </p>
      </details>
      <el-button
        type="primary"
        :disabled="locked || !ready || blockedTurn"
        :loading="busy"
        @click="submit"
      >
        {{ modelConnectionId ? '确认调用并发送' : '发送模拟请求' }}</el-button
      >
      <p v-if="blockedTurn" class="fine-print">
        已有进行中或结果待核对的任务，请等待或在任务记录中处理；不会并发重复调用。
      </p>
      <p class="fine-print">
        发送包含未保存编辑，但不会保存正文。最近最多 6 轮真实对话、12,000
        字符作为上下文，不是永久记忆。
      </p>
      <div class="section-heading">
        <h3>这篇的对话</h3>
        <el-button :loading="loading" @click="loadHistory">刷新对话</el-button>
      </div>
      <p v-if="ready && !turns.length" class="fine-print">还没有对话，从一个具体问题开始。</p>
      <ol class="assistant-turns">
        <li v-for="t in turns" :key="t.id">
          <p class="fine-print">
            {{ t.mode === 'discuss' ? '讨论' : '修改建议' }} ·
            {{ t.status === 'succeeded' ? '回复已就绪' : runStatusLabels[t.status] }} ·
            {{ t.modelName }}
          </p>
          <p class="assistant-user">{{ t.message || `本轮有 ${t.annotations.length} 条批注` }}</p>
          <p v-if="t.writingProfile" class="fine-print">
            {{ t.writingProfile.source === 'current' ? '本轮选择账号资料' : '沿用原稿资料' }} ·
            {{
              t.writingProfile.accountRevision === null
                ? '未记录修订'
                : `r${t.writingProfile.accountRevision}`
            }}
            ·
            {{
              t.writingProfile.cards.length
                ? t.writingProfile.cards
                    .map((c) => `${writingCardKindLabels[c.kind]}：${c.title}`)
                    .join('、')
                : '基础人设，无启用卡片'
            }}
          </p>
          <details v-if="t.annotations.length">
            <summary>{{ t.annotations.length }} 条批注快照</summary>
            <p v-for="a in t.annotations" :key="a.id">
              {{ a.kind === 'keep' ? '保留' : '修改' }} ·
              {{ a.blockIndex === null ? '整篇' : `第 ${a.blockIndex + 1} 段` }}：{{
                a.note || '不修改'
              }}
            </p>
          </details>
          <p v-if="t.result" class="assistant-reply">{{ t.result.reply }}</p>
          <p v-if="t.historyTruncated" class="fine-print">
            本轮历史上下文已截断；当前稿始终完整传入。
          </p>
          <p v-if="t.failureCode" class="form-error">
            {{
              t.failureCode === 'ASSISTANCE_INVALID_OUTPUT'
                ? '模型未返回有效的局部修改建议。已停止，未修改正文，也不会自动付费重试。'
                : modelFailureMessage(t.failureCode)
            }}
          </p>
          <div class="content-actions">
            <router-link :to="`/runs/${t.id}`">{{
              t.status === 'needs_review' ? '核对未知调用' : '调用记录'
            }}</router-link>
            <el-button
              v-if="['queued', 'running'].includes(t.status)"
              :disabled="busy"
              @click="cancel(t)"
              >停止后续调用</el-button
            >
            <el-button v-if="t.result?.suggestions.length && !t.isMock" @click="view(t)"
              >查看并选择修改</el-button
            >
          </div>
          <div v-if="viewed?.id === t.id" class="assistant-diff">
            <p v-if="stale" class="notice-banner">
              正文、标题或修订已变化，旧建议不能覆盖新稿。请基于当前稿重新发送。
            </p>
            <div v-for="s in viewed.result?.suggestions" :key="s.id" class="assistant-suggestion">
              <label class="content-check"
                ><input
                  v-model="selected"
                  type="checkbox"
                  :value="s.id"
                  :disabled="locked || stale"
                />
                采用{{ s.blockIndex === null ? '标题' : `第 ${s.blockIndex + 1} 段` }}修改</label
              >
              <span class="fine-print">原文</span>
              <p class="diff-before">{{ s.before || '（空段落）' }}</p>
              <span class="fine-print">建议</span>
              <p class="diff-after">{{ s.after || '（清空该段）' }}</p>
              <p class="fine-print">{{ s.reason }}</p>
            </div>
            <el-button
              type="primary"
              :disabled="locked || stale || !selected.length"
              @click="emit('apply', viewed, [...selected])"
              >将选中建议应用到编辑稿</el-button
            >
            <p class="fine-print">未勾选的保持原样。应用后仍需“保存新版本”，不会自动送审或发布。</p>
          </div>
        </li>
      </ol>
      <el-pagination
        v-if="total > 10"
        v-model:current-page="page"
        :page-size="10"
        :total="total"
        layout="prev, pager, next"
        @current-change="loadHistory"
      />
    </template>
  </section>
</template>

<style scoped>
.assistant-panel {
  min-width: 0;
  grid-column: 1 / -1;
}
.assistant-panel h2 {
  font-size: 22px;
}
.assistant-panel p {
  overflow-wrap: anywhere;
}
.assistant-annotations {
  margin: 24px 0;
  border-block: 1px solid var(--line);
  padding: 16px 0;
}
summary {
  cursor: pointer;
  font-size: 14px;
  line-height: 1.7;
}
.assistant-note-list,
.assistant-turns {
  list-style: none;
  margin: 0;
  padding: 0;
}
.assistant-note-list li {
  background: var(--sage);
  padding: 12px;
  border-radius: 8px;
  margin-top: 10px;
}
.assistant-note-list p {
  margin-block: 6px;
  white-space: pre-wrap;
}
.assistant-quote {
  margin: 10px 0;
  padding-left: 12px;
  border-left: 2px solid var(--green);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow-y: auto;
}
.assistant-turns > li {
  padding: 20px 0;
  border-top: 1px solid var(--line);
}
.assistant-user {
  font-weight: 600;
  white-space: pre-wrap;
}
.assistant-reply {
  white-space: pre-wrap;
  line-height: 1.9;
}
.assistant-diff {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}
.assistant-suggestion {
  margin-bottom: 24px;
}
.diff-before,
.diff-after {
  margin: 6px 0 12px;
  padding: 12px;
  border-radius: 6px;
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
.diff-before {
  background: #f7eee9;
  border-left: 3px solid #b88a78;
}
.diff-after {
  background: var(--sage);
  border-left: 3px solid var(--green);
}
.assistant-panel .el-button {
  max-width: 100%;
  white-space: normal;
  height: auto;
  min-height: 44px;
  line-height: 1.5;
}
</style>
