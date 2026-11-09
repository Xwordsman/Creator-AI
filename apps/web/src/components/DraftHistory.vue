<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  runStatusLabels,
  type CreationRun,
  type Page,
  type RunHistoryItem,
} from '@creator-ai/contracts';
import { errorMessage, request } from '../api/client';

const props = defineProps<{ run: CreationRun }>();
const items = ref<RunHistoryItem[]>([]);
const page = ref(1);
const total = ref(0);
const loading = ref(false);
const error = ref('');
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<Page<RunHistoryItem>>(
      `/creation-runs/${props.run.id}/history?page=${page.value}&pageSize=10`,
    );
    if (current !== generation) return;
    items.value = result.items;
    total.value = result.total;
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (current === generation) loading.value = false;
  }
}
const short = (id: string) => id.slice(0, 8);
onMounted(load);
onUnmounted(() => {
  generation++;
});
</script>

<template>
  <section class="panel draft-history" aria-label="同主题创作历史">
    <div class="section-heading">
      <div>
        <span class="eyebrow">DRAFT LINEAGE</span>
        <h2>原稿与修改分支</h2>
      </div>
      <el-button :loading="loading" @click="load">刷新历史</el-button>
    </div>
    <p class="fine-print">
      按创建时间倒序；深度不是发布版本，也不代表已采纳。每份稿件独立执行、独立审核。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="run.lineage" class="lineage-links">
      <router-link :to="`/runs/${run.lineage.parentRunId}`"
        >查看来源稿 {{ short(run.lineage.parentRunId) }}</router-link
      ><router-link
        v-if="run.lineage.rootRunId !== run.lineage.parentRunId"
        :to="`/runs/${run.lineage.rootRunId}`"
        >查看最初原稿</router-link
      >
    </div>
    <ol class="history-list">
      <li v-for="item in items" :key="item.id" :class="{ current: item.id === run.id }">
        <router-link
          :to="`/runs/${item.id}`"
          :aria-current="item.id === run.id ? 'page' : undefined"
          ><strong
            >{{ item.lineage ? `修改分支 · 深度 ${item.lineage.depth}` : '最初原稿' }} ·
            {{ short(item.id) }}</strong
          ><span>{{ item.instruction ?? '首次创作' }}</span></router-link
        >
        <div class="fine-print">
          <span
            >{{ runStatusLabels[item.status] }}{{ item.id === run.id ? ' · 当前查看' : '' }}</span
          ><span v-if="item.lineage">来源 {{ short(item.lineage.parentRunId) }}</span>
        </div>
      </li>
    </ol>
    <el-pagination
      v-if="total > 10"
      v-model:current-page="page"
      :page-size="10"
      :total="total"
      layout="prev, pager, next"
      @current-change="load"
    />
  </section>
</template>
