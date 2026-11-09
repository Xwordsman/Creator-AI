<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ContentWritingProfiles } from '@creator-ai/contracts';
import { request, errorMessage } from '../api/client';
import WritingCardsPreview from './WritingCardsPreview.vue';

const props = defineProps<{ contentId: string; modelValue?: number; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: number | undefined] }>();
const profiles = ref<ContentWritingProfiles | null>(null),
  error = ref(''),
  loading = ref(false);
let active = true;
const chosen = computed(() =>
  props.modelValue === undefined
    ? profiles.value?.original
    : props.modelValue === profiles.value?.current.revision
      ? profiles.value.current
      : undefined,
);
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const data = await request<ContentWritingProfiles>(
      `/contents/${props.contentId}/assistant-turns/writing-profile`,
    );
    if (
      !data?.original ||
      !data.current ||
      (data.original.revision !== undefined && !Number.isInteger(data.original.revision)) ||
      !Number.isInteger(data.current.revision)
    )
      throw new Error('资料响应格式无效，请重新读取。');
    if (active) profiles.value = data;
  } catch (reason) {
    if (active) error.value = errorMessage(reason);
  } finally {
    if (active) loading.value = false;
  }
}
function select(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit('update:modelValue', value === 'original' ? undefined : Number(value));
}
onMounted(load);
onBeforeUnmount(() => {
  active = false;
});
</script>

<template>
  <div class="writing-profile">
    <label class="field-label" for="assistant-writing-profile">本轮账号人设与写作资料</label>
    <select
      id="assistant-writing-profile"
      :value="modelValue ?? 'original'"
      :disabled="disabled"
      @change="select"
    >
      <option value="original">
        沿用原稿资料{{
          profiles
            ? profiles.original.revision === undefined
              ? ' · 未记录修订'
              : ` · r${profiles.original.revision}`
            : ''
        }}
      </option>
      <option
        v-if="modelValue !== undefined && modelValue !== profiles?.current.revision"
        :value="modelValue"
      >
        此前选择 r{{ modelValue }} · 请刷新资料并重新选择
      </option>
      <option v-if="profiles" :value="profiles.current.revision">
        使用账号当前资料 · r{{ profiles.current.revision }}
      </option>
    </select>
    <p v-if="error" class="form-error" role="alert">写作资料读取失败：{{ error }}</p>
    <p v-if="modelValue !== undefined && !chosen" class="form-error">
      当前选择尚未核对或已过期，请刷新资料，再明确选择本轮要使用的版本。
    </p>
    <details v-if="chosen">
      <summary>
        查看本轮资料 · {{ chosen.writingCards?.filter((c) => c.enabled).length ?? 0 }} 份启用
      </summary>
      <p class="fine-print preserve-lines">{{ chosen.persona }}</p>
      <WritingCardsPreview :cards="(chosen.writingCards ?? []).filter((c) => c.enabled)" />
    </details>
    <div class="profile-actions">
      <el-button text :disabled="disabled" :loading="loading" @click="load">刷新写作资料</el-button
      ><router-link to="/accounts">管理账号资料</router-link>
    </div>
    <p class="fine-print">
      沿用原稿为默认。选择当前资料只影响本轮账号背景；专家与技能仍沿用原稿快照。范文用于参考表达，不能当作作者经历。
    </p>
  </div>
</template>

<style scoped>
.writing-profile {
  margin-block: 18px;
  padding-block: 12px;
  border-block: 1px solid var(--line);
}
summary {
  cursor: pointer;
  font-size: 13px;
  line-height: 1.8;
  margin-top: 12px;
}
.profile-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 13px;
}
</style>
