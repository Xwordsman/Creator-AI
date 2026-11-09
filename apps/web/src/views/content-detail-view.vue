<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router';
import {
  contentStatusLabels,
  saveContentSchema,
  localContentDraftSchema,
  restoreContentSchema,
  reviewContentSchema,
  applyContentSuggestions,
  documentSchema,
  editingDocumentSchema,
  manuscriptKey,
  type ContentSelection,
  type ContentTurnDetail,
  type Manuscript,
  type ContentDetail,
  type ContentVersion,
  type ContentReview,
  type DocumentNode,
  type Page,
  type ReviewContentInput,
} from '@creator-ai/contracts';
import { downloadPackage, errorMessage, post, request, RequestError } from '../api/client';
import { useSessionStore } from '../stores/session';
import ContentEditor from '../components/ContentEditor.vue';
import DraftPreview from '../components/DraftPreview.vue';
import ContentAssistantPanel from '../components/ContentAssistantPanel.vue';

type Summary = Omit<ContentVersion, 'document'>;
interface Pending {
  key: string;
  path: string;
  input: unknown;
}
interface LocalDraft {
  baseRevision: number;
  title: string;
  document: DocumentNode;
  note: string;
}
const route = useRoute(),
  session = useSessionStore();
const selection = ref<ContentSelection | null>(null),
  assistantAttention = ref(false);
const aiUndo = ref<{ before: Manuscript; after: string; revision: number; note: string } | null>(
  null,
);
const detail = ref<ContentDetail | null>(null),
  title = ref(''),
  document = ref<DocumentNode>({ type: 'doc', content: [] }),
  note = ref(''),
  baseRevision = ref(0);
const error = ref(''),
  notice = ref(''),
  busy = ref(false),
  loading = ref(false),
  pending = ref<Pending | null>(null),
  storageFailed = ref(false);
const versions = ref<Summary[]>([]),
  reviews = ref<ContentReview[]>([]),
  historyPage = ref(1),
  reviewPage = ref(1),
  versionTotal = ref(0),
  reviewTotal = ref(0);
const preview = ref<ContentVersion | null>(null),
  reviewNote = ref(''),
  ack = ref(false),
  exportFormat = ref<'json' | 'md' | 'html'>('md');
let generation = 0,
  previewGeneration = 0,
  historyGeneration = 0,
  actionToken = 0,
  hydrating = false;
