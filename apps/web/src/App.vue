<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import {
  BookOpen,
  Feather,
  LayoutDashboard,
  LogOut,
  NotebookPen,
  UsersRound,
  Library,
  FilePenLine,
  SlidersHorizontal,
} from '@lucide/vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ref, watch } from 'vue';
import { errorMessage } from './api/client';
import { useSessionStore } from './stores/session';
import { useRuntimeStore } from './stores/runtime';
import { version } from '../package.json';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const runtime = useRuntimeStore();
watch(
  () => session.info?.user.id,
  (id) => {
    if (id) void runtime.refresh();
    else runtime.clear();
  },
  { immediate: true },
);
const signingOut = ref(false);
const nav = [
  { to: '/', label: '创作工作台', icon: LayoutDashboard },
  { to: '/accounts', label: '账号档案', icon: BookOpen },
  { to: '/experts', label: '专家中心', icon: UsersRound },
  { to: '/skills', label: '技能库', icon: Library },
  { to: '/models', label: '模型设置', icon: SlidersHorizontal },
  { to: '/contents', label: '内容库', icon: FilePenLine },
  { to: '/runs', label: '创作记录', icon: NotebookPen },
];
async function logout() {
  signingOut.value = true;
  try {
    await session.logout();
    await router.push('/login');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    signingOut.value = false;
  }
}
</script>

<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <a href="#main-content" class="skip-link">跳到正文</a>
    <aside class="sidebar">
      <router-link to="/" class="brand"
        ><span class="brand-mark"><Feather :size="22" /></span
        ><span
          >Creator<span class="brand-ai">.AI</span><small>你的私人编辑部</small></span
        ></router-link
      >
      <p class="nav-label">WORKSPACE / 工作空间</p>
      <nav aria-label="主导航">
        <router-link
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :class="{ active: item.to === '/' ? route.path === '/' : route.path.startsWith(item.to) }"
        >
          <component :is="item.icon" :size="19" /><span>{{ item.label }}</span>
        </router-link>
      </nav>
      <div class="sidebar-note">
        <span class="eyebrow">LESS REPETITION.</span>
        <p>把背景留下，<br />把时间留给创作。</p>
        <span class="fine-print">自部署 · 数据由你掌握</span>
      </div>
      <div class="sidebar-user">
        <span class="avatar">{{ session.info?.user.username.slice(0, 1).toUpperCase() }}</span
        ><span>{{ session.info?.user.username }}<small>个人工作空间</small></span
        ><el-button text :disabled="signingOut" aria-label="退出登录" @click="logout"
          ><LogOut :size="18"
        /></el-button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <span>工作空间 <span class="slash">/</span> {{ route.meta.title }}</span
        ><span class="mode-badge"
          ><span class="status-dot"></span>
          {{
            !runtime.capabilities
              ? '模型状态暂不可用'
              : runtime.capabilities.canConfigureModels
                ? '模型已开放 · 按任务选择'
                : '模拟模式 · 不调用模型'
          }}</span
        >
      </header>
      <main id="main-content" class="main-content"><router-view /></main>
      <footer class="app-footer">
        <span>CREATOR-AI / v{{ version }}</span
        ><span>只生成候选草稿，不自动发布。</span>
      </footer>
    </div>
  </div>
</template>
