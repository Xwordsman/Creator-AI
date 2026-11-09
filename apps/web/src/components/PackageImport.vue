<script setup lang="ts">
import { ref } from 'vue';
import type { PackagePreview } from '@creator-ai/contracts';
import { errorMessage, request } from '../api/client';

const emit = defineEmits<{ imported: [] }>();
const dialog = ref(false);
const file = ref<File | null>(null);
const preview = ref<PackagePreview | null>(null);
const busy = ref(false);
const error = ref('');
function open() {
  dialog.value = true;
  file.value = null;
  preview.value = null;
  error.value = '';
}
async function inspect(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  preview.value = null;
  file.value = selected ?? null;
  error.value = '';
  if (!selected) return;
  if (selected.size > 2 * 1024 * 1024) {
    error.value = 'ZIP 包不能超过 2 MiB。';
    return;
  }
  busy.value = true;
  try {
    preview.value = await upload<PackagePreview>('/packages/preview');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
function upload<T>(path: string) {
  return request<T>(path, {
    method: 'POST',
    body: file.value!,
    headers: { 'Content-Type': 'application/zip' },
  });
}
async function install() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await upload('/packages/import');
    dialog.value = false;
    emit('imported');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <el-button @click="open">导入能力包</el-button>
  <el-dialog
    v-model="dialog"
    title="导入专家 / 专家团 / Skill"
    width="700px"
    :close-on-click-modal="false"
    :show-close="!busy"
    :close-on-press-escape="!busy"
  >
    <p>
      支持含 SKILL.md 或 .codebuddy-plugin/plugin.json 的 ZIP。最多 128 个条目、单文件 512
      KiB、解压后共 4 MiB；可含一层外包装目录。
    </p>
    <label class="upload-label"
      >选择 ZIP 包
      <input type="file" accept=".zip,application/zip" :disabled="busy" @change="inspect"
    /></label>
    <p v-if="busy" role="status">正在校验或保存…</p>
    <template v-if="preview">
      <h3>
        {{ preview.name }} <small>{{ preview.packageVersion ?? 'Skill' }}</small>
      </h3>
      <p>
        {{
          preview.expert?.expertType === 'team'
            ? '专家团'
            : preview.kind === 'expert'
              ? '单专家'
              : '技能'
        }}
        · {{ preview.skills.length }} 个技能 · {{ preview.files.length }} 个文件
      </p>
      <div class="inline-note warning">
        <div>
          <strong>导入不等于具备运行能力</strong>
          <p v-for="warning in preview.warnings" :key="warning">{{ warning }}</p>
        </div>
      </div>
      <details>
        <summary>查看文件清单（不会执行或渲染文件）</summary>
        <ul>
          <li v-for="item in preview.files" :key="item.path">
            <code>{{ item.path }}</code> · {{ item.encoding }}
          </li>
        </ul>
      </details>
      <p class="fine-print">
        同名技能会拒绝整个导入，不覆盖已有版本。请只导入你有权使用和分发的内容。
      </p>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <el-button :disabled="busy" @click="dialog = false">取消</el-button
      ><el-button type="primary" :disabled="!preview" :loading="busy" @click="install"
        >确认保存能力包</el-button
      >
    </div>
  </el-dialog>
</template>

<style scoped>
.upload-label {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px dashed var(--line);
}
details {
  margin: 20px 0;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
}
</style>
