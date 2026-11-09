<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Expert, ExpertVersion, Skill, SkillVersion } from '@creator-ai/contracts';
import { errorMessage, listAll, post } from '../api/client';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ kind: 'expert' | 'skill'; item: Expert | Skill | null }>();
const emit = defineEmits<{ restored: [] }>();
const versions = ref<(ExpertVersion | SkillVersion)[]>([]);
const loading = ref(false),
  busy = ref(false),
  needsReload = ref(false);
const error = ref(''),
  notice = ref('');
const target = ref<number | null>(null);
const baseVersion = computed(() => versions.value[0]?.version ?? 0);
const path = computed(() =>
  !props.item
    ? ''
    : props.kind === 'expert'
      ? `/experts/${(props.item as Expert).id}`
      : `/skills/${encodeURIComponent((props.item as Skill).key)}`,
);
let generation = 0;
async function load() {
  if (!path.value || busy.value) return;
  const token = ++generation;
  loading.value = true;
  needsReload.value = true;
  target.value = null;
  error.value = '';
  try {
    const rows = await listAll<ExpertVersion | SkillVersion>(`${path.value}/versions`);
    if (token !== generation) return;
    versions.value = rows.sort((a, b) => b.version - a.version);
    needsReload.value = false;
  } catch (reason) {
    if (token === generation) error.value = errorMessage(reason);
  } finally {
    if (token === generation) loading.value = false;
  }
}
watch([open, path], ([visible]) => {
  generation++;
  versions.value = [];
  target.value = null;
  error.value = '';
  notice.value = '';
  needsReload.value = false;
  if (visible) void load();
});
async function restore() {
  if (busy.value || loading.value || needsReload.value || !target.value) return;
  const version = target.value;
  const token = generation;
  busy.value = true;
  error.value = '';
  try {
    const result = await post<Expert | Skill>(`${path.value}/restore`, {
      version,
      baseVersion: baseVersion.value,
    });
    if (token !== generation) return;
    notice.value = `已从 v${version} 恢复为新版本 v${result.version}，历史和已有任务未改变。`;
    target.value = null;
    emit('restored');
  } catch (reason) {
    if (token !== generation) return;
    error.value = `${errorMessage(reason)} 不自动重试；请重新读取历史，核对是否已产生新版本后再决定。`;
    needsReload.value = true;
  } finally {
    busy.value = false;
  }
  if (token === generation && !needsReload.value) await load();
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="`${kind === 'expert' ? '专家' : '技能'}版本与恢复`"
    width="760px"
    :show-close="!busy"
    :close-on-press-escape="!busy"
    :close-on-click-modal="false"
  >
    <p>
      <strong>{{ item?.name }}</strong> · 当前 v{{ baseVersion || '…' }}
    </p>
    <p class="fine-print">
      恢复会复制选中版本的定义与资源，追加一个新版本；不覆盖历史，不改变启停状态，也不修改任何已有任务。专家的“跟随最新”绑定仍跟随当前
      Skill，只有固定绑定会取对应历史资源。
    </p>
    <p v-if="notice" role="status" class="inline-note">{{ notice }}</p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <el-button :disabled="busy || loading" @click="load">重新读取历史</el-button>
    <p v-if="loading" role="status" class="muted">正在读取不可变版本…</p>
    <section
      v-if="target"
      class="restore-confirmation inline-note warning"
      aria-label="确认历史恢复"
    >
      <div>
        <strong>将 v{{ target }} 复制为 v{{ baseVersion + 1 }}？</strong>
        <p>仅在当前版本仍为 v{{ baseVersion }} 时保存。恢复不重新启用已停用的专家或技能。</p>
        <el-button :disabled="busy" @click="target = null">取消恢复</el-button>
        <el-button
          type="primary"
          :disabled="needsReload || loading"
          :loading="busy"
          @click="restore"
          >确认恢复为新版本</el-button
        >
      </div>
    </section>
    <details v-for="version in versions" :key="version.version" class="capability-version">
      <summary>
        v{{ version.version }} · {{ version.name
        }}{{ version.version === baseVersion ? '（当前）' : ''
        }}{{ version.restoredFrom ? ` · 恢复自 v${version.restoredFrom}` : '' }}
      </summary>
      <p class="fine-print">{{ version.createdAt }}</p>
      <pre class="catalog-code">{{ JSON.stringify(version, null, 2) }}</pre>
      <el-button
        :disabled="busy || loading || needsReload || version.version === baseVersion"
        @click="target = version.version"
        >恢复 v{{ version.version }} 为新版本</el-button
      >
    </details>
  </el-dialog>
</template>

<style scoped>
.capability-version {
  margin: 20px 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.restore-confirmation {
  margin-top: 16px;
}
</style>
