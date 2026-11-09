<script setup lang="ts">
import { computed } from 'vue';
import { isTerminal, type CreationRun } from '@creator-ai/contracts';
import TeamActionCard from './TeamActionCard.vue';
import { isUserAction } from './teamPresentation';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ run: CreationRun; disabled: boolean }>();
const emit = defineEmits<{ resolved: [run: CreationRun]; refresh: [] }>();
const session = useSessionStore();
const actions = computed(() => props.run.execution?.collaboration ?? []);
const pending = computed(() =>
  props.run.status === 'waiting_user' && !props.run.cancelRequested
    ? actions.value.filter(isUserAction)
    : [],
);
const history = computed(() => actions.value.filter((action) => !pending.value.includes(action)));
</script>

<template>
  <section class="panel collaboration-panel" aria-labelledby="collaboration-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">A TEAM THAT THINKS WITH YOU</span>
        <h2 id="collaboration-title">动态团队协作</h2>
        <p>规划、委派与答复都保留在本次任务中，离开页面也不会丢失服务端记录。</p>
      </div>
    </div>
    <p v-if="pending.length" class="inline-note warning" role="status">
      团队正在等待你的答复 ·
      {{ pending.length }} 项。确认前请核对成员任务与前置交付；你也可以取消整个任务。
    </p>
    <p v-else class="inline-note" role="status">
      {{
        run.cancelRequested || isTerminal(run.status)
          ? '本次协作已停止，没有可提交的交互。历史记录仍保留。'
          : run.status === 'waiting_user'
            ? '当前快照没有可答复的待办，请刷新快照核对；实时状态仍在更新。'
            : '当前没有需要你答复的交互，团队将按任务状态继续推进。'
      }}
    </p>
    <div class="team-actions">
      <TeamActionCard
        v-for="action in pending"
        :key="`${session.info?.user.id}:${run.id}:${action.id}`"
        :run="run"
        :action="action"
        :disabled="disabled"
        @resolved="emit('resolved', $event)"
        @refresh="emit('refresh')"
      />
    </div>
    <details v-if="history.length" class="collaboration-history" open>
      <summary>持久协作记录 · {{ history.length }} 条</summary>
      <div class="team-actions">
        <TeamActionCard
          v-for="action in history"
          :key="action.id"
          :run="run"
          :action="action"
          :disabled="true"
          @refresh="emit('refresh')"
        />
      </div>
    </details>
  </section>
</template>
