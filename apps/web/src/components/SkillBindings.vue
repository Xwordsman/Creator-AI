<script setup lang="ts">
import { ref } from 'vue';
import type { Skill, SkillVersion } from '@creator-ai/contracts';
import { errorMessage, listAll } from '../api/client';

const bindings = defineModel<Record<string, number> | undefined>();
const props = defineProps<{ keys: string[]; skills: Skill[] }>();
const history = ref<Record<string, SkillVersion[]>>({});
const loading = ref<Record<string, boolean>>({});
const errors = ref<Record<string, string>>({});
function options(key: string) {
  return [
    ...new Set(
      [
        props.skills.find((skill) => skill.key === key)?.version,
        bindings.value?.[key],
        ...(history.value[key] ?? []).map((item) => item.version),
      ].filter((value): value is number => value !== undefined),
    ),
  ].sort((a, b) => b - a);
}
async function load(key: string, visible: boolean) {
  if (
    !visible ||
    loading.value[key] ||
    props.skills.find((skill) => skill.key === key)?.source === 'builtin'
  )
    return;
  loading.value[key] = true;
  errors.value[key] = '';
  try {
    history.value[key] = await listAll<SkillVersion>(`/skills/${encodeURIComponent(key)}/versions`);
  } catch (reason) {
    errors.value[key] = errorMessage(reason);
  } finally {
    loading.value[key] = false;
  }
}
function set(key: string, version: number) {
  const next = { ...bindings.value };
  if (version) next[key] = version;
  else delete next[key];
  bindings.value = next;
}
</script>

<template>
  <section v-if="keys.length" class="skill-bindings" aria-label="技能版本绑定">
    <h3>技能版本策略</h3>
    <p class="fine-print">
      跟随最新：每次新创作解析当前版本。固定版本：始终使用指定历史定义与资源。专家团所有成员统一继承这里的版本，不影响旧任务。
    </p>
    <el-form-item
      v-for="key in keys"
      :key="key"
      :label="`${skills.find((skill) => skill.key === key)?.name ?? key} · 版本策略`"
    >
      <el-select
        :model-value="bindings?.[key] ?? 0"
        :aria-label="`${key} 版本策略`"
        @update:model-value="(version: number) => set(key, version)"
        @visible-change="(visible: boolean) => load(key, visible)"
      >
        <el-option
          :value="0"
          :label="`跟随最新（当前 v${skills.find((skill) => skill.key === key)?.version ?? '?'}）`"
        />
        <el-option
          v-for="version in options(key)"
          :key="version"
          :value="version"
          :label="`固定 v${version}`"
        />
      </el-select>
      <span v-if="loading[key]" class="fine-print" role="status">正在读取历史版本…</span>
      <span v-if="errors[key]" class="form-error" role="alert"
        >{{ errors[key] }} 重新展开可重试；未读取的历史不能视为已验证。</span
      >
    </el-form-item>
  </section>
</template>
