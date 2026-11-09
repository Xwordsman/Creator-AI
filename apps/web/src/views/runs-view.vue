<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ArrowUpRight, NotebookPen } from '@lucide/vue';
import { runStatusLabels, type CreationRun, type Page } from '@creator-ai/contracts';
import { errorMessage, request } from '../api/client';

const runs = ref<CreationRun[]>([]);
const page = ref(1);
const total = ref(0);
const loading = ref(false);
const error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await request<Page<CreationRun>>(
      `/creation-runs?page=${page.value}&pageSize=20`,
    );
    runs.value = result.items;
    total.value = result.total;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
const formatDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  });
onMounted(load);
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">THE WORK IN PROGRESS</span>
      <h1>每个想法，都有来处。</h1>
      <p>查看后台任务、历史配置与候选草稿。时间以北京时间显示。</p>
    </div>
    <el-button :loading="loading" @click="load">刷新记录</el-button>
  </section>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <div v-if="loading" class="panel muted">正在读取创作记录…</div>
  <div v-else-if="!runs.length" class="empty-state panel">
    <NotebookPen :size="36" />
    <h2>这里会留住你的创作过程</h2>
    <p>第一份任务，从一个小小的主题开始。</p>
    <router-link to="/">去创作工作台</router-link>
  </div>
  <section v-else class="panel run-list">
    <router-link v-for="run in runs" :key="run.id" :to="`/runs/${run.id}`" class="run-item"
      ><div>
        <span class="fine-print"
          >{{ run.snapshot.account.name }} / {{ run.snapshot.expert.name }} v{{
            run.snapshot.expert.version
          }}</span
        >
        <h2>{{ run.snapshot.topic }}</h2>
        <span class="fine-print"
          >{{ formatDate(run.createdAt) }} ·
          {{ run.lineage ? `修改分支 · 深度 ${run.lineage.depth} ·` : '' }}
          {{
            run.snapshot.provider === 'mock'
              ? '模拟任务'
              : run.snapshot.workflow === 'team-dynamic-v1'
                ? '动态专家团任务'
                : run.snapshot.expert.team
                  ? '专家团任务'
                  : '模型任务'
          }}</span
        >
      </div>
      <span class="run-status" :class="run.status">{{ runStatusLabels[run.status] }}</span
      ><ArrowUpRight :size="20"
    /></router-link>
  </section>
  <el-pagination
    v-if="total > 20"
    v-model:current-page="page"
    :page-size="20"
    :total="total"
    layout="prev, pager, next"
    @current-change="load"
  />
</template>
