<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { contentStatusLabels, type ContentItem, type Page } from '@creator-ai/contracts';
import { errorMessage, request } from '../api/client';
const items = ref<ContentItem[]>([]),
  page = ref(1),
  total = ref(0),
  loading = ref(false),
  error = ref('');
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<Page<ContentItem>>(`/contents?page=${page.value}&pageSize=20`);
    if (current !== generation) return;
    items.value = result.items;
    total.value = result.total;
  } catch (reason) {
    if (current === generation) error.value = errorMessage(reason);
  } finally {
    if (current === generation) loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">THE EDITORIAL DESK</span>
      <h1>好内容，值得再打磨。</h1>
      <p>独立保存人工稿、版本与审核记录。原始生成结果始终留在创作记录中。</p>
    </div>
    <el-button :loading="loading" @click="load">刷新内容</el-button>
  </section>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <div v-if="loading" class="panel muted">正在读取内容库…</div>
  <div v-else-if="!items.length" class="empty-state panel">
    <h2>把候选稿带到编辑台</h2>
    <p>在已完成的任务中点击“加入内容库 / 编辑”，即可开始人工打磨。</p>
    <router-link to="/runs">去创作记录选稿</router-link>
  </div>
  <section v-else class="panel run-list">
    <router-link v-for="item in items" :key="item.id" :to="`/contents/${item.id}`" class="run-item"
      ><div>
        <span class="fine-print"
          >{{ item.accountName }} · v{{ item.currentVersion }}
          {{ item.isMock ? '· 模拟内容' : '' }}</span
        >
        <h2>{{ item.title }}</h2>
        <span class="fine-print">{{
          new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        }}</span>
      </div>
      <span class="run-status">{{ contentStatusLabels[item.status] }}</span></router-link
    >
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
