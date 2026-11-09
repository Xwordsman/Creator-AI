<script setup lang="ts">
import { computed } from 'vue';
import type { CreationRun } from '@creator-ai/contracts';
import { agentRoleLabels, executionSource, messageKindLabels } from './teamPresentation';
const props = defineProps<{ run: CreationRun }>();
const dynamic = computed(() => props.run.snapshot.workflow === 'team-dynamic-v1');
const labels: Record<string, string> = {
  pending: '等待前置交付',
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
  unknown: '结果待核对',
  reserved: '已预留、未发送',
  in_flight: '请求已发送',
  rejected: '已拒绝或未发送',
};
</script>

<template>
  <section v-if="run.execution" class="panel execution-panel">
    <div class="section-heading">
      <div>
        <span class="eyebrow">THE WORK, NOT JUST THE ANSWER</span>
        <h2>{{ run.snapshot.expert.team ? '编辑部协作过程' : '专家执行过程' }}</h2>
        <p>独立上下文、实际技能加载与持久化调用账本。</p>
      </div>
    </div>
    <div class="execution-metrics">
      <span
        ><b>{{ run.execution.usage.calls }}</b> 次调用预留 /
        {{ run.snapshot.limits?.maxCalls }}</span
      >
      <span
        ><b>{{ run.execution.usage.chargedTokens.toLocaleString() }}</b> 已记账 Token</span
      >
      <span
        ><b>{{ run.execution.usage.reservedTokens.toLocaleString() }}</b> 待结算预留</span
      >
    </div>
    <p class="fine-print">
      服务商已报告输入 {{ run.execution.usage.reportedInputTokens.toLocaleString() }} / 输出
      {{ run.execution.usage.reportedOutputTokens.toLocaleString() }} Token。{{
        run.execution.usage.hasEstimatedUsage
          ? '包含估算或结果未知的调用，请核对服务商账单。'
          : 'Token 不代表货币金额，账单以服务商为准。'
      }}
    </p>
    <p v-if="!run.execution.agents.length" class="muted">等待 Worker 领取任务并创建成员计划…</p>
    <div class="agent-executions">
      <article v-for="agent in run.execution.agents" :key="agent.id" class="agent-execution">
        <div class="agent-heading">
          <div>
            <span class="eyebrow"
              >{{ agentRoleLabels[agent.role] }} ·
              {{ dynamic ? `协作第 ${agent.phase + 1} 轮` : `阶段 ${agent.phase + 1}` }}</span
            >
            <h3>{{ agent.name }}</h3>
          </div>
          <span class="run-status" :class="agent.status">{{ labels[agent.status] }}</span>
        </div>
        <p class="fine-print">
          成员：{{ agent.agentId }} · 执行标识：<code class="run-id">{{ agent.id }}</code>
        </p>
        <p>{{ agent.task }}</p>
        <p v-if="agent.dependencies.length" class="fine-print">
          前置交付：{{ agent.dependencies.map((id) => executionSource(run, id)).join('、') }}
        </p>
        <p class="fine-print">
          实际加载技能：{{
            agent.loadedSkillKeys.length
              ? agent.loadedSkillKeys.join('、')
              : '尚未加载（与绑定技能不同）'
          }}
        </p>
        <p v-if="agent.failureCode" class="form-error">{{ agent.failureCode }}</p>
        <details v-if="agent.result">
          <summary>查看成员交付</summary>
          <pre class="execution-text">{{ agent.result }}</pre>
        </details>
        <details v-if="run.execution.tools.some((tool) => tool.agentRunId === agent.id)">
          <summary>技能加载与只读工具记录</summary>
          <div
            v-for="tool in run.execution.tools.filter((item) => item.agentRunId === agent.id)"
            :key="tool.id"
            class="tool-execution"
          >
            <strong
              >{{ tool.name }} · {{ tool.status === 'succeeded' ? '已执行' : '已拒绝' }}</strong
            >
            <pre class="execution-text">{{ JSON.stringify(tool.input, null, 2) }}</pre>
            <details>
              <summary>工具返回内容（不可信资料）</summary>
              <pre class="execution-text">{{ tool.result }}</pre>
            </details>
          </div>
        </details>
        <details v-if="run.execution.invocations.some((call) => call.agentRunId === agent.id)">
          <summary>模型调用账本</summary>
          <div
            v-for="call in run.execution.invocations.filter((item) => item.agentRunId === agent.id)"
            :key="call.id"
            class="tool-execution"
          >
            <strong>第 {{ call.turn }} 轮 · {{ labels[call.status] }}</strong>
            <p class="fine-print">
              预留 {{ call.reservedTokens }} / 报告输入 {{ call.inputTokens ?? '未报告' }} / 输出
              {{ call.outputTokens ?? '未报告' }} Token
            </p>
            <code class="run-id">{{ call.id }}</code>
            <p v-if="call.providerRequestId" class="fine-print endpoint-text">
              服务商请求标识：{{ call.providerRequestId }}
            </p>
            <p v-if="call.failureCode" class="form-error">{{ call.failureCode }}</p>
          </div>
        </details>
      </article>
    </div>
    <details v-if="run.execution.messages.length" class="team-messages">
      <summary>团队交接记录 · {{ run.execution.messages.length }} 条</summary>
      <article v-for="message in run.execution.messages" :key="message.id" class="tool-execution">
        <strong
          >{{ executionSource(run, message.from) }} → {{ executionSource(run, message.to) }} ·
          {{ messageKindLabels[message.kind] }}</strong
        >
        <p class="fine-print">
          {{ message.from }} → {{ message.to }} ·
          {{ new Date(message.createdAt).toLocaleString('zh-CN') }}
        </p>
        <pre class="execution-text">{{ message.content }}</pre>
      </article>
    </details>
    <section v-if="run.execution.reconciliations?.length" class="team-messages">
      <h3>人工核对记录</h3>
      <article v-for="item in run.execution.reconciliations" :key="item.id" class="tool-execution">
        <pre class="execution-text">{{ item.note }}</pre>
        <span class="fine-print">{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span>
      </article>
    </section>
  </section>
</template>
