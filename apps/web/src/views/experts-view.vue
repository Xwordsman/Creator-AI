<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Plus, UsersRound } from '@lucide/vue';
import type { Expert, Skill } from '@creator-ai/contracts';
import { downloadPackage, errorMessage, listAll, post } from '../api/client';
import ExpertEditor from '../components/ExpertEditor.vue';
import PackageImport from '../components/PackageImport.vue';
import CapabilityHistory from '../components/CapabilityHistory.vue';

const experts = ref<Expert[]>([]);
const skills = ref<Skill[]>([]);
const loading = ref(true);
const busy = ref(false);
const dialog = ref(false);
const editing = ref<Expert | null>(null);
const copy = ref(false);
const kind = ref<'agent' | 'team'>('agent');
const error = ref('');
const filter = ref('all');
const search = ref('');
const historyExpert = ref<Expert | null>(null);
const history = ref(false);
const visible = computed(() =>
  experts.value.filter(
    (expert) =>
      (filter.value === 'all' ||
        (filter.value === 'disabled'
          ? expert.enabled === false
          : (expert.expertType ?? 'agent') === filter.value)) &&
      `${expert.name} ${expert.description} ${(expert.tags ?? []).join(' ')}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    [experts.value, skills.value] = await Promise.all([
      listAll<Expert>('/experts'),
      listAll<Skill>('/skills'),
    ]);
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
function openForm(expert: Expert | null = null, isCopy = false, type: 'agent' | 'team' = 'agent') {
  editing.value = expert;
  copy.value = isCopy;
  kind.value = type;
  dialog.value = true;
}
async function toggle(expert: Expert) {
  busy.value = true;
  error.value = '';
  try {
    await post(`/experts/${expert.id}/availability`, {
      enabled: expert.enabled === false,
      baseVersion: expert.version,
    });
    await load();
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function exportPackage(expert: Expert, original = false) {
  error.value = '';
  try {
    await downloadPackage(
      `/experts/${expert.id}/export?original=${original}`,
      `expert-${expert.id}${original ? '-original' : ''}.zip`,
    );
  } catch (reason) {
    error.value = errorMessage(reason);
  }
}
function showHistory(expert: Expert) {
  historyExpert.value = expert;
  history.value = true;
}
onMounted(load);
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">YOUR EDITORIAL TEAM</span>
      <h1>不只是提示词，是你的专家。</h1>
      <p>保存身份与工作方法，组合独立成员。一个专家，也可以是一间编辑部。</p>
    </div>
    <div class="catalog-actions">
      <PackageImport @imported="load" /><el-button @click="openForm(null, false, 'team')"
        >组建专家团</el-button
      ><el-button type="primary" @click="openForm()"><Plus :size="18" /> 添加专家</el-button>
    </div>
  </section>
  <div class="expert-explainer">
    <UsersRound :size="28" />
    <div>
      <strong>专家有默认身份，账号决定本次表达。</strong>
      <p>
        技能可选、按需加载；专家团有主理人与独立角色。选择模型连接后，按配置阶段独立执行、交接与汇总。
      </p>
    </div>
    <router-link to="/skills" class="small-tag">管理技能库</router-link>
  </div>
  <div class="catalog-toolbar">
    <el-radio-group v-model="filter" aria-label="专家类型筛选"
      ><el-radio-button value="all">全部</el-radio-button
      ><el-radio-button value="agent">单专家</el-radio-button
      ><el-radio-button value="team">专家团</el-radio-button
      ><el-radio-button value="disabled">已停用</el-radio-button></el-radio-group
    ><el-input
      v-model="search"
      aria-label="搜索专家"
      placeholder="搜索名称、职责或标签"
      clearable
    />
  </div>
  <p v-if="error" class="form-error" role="alert">
    {{ error }} <el-button text @click="load">重试</el-button>
  </p>
  <div v-if="loading" class="panel muted">正在读取专家…</div>
  <div v-else-if="!experts.length" class="empty-state panel">
    <UsersRound :size="36" />
    <h2>邀请你的第一位创作伙伴</h2>
    <p>从「公众号主笔」开始，也可以直接导入专家包或组建专家团。</p>
    <el-button @click="openForm()">从主笔模板创建</el-button>
  </div>
  <div v-else-if="!visible.length" class="empty-state panel">没有匹配的专家。</div>
  <div v-else class="card-grid">
    <article v-for="expert in visible" :key="expert.id" class="panel expert-card">
      <div class="card-top">
        <span class="expert-monogram">{{ expert.name.slice(0, 1) }}</span
        ><span class="small-tag">v{{ expert.version }}</span>
      </div>
      <h2>{{ expert.name }}</h2>
      <span class="fine-print"
        >{{ expert.expertType === 'team' ? '专家团 · 模型连接后可执行' : '单专家 · 模拟或模型执行'
        }}{{ expert.enabled === false ? ' · 已停用' : '' }}</span
      >
      <p>{{ expert.description }}</p>
      <div v-if="expert.team" class="team-roster">
        <div v-for="member in expert.team.members" :key="member.agentId">
          <b>{{ member.agentId === expert.team.leadAgent ? '主理人' : '成员' }}</b>
          {{ member.name }} <small>{{ member.profession }}</small>
        </div>
        <p class="fine-print">
          {{ expert.team.phases?.length ?? 0 }} 个结构化阶段 · 成员定义随团队版本保存
        </p>
      </div>
      <div class="skill-tags">
        <span v-for="key in expert.skillKeys" :key="key">{{
          `${skills.find((skill) => skill.key === key)?.name ?? key} · ${expert.skillVersions?.[key] ? `固定 v${expert.skillVersions[key]}` : '跟随最新'}`
        }}</span
        ><span v-if="!expert.skillKeys.length">无绑定技能</span>
      </div>
      <div class="catalog-actions">
        <el-button text @click="openForm(expert)">配置专家</el-button
        ><el-button text @click="openForm(expert, true)">复制</el-button
        ><el-button text @click="showHistory(expert)">版本</el-button
        ><el-button text @click="exportPackage(expert)">导出 ZIP</el-button
        ><el-button v-if="expert.hasSourcePackage" text @click="exportPackage(expert, true)"
          >原始包</el-button
        ><el-button text :disabled="busy" @click="toggle(expert)">{{
          expert.enabled === false ? '启用' : '停用'
        }}</el-button>
      </div>
    </article>
  </div>
  <ExpertEditor
    v-model="dialog"
    :expert="editing"
    :copy="copy"
    :kind="kind"
    :experts="experts"
    :skills="skills"
    @saved="load"
  />
  <CapabilityHistory v-model="history" kind="expert" :item="historyExpert" @restored="load" />
</template>
