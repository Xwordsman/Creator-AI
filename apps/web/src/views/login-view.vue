<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowUpRight, Feather } from '@lucide/vue';
import { useSessionStore } from '../stores/session';
import { errorMessage } from '../api/client';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const username = ref('');
const secret = ref('');
const busy = ref(false);
const error = ref('');
async function login() {
  error.value = '';
  busy.value = true;
  try {
    await session.login(username.value, secret.value);
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.push(
      next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/',
    );
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-layout">
    <section class="login-story">
      <div class="brand"><Feather :size="28" /> Creator.AI</div>
      <div>
        <span class="eyebrow">A HOME FOR YOUR IDEAS</span>
        <h1>你的表达，<br />值得持续发生。</h1>
        <p>账号、人设、专家与技能，在一个工作空间里。<br />不用再从「我是谁」开始每一次创作。</p>
      </div>
      <span class="fine-print">自己的服务器。自己的内容。自己的节奏。</span>
    </section>
    <section class="login-form">
      <span class="eyebrow">WELCOME BACK / 欢迎回来</span>
      <h2>打开你的编辑部</h2>
      <p class="muted">使用初始化时创建的管理员账号登录。</p>
      <el-form label-position="top" @submit.prevent="login">
        <el-form-item label="用户名"
          ><el-input
            v-model="username"
            name="username"
            autocomplete="username"
            size="large"
            :maxlength="80"
        /></el-form-item>
        <el-form-item label="密码"
          ><el-input
            v-model="secret"
            name="password"
            type="password"
            autocomplete="current-password"
            show-password
            size="large"
            :maxlength="256"
        /></el-form-item>
        <p v-if="error || session.connectionError" class="form-error" role="alert">
          {{ error || session.connectionError }}
        </p>
        <el-button
          type="primary"
          native-type="submit"
          size="large"
          class="full-width"
          :loading="busy"
          :disabled="!username.trim() || !secret"
          >进入工作空间 <ArrowUpRight :size="18"
        /></el-button>
      </el-form>
      <div class="setup-note">
        <strong>第一次部署？</strong>
        <p>在服务器终端运行管理员初始化命令。没有公开注册入口，也没有默认密码。</p>
        <code>node scripts/production.mjs install</code>
      </div>
    </section>
  </main>
</template>
