<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Plus } from '@lucide/vue';
import type { Skill } from '@creator-ai/contracts';
import { downloadPackage, errorMessage, listAll, post } from '../api/client';
import PackageImport from '../components/PackageImport.vue';
import CapabilityHistory from '../components/CapabilityHistory.vue';

const skills = ref<Skill[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const filter = ref('');
const dialog = ref(false);
const editing = ref<Skill | null>(null);
const key = ref('');
const document = ref('');
const formError = ref('');
const historySkill = ref<Skill | null>(null);
const history = ref(false);
const visible = computed(() =>
  skills.value.filter((s) =>
    `${s.name} ${s.key} ${s.description}`.toLowerCase().includes(filter.value.toLowerCase()),
  ),
);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    skills.value = await listAll<Skill>('/skills');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
function open(skill: Skill | null = null, copy = false) {
  editing.value = copy ? null : skill;
  key.value = skill ? (copy ? `my-${skill.key.split(':').at(-1)}` : skill.key) : 'my-writing';
  const name = key.value.split(':').at(-1);
  document.value =
    copy || !skill?.document
      ? `---\nname: ${name}\ndescription: ${JSON.stringify(skill?.description ?? '用于把文章改成简洁、自然的表达')}\n---\n\n${skill?.instructions ?? '遵循账号人设，减少术语，不编造事实。'}\n`
      : skill.document;
  formError.value = '';
  dialog.value = true;
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  formError.value = '';
  try {
    const path = editing.value
      ? `/skills/${encodeURIComponent(editing.value.key)}/versions?baseVersion=${editing.value.version}`
      : '/skills';
    await post(path, { key: key.value, document: document.value });
    dialog.value = false;
    await load();
  } catch (reason) {
    formError.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function toggle(skill: Skill) {
  busy.value = true;
  error.value = '';
  try {
    await post(`/skills/${encodeURIComponent(skill.key)}/availability`, {
      enabled: skill.enabled === false,
      baseVersion: skill.version,
    });
    await load();
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function exportSkill(skill: Skill) {
  error.value = '';
  try {
    await downloadPackage(
      `/skills/${encodeURIComponent(skill.key)}/export`,
      `${skill.key.replace(':', '-')}.zip`,
    );
  } catch (reason) {
    error.value = errorMessage(reason);
  }
}
function showHistory(skill: Skill) {
  historySkill.value = skill;
  history.value = true;
}
onMounted(load);
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">REUSABLE CAPABILITIES</span>
      <h1>把好方法，留下来。</h1>
      <p>Skills 是能力包，不是固定选项。指令、参考资料与资源各自保存，版本可追溯。</p>
    </div>
    <div class="catalog-actions">
      <PackageImport @imported="load" /><el-button type="primary" @click="open()"
        ><Plus :size="18" /> 新建 Skill</el-button
      >
    </div>
  </section>
  <div class="expert-explainer">
    <div>
      <strong>可用、预加载、实际加载，是三个不同状态。</strong>
      <p>
        连接模型后支持按需加载指令与包内文本资料，实际加载单独记录；脚本只存档、不执行。专家可跟随最新或固定历史版本。内置定义只读，可复制成自定义技能。
      </p>
    </div>
  </div>
  <el-input
    v-model="filter"
    aria-label="搜索技能"
    placeholder="搜索名称、标识或使用场景"
    clearable
    class="catalog-search"
  />
  <p v-if="error" class="form-error" role="alert">
    {{ error }} <el-button text @click="load">重试</el-button>
  </p>
  <div v-if="loading" class="panel muted">正在读取技能库…</div>
  <div v-else-if="!visible.length" class="panel empty-state">
    没有匹配的技能，可以新建或导入能力包。
  </div>
  <div v-else class="card-grid">
    <article v-for="skill in visible" :key="skill.key" class="panel expert-card">
      <div class="card-top">
        <span class="small-tag">{{
          skill.source === 'builtin'
            ? '内置 · 只读'
            : skill.enabled === false
              ? '已停用'
              : '自定义 · 可绑定'
        }}</span
        ><span class="fine-print">v{{ skill.version }}</span>
      </div>
      <h2>{{ skill.name }}</h2>
      <code>{{ skill.key }}</code>
      <p>{{ skill.description }}</p>
      <p class="fine-print">{{ skill.files?.length ?? 0 }} 个附带资源 · 未执行</p>
      <details>
        <summary>指令与资源</summary>
        <pre class="catalog-code">{{ skill.document ?? skill.instructions }}</pre>
        <details v-for="file in skill.files" :key="file.path">
          <summary>{{ file.path }}</summary>
          <pre v-if="file.encoding === 'utf8'" class="catalog-code">{{ file.content }}</pre>
          <p v-else class="muted">二进制附件仅随 ZIP 导出，不在页面执行或预览。</p>
        </details>
        <p v-for="warning in skill.warnings" :key="warning" class="muted">{{ warning }}</p>
      </details>
      <div class="catalog-actions">
        <el-button text @click="open(skill, true)">复制指令</el-button
        ><el-button v-if="skill.source !== 'builtin'" text @click="open(skill)">编辑</el-button
        ><el-button text @click="exportSkill(skill)">导出 ZIP</el-button
        ><el-button v-if="skill.source !== 'builtin'" text @click="showHistory(skill)"
          >版本</el-button
        ><el-button
          v-if="skill.source !== 'builtin'"
          text
          :disabled="busy"
          @click="toggle(skill)"
          >{{ skill.enabled === false ? '启用' : '停用' }}</el-button
        >
      </div>
    </article>
  </div>
  <el-dialog
    v-model="dialog"
    :title="editing ? `编辑 Skill · v${editing.version}` : '创建 Skill'"
    width="760px"
    :show-close="!busy"
    :close-on-press-escape="!busy"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="save"
      ><el-form-item label="技能标识"
        ><el-input v-model="key" :disabled="!!editing" :maxlength="161" /></el-form-item
      ><el-form-item label="SKILL.md"
        ><el-input v-model="document" type="textarea" :rows="14" :maxlength="40000"
      /></el-form-item>
      <p class="muted">
        name 必须与标识末段一致；description 描述何时使用。附带资源通过 ZIP
        导入，编辑不会删除已有资源。复制指令不复制附件。
      </p>
      <p v-if="formError" role="alert" class="form-error">{{ formError }}</p>
      <div class="dialog-actions">
        <el-button :disabled="busy" @click="dialog = false">取消</el-button
        ><el-button type="primary" native-type="submit" :loading="busy">{{
          editing ? '保存新版本' : '创建技能'
        }}</el-button>
      </div></el-form
    >
  </el-dialog>
  <CapabilityHistory v-model="history" kind="skill" :item="historySkill" @restored="load" />
</template>
