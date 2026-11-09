import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from './stores/session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/login-view.vue') },
    {
      path: '/',
      component: () => import('./views/workbench-view.vue'),
      meta: { title: '创作工作台' },
    },
    {
      path: '/accounts',
      component: () => import('./views/accounts-view.vue'),
      meta: { title: '账号档案' },
    },
    {
      path: '/experts',
      component: () => import('./views/experts-view.vue'),
      meta: { title: '专家中心' },
    },
    {
      path: '/skills',
      component: () => import('./views/skills-view.vue'),
      meta: { title: '技能库' },
    },
    {
      path: '/models',
      component: () => import('./views/models-view.vue'),
      meta: { title: '模型设置' },
    },
    {
      path: '/runs',
      component: () => import('./views/runs-view.vue'),
      meta: { title: '创作记录' },
    },
    {
      path: '/runs/:id',
      component: () => import('./views/run-detail-view.vue'),
      meta: { title: '任务详情' },
    },
    {
      path: '/contents',
      component: () => import('./views/contents-view.vue'),
      meta: { title: '内容库' },
    },
    {
      path: '/contents/:id',
      component: () => import('./views/content-detail-view.vue'),
      meta: { title: '内容编辑台' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
router.beforeEach(async (to) => {
  if (to.path === '/login') return;
  const session = useSessionStore();
  if (!session.info && !(await session.refresh()))
    return { path: '/login', query: { next: to.fullPath } };
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '登录')} · Creator-AI`;
});
