<script setup lang="ts">
import { ref } from 'vue';
import type { Expert, ExpertInput, Skill } from '@creator-ai/contracts';

type Team = NonNullable<ExpertInput['team']>;
const team = defineModel<Team>({ required: true });
const props = defineProps<{ experts: Expert[]; skills: Skill[] }>();
const emit = defineEmits<{ skillsAdded: [keys: string[]] }>();
const sourceId = ref('');
function addMember() {
  const source = props.experts.find((expert) => expert.id === sourceId.value);
  let suffix = team.value.members.length + 1;
  while (team.value.members.some((member) => member.agentId === `member-${suffix}`)) suffix++;
  team.value.members.push({
    agentId: `member-${suffix}`,
    name: source?.name ?? '新成员',
    description: source?.description ?? '说明这个成员负责的独立任务',
    profession: source?.profession ?? '',
    instructions:
      source?.instructions ?? '独立完成分配的工作，向主理人汇报结果，不模拟其他成员发言。',
    skillKeys: [...(source?.skillKeys ?? [])],
    preloadSkillKeys: [...(source?.preloadSkillKeys ?? [])],
    maxTurns: source?.maxTurns ?? 50,
  });
  emit('skillsAdded', source?.skillKeys ?? []);
}
function removeMember(index: number) {
  const id = team.value.members[index]!.agentId;
  team.value.members.splice(index, 1);
  if (team.value.leadAgent === id) team.value.leadAgent = team.value.members[0]?.agentId ?? '';
  for (const phase of team.value.phases ?? [])
    phase.agents = phase.agents.filter((agent) => agent !== id);
}
function addPhase() {
  team.value.phases ??= [];
  team.value.phases.push({ name: `阶段 ${team.value.phases.length + 1}`, agents: [], task: '' });
}
</script>

<template>
  <div class="inline-note warning">
    成员独立保存角色指令。同阶段并行、阶段间串行；主理人只编排和汇总。此处为配置，不表示已经运行。
  </div>
  <el-form-item label="主理人"
    ><el-select v-model="team.leadAgent"
      ><el-option
        v-for="member in team.members"
        :key="member.agentId"
        :value="member.agentId"
        :label="`${member.name} / ${member.agentId}`" /></el-select
  ></el-form-item>
  <div class="catalog-actions">
    <el-select v-model="sourceId" placeholder="可选：复制已有单专家" clearable aria-label="成员来源"
      ><el-option
        v-for="expert in experts.filter((item) => item.expertType !== 'team')"
        :key="expert.id"
        :label="expert.name"
        :value="expert.id" /></el-select
    ><el-button :disabled="team.members.length >= 12" @click="addMember">添加成员</el-button>
  </div>
  <p class="fine-print">
    从专家复制的是当前角色指令与技能范围，不会随原专家更新；技能版本不随来源复制，统一继承本团队上方的版本策略。修改成员标识后，需要重新选择主理人和阶段成员。
  </p>
  <details
    v-for="(member, index) in team.members"
    :key="index"
    class="team-member"
    :open="index === 0"
  >
    <summary>
      {{ member.name }} · {{ member.agentId === team.leadAgent ? '主理人' : '成员' }}
    </summary>
    <div class="form-columns">
      <el-form-item :label="`成员 ${index + 1} 标识`"
        ><el-input v-model="member.agentId" :maxlength="80" /></el-form-item
      ><el-form-item :label="`成员 ${index + 1} 名称`"
        ><el-input v-model="member.name" :maxlength="80"
      /></el-form-item>
    </div>
    <el-form-item label="成员职责"
      ><el-input v-model="member.description" :maxlength="1000"
    /></el-form-item>
    <el-form-item label="成员职业"
      ><el-input v-model="member.profession" :maxlength="100"
    /></el-form-item>
    <el-form-item label="成员工作指令"
      ><el-input v-model="member.instructions" type="textarea" :rows="4" :maxlength="20000"
    /></el-form-item>
    <el-form-item label="成员可用技能"
      ><el-select
        v-model="member.skillKeys"
        multiple
        @change="emit('skillsAdded', member.skillKeys)"
        ><el-option
          v-for="skill in skills"
          :key="skill.key"
          :value="skill.key"
          :label="skill.name"
          :disabled="skill.enabled === false" /></el-select
    ></el-form-item>
    <el-form-item label="成员启动预加载"
      ><el-select v-model="member.preloadSkillKeys" multiple
        ><el-option
          v-for="key in member.skillKeys"
          :key="key"
          :value="key"
          :label="key" /></el-select
    ></el-form-item>
    <el-form-item label="成员最大轮次"
      ><el-input-number v-model="member.maxTurns" :min="1" :max="200"
    /></el-form-item>
    <el-button :disabled="team.members.length <= 2" @click="removeMember(index)"
      >移除此成员</el-button
    >
  </details>
  <h3>协作阶段</h3>
  <p class="muted">
    可先保存 SOP，再配置结构化阶段；导入的自然语言 SOP 不自动转成已确认的执行计划。
  </p>
  <div v-for="(phase, index) in team.phases" :key="index" class="team-member">
    <el-form-item :label="`阶段 ${index + 1} 名称`"
      ><el-input v-model="phase.name" :maxlength="100"
    /></el-form-item>
    <el-form-item label="本阶段并行成员"
      ><el-select v-model="phase.agents" multiple
        ><el-option
          v-for="member in team.members.filter((item) => item.agentId !== team.leadAgent)"
          :key="member.agentId"
          :label="member.name"
          :value="member.agentId" /></el-select
    ></el-form-item>
    <el-form-item label="阶段任务与交付要求"
      ><el-input v-model="phase.task" type="textarea" :rows="2" :maxlength="2000"
    /></el-form-item>
    <el-button @click="team.phases?.splice(index, 1)">移除阶段</el-button>
  </div>
  <el-button :disabled="(team.phases?.length ?? 0) >= 20" @click="addPhase">添加下一阶段</el-button>
</template>

<style scoped>
.team-member {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin: 12px 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 12px;
}
</style>