const scope = computed(() => `creator-content:${session.info?.user.id}:${String(route.params.id)}`);
const dirty = computed(() => {
  if (!detail.value) return false;
  const parsed = editingDocumentSchema.safeParse(document.value);
  return (
    !parsed.success ||
    manuscriptKey({ title: title.value, document: parsed.data }) !==
      manuscriptKey(detail.value.version)
  );
});
const changedElsewhere = ref(false);
const conflict = computed(
  () =>
    changedElsewhere.value || (!!detail.value && baseRevision.value !== detail.value.item.revision),
);
const locked = computed(() => busy.value || !!pending.value || loading.value);
const clean = computed(() => !!detail.value && !dirty.value && !conflict.value && !locked.value);
const exportVersion = computed(
  () => preview.value?.version ?? detail.value?.item.currentVersion ?? 1,
);
const needsAck = computed(
  () =>
    !!detail.value &&
    (detail.value.item.isMock ||
      detail.value.item.status !== 'approved' ||
      exportVersion.value !== detail.value.item.currentVersion),
);
function readLocal<T>(suffix: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(`${scope.value}:${suffix}`) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
function setLocal(suffix: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(`${scope.value}:${suffix}`);
    else sessionStorage.setItem(`${scope.value}:${suffix}`, JSON.stringify(value));
    storageFailed.value = false;
    return true;
  } catch {
    storageFailed.value = true;
    return false;
  }
}
function apply(result: ContentDetail) {
  hydrating = true;
  changedElsewhere.value = false;
  detail.value = result;
  title.value = result.version.title;
  document.value = structuredClone(result.version.document);
  note.value = '';
  baseRevision.value = result.item.revision;
  selection.value = null;
  aiUndo.value = null;
  hydrating = false;
}
async function histories(current = generation) {
  const token = ++historyGeneration;
  const id = String(route.params.id);
  try {
    const [v, r] = await Promise.all([
      request<Page<Summary>>(`/contents/${id}/versions?page=${historyPage.value}&pageSize=10`),
      request<Page<ContentReview>>(`/contents/${id}/reviews?page=${reviewPage.value}&pageSize=10`),
    ]);
    if (current !== generation || token !== historyGeneration) return;
    versions.value = v.items;
    versionTotal.value = v.total;
    reviews.value = r.items;
    reviewTotal.value = r.total;
  } catch (reason) {
    if (current === generation && token === historyGeneration) error.value = errorMessage(reason);
  }
}
async function load(recover = true) {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  preview.value = null;
  previewGeneration++;
  try {
    const result = await request<ContentDetail>(`/contents/${String(route.params.id)}`);
    if (current !== generation) return;
    apply(result);
    if (recover) {
      const draft = readLocal<LocalDraft>('draft');
      const stored = readLocal<Pending>('pending');
      if (stored) {
        const schemas = {
          versions: saveContentSchema,
          restore: restoreContentSchema,
          reviews: reviewContentSchema,
        };
        const kind = stored.path?.split('/').at(-1) as keyof typeof schemas;
        if (
          /^[a-zA-Z0-9_-]{16,128}$/.test(stored.key) &&
          stored.path === `/contents/${result.item.id}/${kind}` &&
          schemas[kind]?.safeParse(stored.input).success
        )
          pending.value = stored;
        else
          error.value =
            '本地请求记录不可用。请先备份本地编辑，再核对服务器版本，不要假定上次操作未执行。';
      }
      if (draft && localContentDraftSchema.safeParse({ ...draft }).success) {
        title.value = draft.title;
        document.value = draft.document;
        note.value = draft.note;
        baseRevision.value = draft.baseRevision;
        notice.value = '已恢复此浏览器会话中的本地编辑。若服务器已更新，请先核对版本。';
      }
      if (pending.value)
        notice.value = '上次操作的结果尚未确认。请使用原请求重试，不要重新提交另一份内容。';
    }
    await histories(current);
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (current === generation) loading.value = false;
  }
}
function persistDraft() {
  if (hydrating || !detail.value || loading.value) return;
  setLocal(
    'draft',
    dirty.value
      ? {
          baseRevision: baseRevision.value,
          title: title.value,
          document: document.value,
          note: note.value,
        }
      : null,
  );
}
watch([title, document, note], persistDraft, { deep: true, flush: 'sync' });
async function sendPending() {
  if (!pending.value || busy.value) return;
  const current = generation,
    token = ++actionToken,
    op = JSON.parse(JSON.stringify(pending.value)) as Pending;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await post<ContentDetail>(op.path, op.input, { 'Idempotency-Key': op.key });
    if (current !== generation) return;
    if (!setLocal('pending', null))
      throw new Error('操作已保存，但无法清除本地请求标识。请保留页面并重试核对。');
    pending.value = null;
    setLocal('draft', null);
    notice.value = '操作已确认，正在读取服务器最新版本。';
    await load(false);
  } catch (reason) {
    if (current !== generation) return;
    if (
      reason instanceof RequestError &&
      reason.status >= 400 &&
      reason.status < 500 &&
      ![408, 429].includes(reason.status)
    ) {
      setLocal('pending', null);
      pending.value = null;
      if (reason.code === 'CONTENT_CONFLICT') {
        changedElsewhere.value = true;
      }
      if (reason.code === 'CONTENT_CONFLICT')
        notice.value = '本地编辑已保留。可下载本地备份，再读取服务器最新版本进行合并。';
    } else notice.value = '操作可能已经成功。编辑已锁定，请原样重试确认；不会自动重复提交。';
    error.value = errorMessage(reason);
  } finally {
    if (token === actionToken) busy.value = false;
  }
}
async function mutate(kind: 'versions' | 'restore' | 'reviews', input: unknown) {
  if (locked.value || !detail.value) return;
  const op = { key: crypto.randomUUID(), path: `/contents/${detail.value.item.id}/${kind}`, input };
  if (!setLocal('pending', op)) {
    error.value = '浏览器无法保留请求标识，暂不提交。请释放会话存储空间。';
    return;
  }
  pending.value = op;
  await sendPending();
}
async function save() {
  const parsed = saveContentSchema.safeParse({
    baseRevision: baseRevision.value,
    title: title.value,
    document: document.value,
    note: note.value,
  });
  if (!parsed.success) {
    error.value = '请检查标题（1–300 字）、段落数量与长度；标题段落不能为空，正文仅支持文本。';
    return;
  }
  await mutate('versions', parsed.data);
}
async function applySuggestions(turn: ContentTurnDetail, ids: string[]) {
  if (locked.value || conflict.value || !detail.value) return;
  const current = generation;
  busy.value = true;
  error.value = '';
  try {
    const latest = await request<ContentDetail>(`/contents/${detail.value.item.id}`);
    if (current !== generation) return;
    if (latest.item.revision !== baseRevision.value) {
      changedElsewhere.value = true;
      throw new Error('服务器稿件已变化，旧建议未应用。请先备份并核对最新版本。');
    }
    if (turn.baseRevision !== baseRevision.value)
      throw new Error('建议基于旧修订，请基于当前稿重新发送。');
    const before = { title: title.value, document: documentSchema.parse(document.value) };
    const next = applyContentSuggestions(before, turn, ids);
    aiUndo.value = {
      before,
      after: manuscriptKey(next),
      revision: baseRevision.value,
      note: note.value,
    };
    title.value = next.title;
    document.value = next.document;
    selection.value = null;
    if (!note.value) note.value = '采用 AI 协作建议，待人工核对';
    notice.value =
      '选中建议已应用到本地编辑稿，尚未保存。请阅读确认，再保存新版本；也可撤销本次 AI 修改。';
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (current === generation) busy.value = false;
  }
}
function undoAi() {
  if (!aiUndo.value || locked.value) return;
  const parsed = documentSchema.safeParse(document.value),
    undo = aiUndo.value;
  if (
    !parsed.success ||
    baseRevision.value !== undo.revision ||
    manuscriptKey({ title: title.value, document: parsed.data }) !== undo.after
  ) {
    error.value = '采用建议后稿件又有修改，不能直接撤销覆盖。请使用正文撤销或历史版本进行核对。';
    return;
  }
  title.value = undo.before.title;
  document.value = JSON.parse(JSON.stringify(undo.before.document));
  note.value = undo.note;
  aiUndo.value = null;
  notice.value = '已撤销本次 AI 修改，恢复采用前的本地稿。';
}
async function review(action: ReviewContentInput['action']) {
  if (!clean.value || !detail.value) return;
  const currentScope = scope.value;
  if (action === 'request_changes' && !reviewNote.value.trim()) {
    error.value = '请填写需要修改的原因。';
    return;
  }
  await mutate('reviews', {
    baseRevision: detail.value.item.revision,
    action,
    note: reviewNote.value,
  });
  if (currentScope === scope.value && !pending.value) reviewNote.value = '';
}
async function viewVersion(version: number) {
  const current = generation,
    token = ++previewGeneration;
  try {
    const result = await request<ContentVersion>(
      `/contents/${String(route.params.id)}/versions/${version}`,
    );
    if (current === generation && token === previewGeneration) {
      preview.value = result;
      ack.value = false;
    }
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  }
}
async function restore() {
  if (!preview.value || !clean.value || !detail.value) return;
  if (
    !window.confirm(
      `将 v${preview.value.version} 恢复为新版本？当前版本与审核记录不会删除，新版本需要重新审核。`,
    )
  )
    return;
  await mutate('restore', {
    baseRevision: detail.value.item.revision,
    version: preview.value.version,
  });
}
async function reloadLatest() {
  if (pending.value || busy.value) return;
  if (
    dirty.value &&
    !window.confirm('读取服务器版本会放弃当前本地编辑。建议先下载本地备份，是否继续？')
  )
    return;
  setLocal('draft', null);
  notice.value = '';
  await load(false);
}
function backup() {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            baseRevision: baseRevision.value,
            title: title.value,
            document: document.value,
            note: note.value,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
  );
  const a = globalThis.document.createElement('a');
  a.href = url;
  a.download = `local-edit-${String(route.params.id)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportFile() {
  if (!detail.value || locked.value) return;
  const current = generation;
  busy.value = true;
  error.value = '';
  try {
    await downloadPackage(
      `/contents/${detail.value.item.id}/export`,
      `content-${detail.value.item.id}-v${exportVersion.value}.${exportFormat.value}`,
      {
        version: exportVersion.value,
        format: exportFormat.value,
        acknowledgeUnreviewed: ack.value,
      },
    );
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (current === generation) busy.value = false;
  }
}
function unload(event: BeforeUnloadEvent) {
  if (dirty.value || pending.value || assistantAttention.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
const confirmLeave = () =>
  !(dirty.value || pending.value || assistantAttention.value) ||
  window.confirm('仍有未保存编辑或未确认请求。确认离开？本地恢复仅在此浏览器会话内有效。');
onBeforeRouteLeave(confirmLeave);
onBeforeRouteUpdate(confirmLeave);
watch(
  () => [route.params.id, session.info?.user.id],
  () => {
    generation++;
    actionToken++;
    busy.value = false;
    detail.value = null;
    pending.value = null;
    assistantAttention.value = false;
    aiUndo.value = null;
    selection.value = null;
    versions.value = [];
    reviews.value = [];
    notice.value = '';
    historyPage.value = 1;
    reviewPage.value = 1;
    if (session.info) void load();
  },
);
watch(exportVersion, () => {
  ack.value = false;
});
onMounted(() => {
  void load();
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  generation++;
  actionToken++;
  previewGeneration++;
  window.removeEventListener('beforeunload', unload);
});
</script>

<template>
  <router-link to="/contents" class="back-link">← 返回内容库</router-link>
  <section class="page-intro">
    <div>
      <span class="eyebrow">MAKE IT YOUR OWN</span>
      <h1>内容编辑台</h1>
      <p>人工稿独立保存 · 审核绑定版本 · 原始生成记录不变</p>
    </div>
    <el-button :disabled="locked" @click="reloadLatest">读取服务器最新版本</el-button>
  </section>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="notice" class="notice-banner" role="status">{{ notice }}</p>
  <p v-if="storageFailed" class="form-error" role="alert">
    本地会话存储不可用，请勿关闭页面，建议下载本地备份。
  </p>
  <div v-if="pending" class="notice-banner">
    <strong>请求结果待确认</strong>
    <p>保留原内容和请求标识，重试只确认同一次操作。</p>
    <el-button :loading="busy" @click="sendPending">原样重试并核对</el-button>
  </div>
  <div v-if="loading" class="panel muted">正在读取稿件…</div>
  <template v-else-if="detail">
    <div class="content-meta">
      <span class="run-status">{{ contentStatusLabels[detail.item.status] }}</span
      ><span>v{{ detail.item.currentVersion }} · 修订 {{ detail.item.revision }}</span
      ><span>{{ detail.item.accountName }}</span
      ><router-link :to="`/runs/${detail.item.sourceRunId}`">查看原始生成记录</router-link>
    </div>
    <div v-if="detail.item.isMock" class="notice-banner">
      模拟内容：可体验编辑、版本、送审与导出，但不能审核通过，不可正式发布。
    </div>
    <p v-if="conflict" class="form-error" role="alert">
      本地基于修订 {{ baseRevision }}，服务器为
      {{ detail.item.revision }}。请备份本地编辑，读取最新版本后人工合并。
    </p>
    <div class="content-workspace">
      <section class="panel content-manuscript" aria-label="人工编辑稿">
        <div class="section-heading">
          <h2>正在打磨的稿件</h2>
          <span class="fine-print">{{ dirty ? '有未保存修改' : '已与当前版本一致' }}</span>
        </div>
        <label class="field-label" for="content-title">内容标题</label
        ><input
          id="content-title"
          v-model="title"
          class="content-title-input"
          maxlength="300"
          :disabled="locked"
        />
        <ContentEditor v-model="document" :disabled="locked" @selection="selection = $event" />
        <label class="field-label" for="version-note">本次修改说明（可选）</label
        ><textarea id="version-note" v-model="note" maxlength="1000" rows="2" :disabled="locked" />
        <div class="content-actions">
          <el-button
            type="primary"
            :disabled="!dirty || locked || conflict"
            :loading="busy"
            @click="save"
            >保存新版本</el-button
          ><el-button @click="backup">下载本地编辑备份</el-button>
          <el-button v-if="aiUndo" :disabled="locked" @click="undoAi">撤销本次 AI 修改</el-button>
        </div>
        <p class="fine-print">
          保存或恢复都会生成新版本，并回到“编辑中”。备份包含本地修改，不代表已保存或已审核。
        </p>
      </section>
      <aside class="content-side">
        <ContentAssistantPanel
          :key="scope"
          :content-id="detail.item.id"
          :title="title"
          :document="document"
          :base-revision="baseRevision"
          :disabled="locked || conflict"
          :selection="selection"
          @apply="applySuggestions"
          @attention="assistantAttention = $event"
          @conflict="changedElsewhere = true"
        />
        <section class="panel" aria-label="版本审核">
          <span class="eyebrow">HUMAN IN THE LOOP</span>
          <h2>版本审核</h2>
          <p class="fine-print">
            只审核当前已保存版本。个人工作空间由你自行送审、核对，尚不提供多人角色分离。
          </p>
          <label class="field-label" for="review-note">审核意见 / 修改原因</label
          ><textarea
            id="review-note"
            v-model="reviewNote"
            :disabled="!clean"
            maxlength="2000"
            rows="3"
          />
          <div class="content-actions">
            <el-button
              v-if="['draft', 'changes_requested'].includes(detail.item.status)"
              :disabled="!clean"
              @click="review('submit')"
              >提交审核</el-button
            ><template v-if="detail.item.status === 'pending_review'"
              ><el-button
                type="primary"
                :disabled="!clean || detail.item.isMock"
                @click="review('approve')"
                >审核通过</el-button
              ><el-button
                :disabled="!clean || !reviewNote.trim()"
                @click="review('request_changes')"
                >要求修改</el-button
              ></template
            >
          </div>
          <p v-if="dirty" class="fine-print">请先保存编辑，再审核。</p>
        </section>
        <section class="panel" aria-label="导出内容">
          <span class="eyebrow">TAKE IT WITH YOU</span>
          <h2>导出 v{{ exportVersion }}</h2>
          <p class="fine-print">
            仅导出已保存的版本{{
              preview ? '（当前历史预览）' : ''
            }}，不含未保存编辑。不连接平台、不自动发布。
          </p>
          <label for="export-format" class="field-label">文件格式</label
          ><select id="export-format" v-model="exportFormat" :disabled="locked">
            <option value="md">Markdown</option>
            <option value="html">安全 HTML</option>
            <option value="json">结构化 JSON</option>
          </select>
          <label v-if="needsAck" class="content-check"
            ><input
              v-model="ack"
              type="checkbox"
              :disabled="locked"
            />我确认这是模拟、历史或未审核稿，仅用于人工核对。</label
          >
          <el-button :disabled="locked || (needsAck && !ack)" @click="exportFile"
            >导出已保存版本</el-button
          >
        </section>
      </aside>
    </div>
    <div class="content-history-grid">
      <section class="panel" aria-label="内容版本历史">
        <h2>不可变的版本历史</h2>
        <ul class="content-history">
          <li v-for="v in versions" :key="v.version">
            <div>
              <strong>v{{ v.version }} · {{ v.title }}</strong>
              <p class="fine-print">
                {{
                  v.kind === 'generated'
                    ? '从生成稿加入'
                    : v.kind === 'restore'
                      ? `恢复自 v${v.restoredFrom}`
                      : '人工编辑'
                }}
                · {{ v.note }}
              </p>
            </div>
            <el-button :disabled="locked" @click="viewVersion(v.version)"
              >预览 v{{ v.version }}</el-button
            >
          </li>
        </ul>
        <el-pagination
          v-if="versionTotal > 10"
          v-model:current-page="historyPage"
          :page-size="10"
          :total="versionTotal"
          layout="prev, pager, next"
          @current-change="histories()"
        />
      </section>
      <section class="panel" aria-label="人工审核记录">
        <h2>人工审核记录</h2>
        <p v-if="!reviews.length" class="fine-print">尚未送审。</p>
        <ul class="content-history">
          <li v-for="r in reviews" :key="r.id">
            <div>
              <strong
                >v{{ r.version }} ·
                {{
                  { submit: '提交审核', approve: '审核通过', request_changes: '要求修改' }[r.action]
                }}</strong
              >
              <p>{{ r.note || '未附意见' }}</p>
              <span class="fine-print">{{
                new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
              }}</span>
            </div>
          </li>
        </ul>
        <el-pagination
          v-if="reviewTotal > 10"
          v-model:current-page="reviewPage"
          :page-size="10"
          :total="reviewTotal"
          layout="prev, pager, next"
          @current-change="histories()"
        />
      </section>
    </div>
    <section v-if="preview" class="panel content-version-preview" aria-label="历史版本预览">
      <div class="section-heading">
        <h2>历史预览 · v{{ preview.version }}</h2>
        <el-button
          @click="
            preview = null;
            previewGeneration++;
          "
          >关闭历史预览</el-button
        >
      </div>
      <p class="fine-print">
        历史内容只读；恢复会产生新版本，不继承审核通过状态。导出将使用此预览版本。
      </p>
      <h3>{{ preview.title }}</h3>
      <DraftPreview :document="preview.document" /><el-button :disabled="!clean" @click="restore"
        >将此版本恢复为新版本</el-button
      >
    </section>
  </template>
</template>
