<script setup lang="ts">
import { computed } from 'vue';
import { isTerminal, type CreationRun, type TeamAction } from '@creator-ai/contracts';
import TeamActionResponse from './TeamActionResponse.vue';
import {
  directiveLabels,
  executionSource,
  isUserAction,
  participantName,
} from './teamPresentation';

const props = defineProps<{ run: CreationRun; action: TeamAction; disabled: boolean }>();
const emit = defineEmits<{ resolved: [run: CreationRun]; refresh: [] }>();
const canRespond = computed(
  () =>
    props.run.status === 'waiting_user' && !props.run.cancelRequested && isUserAction(props.action),
);
const stateLabel = computed(() => {
  if (props.action.response)
    return props.action.response.approved === undefined
      ? '已答复'
      : props.action.response.approved
        ? '已同意'
        : '已拒绝';
  if (isTerminal(props.run.status) || props.run.cancelRequested)
    return props.action.state === 'applied' ? '已记录' : '已停止 · 不再等待';
  return { waiting: '等待你的答复', applied: '已记录', peer_wait: '等待成员答复' }[
    props.action.state
  ];
});
const text = computed(() => {
  const directive = props.action.directive;
  if ('summary' in directive) return directive.summary;
  if ('question' in directive) return directive.question;
  return directive.content;
});
</script>

<template>
  <article
    class="team-action"
    :class="{ 'team-action--pending': canRespond }"
    :aria-label="`${directiveLabels[action.directive.action]} · ${stateLabel}`"
    :data-action-id="action.id"
  >
    <div class="agent-heading">
      <div>
        <span class="eyebrow">{{ executionSource(run, action.sourceAgentRunId) }}</span>
        <h3>{{ directiveLabels[action.directive.action] }}</h3>
      </div>
      <span class="run-status" :class="{ waiting_user: canRespond }">{{ stateLabel }}</span>
    </div>
    <p class="team-action__text">{{ text }}</p>
    <p v-if="action.directive.action === 'request_peer'" class="fine-print">
      请教对象：{{ participantName(run, action.directive.memberId) }} ·
      {{ action.directive.memberId }}
    </p>
    <ol v-if="action.directive.action === 'delegate'" class="team-action__tasks">
      <li v-for="(task, index) in action.directive.tasks" :key="index">
        <strong
          >{{ participantName(run, task.memberId) }}
          <span class="fine-print">· {{ task.memberId }}</span></strong
        >
        <p>{{ task.task }}</p>
        <div class="fine-print">
          前置交付：<span v-if="!task.dependencies.length">无，可独立开始</span
          ><span
            v-for="dependency in task.dependencies"
            :key="dependency"
            class="team-action__dependency"
            >{{ executionSource(run, dependency) }} <code>{{ dependency }}</code></span
          >
        </div>
      </li>
    </ol>
    <div v-if="action.response" class="team-action__answer">
      <strong
        >你的答复{{
          action.response.approved === undefined
            ? ''
            : action.response.approved
              ? ' · 同意'
              : ' · 拒绝'
        }}</strong
      >
      <p>{{ action.response.answer }}</p>
    </div>
    <TeamActionResponse
      v-if="canRespond"
      :run-id="run.id"
      :action="action"
      :disabled="disabled"
      @resolved="emit('resolved', $event)"
      @refresh="emit('refresh')"
    />
    <div v-if="action.spawnedAgentIds.length" class="fine-print">
      后续执行：<span v-for="id in action.spawnedAgentIds" :key="id" class="team-action__dependency"
        >{{ executionSource(run, id) }} <code>{{ id }}</code></span
      >
    </div>
    <details class="team-action__trace">
      <summary>来源与记录时间</summary>
      <p class="fine-print">
        交互标识：<code>{{ action.id }}</code
        ><br />来源执行：<code>{{ action.sourceAgentRunId }}</code
        ><br /><time :datetime="action.createdAt">{{
          new Date(action.createdAt).toLocaleString('zh-CN')
        }}</time>
      </p>
    </details>
  </article>
</template>
