<script setup lang="ts">
import WritingCardsPreview from '../components/WritingCardsPreview.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, CircleCheck, Download, LoaderCircle } from '@lucide/vue';
import {
  isTerminal,
  runStatusLabels,
  type CreationRun,
  type ContentDetail,
} from '@creator-ai/contracts';
import { errorMessage, post, request } from '../api/client';
import DraftPreview from '../components/DraftPreview.vue';
import RunExecutionPanel from '../components/RunExecutionPanel.vue';
import TeamCollaborationPanel from '../components/TeamCollaborationPanel.vue';
import ContinueDraftPanel from '../components/ContinueDraftPanel.vue';
import DraftHistory from '../components/DraftHistory.vue';
import { useSessionStore } from '../stores/session';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const run = ref<CreationRun | null>(null);
const error = ref('');
const connecting = ref(false);
const actionBusy = ref(false);
const importing = ref(false);
const note = ref('');
const usingModel = computed(() => run.value?.snapshot.provider === 'compatible');
let stream: EventSource | null = null;
let generation = 0;
let actionToken = 0;
let polling: ReturnType<typeof setInterval> | undefined;
let probeGeneration: number | null = null;
const stage = computed(() =>
  run.value?.status === 'succeeded'
    ? 3
    : ['running', 'waiting_user'].includes(run.value?.status ?? '')
      ? 2
      : 1,
);
function applySnapshot(result: CreationRun) {
  if (result.id !== String(route.params.id) || (run.value && result.revision < run.value.revision))
    return;
  run.value = result;
  if (isTerminal(result.status)) {
    stream?.close();
    connecting.value = false;
    error.value = '';
  }
}
async function probe() {
  if (!run.value || isTerminal(run.value.status) || probeGeneration === generation) return;
  const current = generation;
  const id = run.value.id;
  probeGeneration = current;
  try {
    const result = await request<CreationRun>(`/creation-runs/${id}`);
    if (current === generation) applySnapshot(result);
  } catch {
    // Read-only fallback: never retry an interactive response automatically.
  } finally {
    if (probeGeneration === current) probeGeneration = null;
  }
}
async function load() {
  const current = ++generation;
  stream?.close();
  stream = null;
  error.value = '';
  connecting.value = false;
  try {
    const result = await request<CreationRun>(`/creation-runs/${String(route.params.id)}`);
    if (current !== generation) return;
    applySnapshot(result);
    if (!isTerminal(result.status)) connect(result.id, current);
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  }
}
function connect(id: string, current: number) {
  stream = new EventSource(`/api/v1/creation-runs/${id}/events`);
  connecting.value = true;
  stream.onopen = () => {
    if (current !== generation) return;
    connecting.value = false;
  };
  stream.addEventListener('run.snapshot', (event: MessageEvent<string>) => {
    if (current !== generation) return;
    const snapshot = JSON.parse(event.data) as CreationRun;
    applySnapshot(snapshot);
    error.value = '';
  });
  stream.addEventListener('session.expired', () => {
    if (current !== generation) return;
    stream?.close();
    void session.refresh().then(() => {
      if (current === generation) return router.push('/login');
    });
  });
  stream.addEventListener('stream.unavailable', () => {
    if (current !== generation) return;
    stream?.close();
    connecting.value = false;
    error.value = '实时状态暂不可用，仍在定时读取快照；也可以手动刷新。';
  });
  stream.onerror = () => {
    if (current !== generation) return;
    connecting.value = true;
    error.value = '实时连接中断，正在重连。也可以手动刷新快照。';
    // EventSource hides HTTP status; a REST probe also handles expired initial handshakes.
    void probe();
  };
}
function download() {
  if (!run.value?.output) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(run.value.output, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `draft-${run.value.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function editContent() {
  if (!run.value || importing.value) return;
  const id = run.value.id;
  const current = generation;
  importing.value = true;
  try {
    const result = await post<ContentDetail>('/contents', { sourceRunId: id });
    if (current === generation) await router.push(`/contents/${result.item.id}`);
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    importing.value = false;
  }
}
async function action(kind: 'cancel' | 'reconcile') {
  if (!run.value || actionBusy.value) return;
  const current = generation;
  const token = ++actionToken;
  const id = run.value.id;
  actionBusy.value = true;
  error.value = '';
  try {
    const result = await post<CreationRun>(
      `/creation-runs/${id}/${kind}`,
      kind === 'reconcile' ? { note: note.value } : {},
    );
    if (current !== generation) return;
    applySnapshot(result);
    note.value = '';
    if (isTerminal(result.status)) {
      stream?.close();
      connecting.value = false;
    }
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (token === actionToken) actionBusy.value = false;
  }
}
watch(
  () => route.params.id,
  () => {
    run.value = null;
    note.value = '';
    actionToken++;
    actionBusy.value = false;
    void load();
  },
);
onMounted(() => {
  void load();
  polling = setInterval(() => {
    void probe();
  }, 8000);
});
onUnmounted(() => {
  generation++;
  actionToken++;
  stream?.close();
  clearInterval(polling);
});
</script>

<template>
  <router-link to="/runs" class="back-link"><ArrowLeft :size="16" /> 返回创作记录</router-link>
  <p v-if="error" class="form-error" role="alert">
    {{ error }} <el-button text @click="load">刷新快照</el-button>
  </p>
  <div v-if="!run" class="panel muted">{{ error ? '暂时无法读取任务。' : '正在读取任务…' }}</div>
  <template v-else>
    <section class="page-intro">
      <div>
        <span class="eyebrow">{{
          usingModel ? 'DRAFT / AGENT RUNTIME' : 'DRAFT / MOCK PROVIDER'
        }}</span>
        <h1>{{ run.snapshot.topic }}</h1>
        <p>
          {{ run.snapshot.account.name }} · {{ run.snapshot.expert.name }} v{{
            run.snapshot.expert.version
          }}
          · {{ runStatusLabels[run.status] }}
        </p>
      </div>
      <el-button v-if="run.output" @click="download"
        ><Download :size="17" />
        {{ run.snapshot.assistance ? '下载协作结果 JSON' : '下载草稿 JSON' }}</el-button
      >
      <el-button
        v-if="run.status === 'succeeded' && run.output && !run.snapshot.assistance"
        type="primary"
        :loading="importing"
        @click="editContent"
        >加入内容库 / 编辑</el-button
      >
      <el-button
        v-if="!isTerminal(run.status)"
        :loading="actionBusy"
        :disabled="run.cancelRequested"
        @click="action('cancel')"
        >{{ run.cancelRequested ? '正在停止后续调用…' : '取消任务' }}</el-button
      >
    </section>
    <div v-if="run.snapshot.assistance" class="inline-note warning">
      这是文章协作记录，正文快照不是新文章，建议未自动采用。
      <router-link :to="`/contents/${run.snapshot.assistance.contentId}`"
        >返回原稿讨论并选择修改</router-link
      >
    </div>
    <div v-else class="inline-note warning">
      <span
        >{{
          usingModel ? 'AI 候选草稿，尚未人工审核，不可直接发布。' : '模拟草稿，不可直接发布。'
        }}此处保留原始生成结果；加入内容库后可独立编辑、审核和导出，不会覆盖原稿。</span
      >
    </div>
    <section v-if="run.status === 'needs_review'" class="panel review-panel">
      <h2>请求结果不明确，已停止自动重发</h2>
      <p>
        可能已在服务商侧完成或计费。请依据调用账本中的标识核对服务商记录。取消任务不保证撤销已发送的请求。
      </p>
      <el-form label-position="top" @submit.prevent="action('reconcile')"
        ><el-form-item label="人工核对说明"
          ><el-input
            v-model="note"
            type="textarea"
            :rows="3"
            :minlength="10"
            :maxlength="2000"
            placeholder="记录你核对的服务商记录、账单或处理决定（至少 10 字）。确认后仅关闭任务，不重试、不清除未知调用证据。" /></el-form-item
        ><el-button native-type="submit" :loading="actionBusy" :disabled="note.trim().length < 10"
          >记录核对说明并关闭任务</el-button
        ></el-form
      >
    </section>
    <TeamCollaborationPanel
      v-if="run.snapshot.workflow === 'team-dynamic-v1'"
      :key="run.id"
      :run="run"
      :disabled="actionBusy"
      @resolved="applySnapshot"
      @refresh="load"
    />
    <div class="detail-grid">
      <section class="panel draft-paper">
        <template v-if="run.output?.assistance">
          <span class="eyebrow">{{
            run.output.isMock ? '模拟协作 · 未调用 AI' : '文章协作回复'
          }}</span>
          <p class="assistant-run-reply">{{ run.output.assistance.reply }}</p>
          <p>
            共 {{ run.output.assistance.suggestions.length }} 条局部修改建议，请回原稿逐项核对采用。
          </p>
        </template>
        <template v-else-if="run.output"
          ><span class="eyebrow">{{
            run.output.isMock ? '待审核 · 模拟输出' : '待审核 · AI 候选正文'
          }}</span>
          <h2>{{ run.output.title }}</h2>
          <DraftPreview :document="run.output.document"
        /></template>
        <div v-else class="empty-state">
          <LoaderCircle
            v-if="!isTerminal(run.status) && run.status !== 'waiting_user'"
            :size="32"
            class="loading-icon"
          />
          <h2>
            {{
              isTerminal(run.status) || run.status === 'waiting_user'
                ? runStatusLabels[run.status]
                : '任务已保存在服务器'
            }}
          </h2>
          <p>
            {{
              isTerminal(run.status)
                ? `任务已停止${run.failureCode ? `，类别：${run.failureCode}` : ''}。${usingModel ? '详情见执行过程；请求结果不明确时，请先核对服务商记录。' : '没有生成可用草稿。'}`
                : run.status === 'waiting_user'
                  ? '团队已暂停推进，请在协作面板答复。记录保存在服务器，稍后回来仍可继续。'
                  : '你可以离开页面。Worker 会在后台执行，重新打开后仍能查看结果。'
            }}
          </p>
          <el-button @click="load">刷新状态</el-button>
        </div>
      </section>
      <aside class="context-card task-context">
        <span class="eyebrow">EXECUTION SNAPSHOT</span>
        <h3>这一次，如何完成</h3>
        <ol class="task-steps">
          <li
            v-for="(label, index) in [
              '任务持久化',
              'Worker 执行',
              usingModel ? '候选正文入库' : '模拟草稿入库',
            ]"
            :key="label"
            :class="{ done: stage > index }"
          >
            <CircleCheck :size="18" /> {{ label }}
          </li>
        </ol>
        <div class="context-row">
          <span>技能版本</span>
          <p v-for="skill in run.snapshot.skills" :key="skill.key">
            {{ skill.name }} · v{{ skill.version }}
          </p>
        </div>
        <div class="context-row">
          <span>账号写作资料快照 · r{{ run.snapshot.account.revision }}</span>
          <WritingCardsPreview
            :cards="(run.snapshot.account.writingCards ?? []).filter((c) => c.enabled)"
          />
        </div>
        <div v-if="run.snapshot.model" class="context-row">
          <span>模型快照</span><strong>{{ run.snapshot.model.name }}</strong>
          <p>{{ run.snapshot.model.model }}</p>
          <span class="fine-print"
            >最多 {{ run.snapshot.limits?.maxCalls }} 次调用 ·
            {{ run.snapshot.limits?.maxDurationSeconds }} 秒</span
          >
        </div>
        <div class="context-row">
          <span>执行次数</span><strong>{{ run.attempts }} / 3</strong>
        </div>
        <div class="context-row">
          <span>任务标识</span><code class="run-id">{{ run.id }}</code>
        </div>
        <span class="fine-print">{{
          connecting ? '正在连接实时状态…' : '以数据库中的最新状态为准'
        }}</span>
      </aside>
    </div>
    <RunExecutionPanel :run="run" />
    <ContinueDraftPanel
      v-if="run.status === 'succeeded' && run.output && !run.snapshot.assistance"
      :key="run.id"
      :run="run"
    />
    <DraftHistory v-if="!run.snapshot.assistance" :key="run.id" :run="run" />
  </template>
</template>
