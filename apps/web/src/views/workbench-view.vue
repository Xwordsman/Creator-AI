<script setup lang="ts">
import WritingCardsPreview from '../components/WritingCardsPreview.vue';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, ArrowUpRight, Feather, Layers3, Sparkles } from '@lucide/vue';
import type {
  Account,
  CreationRun,
  CreateRunInput,
  Expert,
  ModelConnection,
  Page,
  RunLimits,
} from '@creator-ai/contracts';
import { errorMessage, listAll, post, request } from '../api/client';

const router = useRouter();
const route = useRoute();
const accounts = ref<Account[]>([]);
const experts = ref<Expert[]>([]);
const models = ref<ModelConnection[]>([]);
const modelConnectionId = ref('');
const teamMode = ref<'staged' | 'dynamic'>('staged');
const limits = reactive<RunLimits>({
  maxCalls: 24,
  maxTotalTokens: 200000,
  maxDurationSeconds: 600,
});
const usingModel = computed(() =>
  models.value.some((model) => model.id === modelConnectionId.value && model.enabled),
);
const total = ref(0);
const accountId = ref('');
const expertId = ref('');
const followsDefault = ref(false);
const topic = ref('');
const brief = ref('');
const error = ref('');
const loading = ref(true);
const busy = ref(false);
const key = ref<string | null>(null);
const selectedAccount = computed(() => accounts.value.find((a) => a.id === accountId.value));
const selectedExpert = computed(() => experts.value.find((e) => e.id === expertId.value));
const isTeam = computed(() => selectedExpert.value?.expertType === 'team');
const payload = computed<CreateRunInput>(() => ({
  accountId: accountId.value,
  ...(followsDefault.value
    ? { accountRevision: selectedAccount.value?.revision }
    : { expertId: expertId.value }),
  topic: topic.value,
  brief: brief.value,
  ...(usingModel.value
    ? {
        modelConnectionId: modelConnectionId.value,
        limits: { ...limits },
        ...(isTeam.value ? { teamMode: teamMode.value } : {}),
      }
    : {}),
}));
const selectableExperts = computed(() =>
  experts.value.filter(
    (item) => item.enabled !== false && (item.expertType !== 'team' || usingModel.value),
  ),
);
const validExpert = computed(() =>
  selectableExperts.value.some((item) => item.id === expertId.value),
);
const defaultExpert = computed(() =>
  experts.value.find((item) => item.id === selectedAccount.value?.defaultExpertId),
);
const defaultNotice = computed(() => {
  if (!selectedAccount.value?.defaultExpertId) return '';
  if (!followsDefault.value) return '本次已临时选择其他专家，不修改账号默认设置。';
  if (!defaultExpert.value) return '账号默认专家不可用，请重新选择；不会自动换成其他专家。';
  if (defaultExpert.value.enabled === false)
    return '账号默认专家已停用，请临时换选或在账号中重新设置。';
  if (defaultExpert.value.expertType === 'team' && !usingModel.value)
    return '账号默认专家为专家团，请选择模型连接或临时换选单专家；不会自动使用收费模型或降级模拟。';
  return `已沿用账号默认专家：${defaultExpert.value.name}。可以临时换选。`;
});
function applyAccountExpert() {
  followsDefault.value = !!selectedAccount.value?.defaultExpertId;
  expertId.value = selectedAccount.value?.defaultExpertId ?? selectableExperts.value[0]?.id ?? '';
}
watch(accountId, applyAccountExpert, { flush: 'sync' });
watch(
  () => JSON.stringify(payload.value),
  () => {
    key.value = null;
  },
  { flush: 'sync' },
);
watch(
  [usingModel, isTeam],
  () => {
    if (!usingModel.value || !isTeam.value) teamMode.value = 'staged';
  },
  { flush: 'sync' },
);
watch(selectableExperts, (available) => {
  if (!followsDefault.value && !available.some((expert) => expert.id === expertId.value))
    expertId.value = '';
});
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [a, e, r, m] = await Promise.all([
      listAll<Account>('/accounts'),
      listAll<Expert>('/experts'),
      request<Page<CreationRun>>('/creation-runs?pageSize=1'),
      request<ModelConnection[]>('/models'),
    ]);
    accounts.value = a;
    experts.value = e;
    models.value = m;
    total.value = r.total;
    const requested = typeof route.query.accountId === 'string' ? route.query.accountId : '';
    accountId.value = a.find((item) => item.id === requested)?.id ?? a[0]?.id ?? '';
    applyAccountExpert();
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
async function createRun() {
  if (
    busy.value ||
    !accountId.value ||
    !validExpert.value ||
    topic.value.trim().length < 2 ||
    (isTeam.value && !usingModel.value)
  )
    return;
  busy.value = true;
  error.value = '';
  key.value ??= crypto.randomUUID();
  const requestKey = key.value;
  const body = payload.value;
  try {
    const run = await post<CreationRun>('/creation-runs', body, { 'Idempotency-Key': requestKey });
    if (active && key.value === requestKey) await router.push(`/runs/${run.id}`);
  } catch (reason) {
    if (active) error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
let active = true;
onMounted(load);
onUnmounted(() => {
  active = false;
});
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">YOUR NEXT GOOD STORY</span>
      <h1>今天，让想法成稿。</h1>
      <p>选好账号与专家，剩下的，从一个主题开始。</p>
    </div>
    <span class="edition">工作手记<br /><b>No. 001</b></span>
  </section>
  <div class="metrics-strip">
    <span
      ><b>{{ accounts.length }}</b> 账号档案</span
    ><span
      ><b>{{ experts.length }}</b> 专家配置</span
    ><span
      ><b>{{ total }}</b> 创作记录</span
    ><span class="metrics-caption">背景只说一次，创作可以继续。</span>
  </div>
  <p v-if="error" role="alert" class="form-error">
    {{ error }} <el-button text @click="load">重新加载</el-button>
  </p>
  <div v-if="loading" class="panel muted">正在载入你的工作空间…</div>
  <div v-else class="workbench-grid">
    <section class="panel compose-panel">
      <div class="section-heading">
        <span class="icon-tile"><Feather :size="21" /></span>
        <div>
          <h2>开始一篇新内容</h2>
          <p>一次选择，复用你的创作背景</p>
        </div>
        <span class="small-tag">文字创作</span>
      </div>
      <div v-if="!accounts.length || !selectableExperts.length" class="onboarding-note">
        <strong>先准备账号和可用的专家</strong>
        <p>账号保存表达背景，专家保存工作方法；专家团需要先选择模型连接。</p>
        <router-link v-if="!accounts.length" to="/accounts"
          >创建账号档案 <ArrowUpRight :size="16" /></router-link
        ><router-link v-if="!selectableExperts.length" to="/experts"
          >添加创作专家 <ArrowUpRight :size="16"
        /></router-link>
      </div>
      <el-form label-position="top" :disabled="busy" novalidate @submit.prevent="createRun">
        <el-form-item label="本次使用的模型">
          <el-select v-model="modelConnectionId" size="large" :empty-values="[null, undefined]">
            <el-option label="模拟模板（无模型费用，仅单专家）" value="" />
            <el-option
              v-for="model in models"
              :key="model.id"
              :label="`${model.name} · ${model.model}${model.enabled ? '' : '（已停用）'}`"
              :value="model.id"
              :disabled="!model.enabled"
            />
          </el-select>
          <router-link v-if="!models.some((model) => model.enabled)" to="/models" class="fine-print"
            >在模型设置中添加连接，开放真实生成与专家团执行</router-link
          >
        </el-form-item>
        <div class="form-columns">
          <el-form-item label="为哪个账号创作"
            ><el-select v-model="accountId" placeholder="选择账号" size="large"
              ><el-option
                v-for="account in accounts"
                :key="account.id"
                :label="account.name"
                :value="account.id" /></el-select></el-form-item
          ><el-form-item label="交给哪位专家"
            ><el-select
              v-model="expertId"
              placeholder="选择专家"
              size="large"
              @change="followsDefault = false"
              ><el-option
                v-for="expert in experts"
                :key="expert.id"
                :label="`${expert.name}${expert.enabled === false ? '（已停用）' : expert.expertType === 'team' ? (usingModel ? '（专家团）' : '（需选择模型连接）') : ''}`"
                :disabled="
                  expert.enabled === false || (expert.expertType === 'team' && !usingModel)
                "
                :value="expert.id" /></el-select
          ></el-form-item>
        </div>
        <div
          v-if="defaultNotice"
          class="inline-note"
          :class="{ warning: followsDefault && !validExpert }"
          role="status"
        >
          <span>{{ defaultNotice }}</span>
          <el-button v-if="!followsDefault" text @click="applyAccountExpert"
            >使用账号默认专家</el-button
          >
        </div>
        <section v-if="isTeam" class="team-mode-panel" aria-labelledby="team-mode-title">
          <h3 id="team-mode-title">专家团协作方式</h3>
          <el-radio-group v-model="teamMode" aria-label="专家团协作方式" :disabled="!usingModel">
            <el-radio-button value="staged">分阶段协作</el-radio-button>
            <el-radio-button value="dynamic">动态协作</el-radio-button>
          </el-radio-group>
          <p v-if="teamMode === 'dynamic'" class="fine-print">
            主理人按轮次规划、委派任务并向你提问；执行计划需要你确认，可同意或拒绝。仅支持真实模型，规划与成员交流也会产生调用与
            Token 费用，次数可能多于分阶段模式，受本次总预算约束。
          </p>
          <p v-else class="fine-print">
            默认按已配置阶段执行，同阶段成员可并行交付，最后由主理人汇总。动态协作为可选模式，需要真实模型连接。
          </p>
        </section>
        <el-form-item label="这次，你想聊什么？"
          ><el-input
            v-model="topic"
            type="textarea"
            :rows="4"
            :maxlength="300"
            show-word-limit
            placeholder="例如：普通人如何用 AI，建立自己的知识库？"
        /></el-form-item>
        <div v-if="selectedExpert?.quickPrompts?.length" class="catalog-actions">
          <el-button
            v-for="prompt in selectedExpert.quickPrompts"
            :key="prompt"
            text
            @click="topic = prompt.slice(0, 300)"
            >{{ prompt }}</el-button
          >
        </div>
        <p v-if="selectedExpert?.defaultInitPrompt" class="muted">
          {{ selectedExpert.defaultInitPrompt }}
        </p>
        <el-form-item label="补充要求（可选）"
          ><el-input
            v-model="brief"
            type="textarea"
            :rows="2"
            :maxlength="2000"
            placeholder="想强调的观点、文章长度，或者这次特别想避开的表达…"
        /></el-form-item>
        <details v-if="usingModel" class="budget-panel">
          <summary>
            本次运行预算 · 最多 {{ limits.maxCalls }} 次调用 /
            {{ limits.maxTotalTokens.toLocaleString() }} Token
          </summary>
          <div class="budget-fields">
            <el-form-item label="调用次数上限"
              ><el-input-number v-model="limits.maxCalls" :min="1" :max="100" :value-on-clear="24"
            /></el-form-item>
            <el-form-item label="总 Token 预留上限"
              ><el-input-number
                v-model="limits.maxTotalTokens"
                :min="2000"
                :max="1000000"
                :step="1000"
                :value-on-clear="200000"
            /></el-form-item>
            <el-form-item label="最长运行秒数"
              ><el-input-number
                v-model="limits.maxDurationSeconds"
                :min="30"
                :max="1800"
                :step="30"
                :value-on-clear="600"
            /></el-form-item>
          </div>
          <p class="fine-print">
            按输入保守预留量 + 最大输出先占预算；结束后按服务商 usage
            记账。不是人民币费用上限。取消不保证免收已发送请求的费用。
          </p>
        </details>
        <p v-if="usingModel" class="inline-note warning">
          提交即将本次上下文交给所选模型服务商，并可能计费。{{
            isTeam
              ? teamMode === 'dynamic'
                ? '动态协作会多轮调用，等待你答复时暂停推进；回复或批准计划后可能继续产生费用。'
                : '专家团按已配置的阶段分工，主理人最终汇总。'
              : '专家依据本次账号背景与绑定技能生成候选内容。'
          }}不自动发布。
        </p>
        <div class="compose-footer">
          <span
            ><span class="status-dot"></span>
            {{ usingModel ? '独立模型调用 · 全程记录' : '本地模拟，不产生模型费用' }}</span
          ><el-button
            type="primary"
            size="large"
            native-type="submit"
            :loading="busy"
            :disabled="!accountId || !validExpert || topic.trim().length < 2"
            >{{
              usingModel
                ? selectedExpert?.expertType === 'team'
                  ? '启动专家团创作'
                  : '使用模型生成'
                : '生成模拟草稿'
            }}
            <ArrowRight :size="18"
          /></el-button>
        </div>
      </el-form>
    </section>
    <aside class="context-column">
      <section class="context-card">
        <span class="eyebrow"><Layers3 :size="15" /> 本次创作上下文</span>
        <h3>不必再介绍自己。</h3>
        <div class="context-row">
          <span>账号与人设</span><strong>{{ selectedAccount?.name ?? '等待选择账号' }}</strong>
          <p>{{ selectedAccount?.persona ?? '保存读者画像和表达习惯，每次创作直接使用。' }}</p>
          <WritingCardsPreview
            v-if="selectedAccount"
            :cards="(selectedAccount.writingCards ?? []).filter((c) => c.enabled)"
          />
          <router-link v-if="selectedAccount" to="/accounts">管理写作资料</router-link>
        </div>
        <div class="context-row">
          <span>专家与方法</span
          ><strong>{{
            selectedExpert ? `${selectedExpert.name} · v${selectedExpert.version}` : '等待选择专家'
          }}</strong>
          <p>{{ selectedExpert?.description ?? '专家是长期协作伙伴，不只是一个临时提示词。' }}</p>
        </div>
        <div v-if="selectedExpert" class="context-row">
          <span>已绑定技能</span><strong>{{ selectedExpert.skillKeys.length }} 项技能配置</strong>
          <p v-for="skillKey in selectedExpert.skillKeys" :key="skillKey">
            {{ skillKey }} ·
            {{
              selectedExpert.skillVersions?.[skillKey]
                ? `固定 v${selectedExpert.skillVersions[skillKey]}`
                : '跟随最新'
            }}
          </p>
        </div>
      </section>
      <section class="boundary-note">
        <Sparkles :size="21" />
        <h3>{{ usingModel ? '每一步，都有交付。' : '先搭好工作流，再接入 AI' }}</h3>
        <p>
          {{
            usingModel
              ? '模型任务保留成员交付、技能加载、工具记录和调用账本。结果不明确时停止自动重发，等待你核对。所有生成内容仍需人工审核。'
              : '当前草稿由固定模板生成，用于验证账号、专家快照和后台任务。在模型设置中添加连接后，可执行单专家，以及分阶段或动态专家团。'
          }}
        </p>
        <router-link to="/experts">认识你的专家 <ArrowUpRight :size="16" /></router-link>
      </section>
    </aside>
  </div>
</template>
