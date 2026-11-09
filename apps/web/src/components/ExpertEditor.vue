<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  expertInputSchema,
  type Expert,
  type ExpertInput,
  type Skill,
} from '@creator-ai/contracts';
import { errorMessage, post } from '../api/client';
import TeamEditor from './TeamEditor.vue';
import SkillBindings from './SkillBindings.vue';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{
  expert: Expert | null;
  copy: boolean;
  kind: 'agent' | 'team';
  experts: Expert[];
  skills: Skill[];
}>();
const emit = defineEmits<{ saved: [] }>();
const form = ref<ExpertInput>({ name: '', description: '', instructions: '', skillKeys: [] });
const prompts = ref('');
const tags = ref('');
const busy = ref(false);
const error = ref('');
function makeTeam() {
  const member = {
    name: '内容主编',
    description: '编排任务、汇总成员原始产出，保留待核实事项。',
    instructions: '只负责调度和汇总，不代写其他成员的专业产出。',
    skillKeys: [],
    preloadSkillKeys: [],
    maxTurns: 150,
  };
  return {
    leadAgent: 'content-editor',
    members: [
      { ...member, agentId: 'content-editor' },
      {
        ...member,
        agentId: 'content-writer',
        name: '内容主笔',
        description: '根据读者需求完成独立初稿。',
        instructions: '独立完成主理人分配的初稿任务，不编造事实。',
        maxTurns: 50,
      },
    ],
    phases: [],
  };
}
watch(open, (value) => {
  if (!value) return;
  error.value = '';
  if (props.expert) {
    const definition = Object.fromEntries(
      Object.entries(props.expert).filter(
        ([key]) => !['id', 'version', 'createdAt', 'enabled', 'hasSourcePackage'].includes(key),
      ),
    );
    form.value = JSON.parse(JSON.stringify(definition)) as ExpertInput;
    form.value.expertType ??= 'agent';
    if (props.copy) form.value.name = `${form.value.name.slice(0, 74)} 副本`;
  } else
    form.value = {
      name: props.kind === 'team' ? '内容编辑部' : '公众号主笔',
      expertType: props.kind,
      description: '把复杂的话题，写成有观点、好理解的文章。',
      instructions:
        '先梳理读者的问题，再组织文章结构。遵循账号人设，不编造数据、来源或亲身经历。无法确定的事实明确标注待核实。',
      skillKeys: props.kind === 'team' ? [] : ['article-outline', 'plain-writing', 'fact-check'],
      preloadSkillKeys: [],
      profession: '',
      maxTurns: 50,
      ...(props.kind === 'team' ? { team: makeTeam() } : {}),
    };
  prompts.value = (form.value.quickPrompts ?? []).join('\n');
  tags.value = (form.value.tags ?? []).join(', ');
});
function setKind(value: string | number | boolean | undefined) {
  if (value === 'team') form.value.team ??= makeTeam();
  else delete form.value.team;
}
function addSkills(keys: string[]) {
  form.value.skillKeys = [...new Set([...form.value.skillKeys, ...keys])];
}
watch(
  () => form.value.skillKeys,
  (keys) => {
    form.value.preloadSkillKeys = form.value.preloadSkillKeys?.filter((key) => keys.includes(key));
    if (form.value.skillVersions)
      form.value.skillVersions = Object.fromEntries(
        Object.entries(form.value.skillVersions).filter(([key]) => keys.includes(key)),
      );
  },
  { deep: true },
);
async function save() {
  if (busy.value) return;
  const parsed = expertInputSchema.safeParse({
    ...form.value,
    quickPrompts: prompts.value
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean),
    tags: tags.value
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean),
  });
  if (!parsed.success) {
    error.value = `配置不完整：${parsed.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .slice(0, 3)
      .join('；')}`;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const path =
      props.expert && !props.copy
        ? `/experts/${props.expert.id}/versions?baseVersion=${props.expert.version}`
        : '/experts';
    await post(path, parsed.data);
    open.value = false;
    emit('saved');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="expert && !copy ? `配置专家 · 当前 v${expert.version}` : '添加你的专家'"
    width="800px"
    :close-on-click-modal="false"
    :show-close="!busy"
    :close-on-press-escape="!busy"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="save">
      <el-form-item label="专家类型"
        ><el-radio-group v-model="form.expertType" @change="setKind"
          ><el-radio value="agent">单专家</el-radio
          ><el-radio value="team">专家团</el-radio></el-radio-group
        ></el-form-item
      >
      <div class="form-columns">
        <el-form-item label="专家名称"
          ><el-input v-model="form.name" :maxlength="80" /></el-form-item
        ><el-form-item label="职业 / 定位"
          ><el-input v-model="form.profession" :maxlength="100"
        /></el-form-item>
      </div>
      <el-form-item label="一句话简介"
        ><el-input v-model="form.description" :maxlength="1000"
      /></el-form-item>
      <el-form-item
        :label="form.expertType === 'team' ? '协作 SOP 与团队边界' : '工作指令与质量要求'"
        ><el-input v-model="form.instructions" type="textarea" :rows="5" :maxlength="20000"
      /></el-form-item>
      <el-form-item label="可用 Skills（可不选）"
        ><el-select v-model="form.skillKeys" multiple placeholder="零到多项技能"
          ><el-option
            v-for="skill in skills"
            :key="skill.key"
            :value="skill.key"
            :label="`${skill.name} · v${skill.version}`"
            :disabled="skill.enabled === false" /></el-select
      ></el-form-item>
      <el-form-item label="启动时预加载（需从可用技能中选择）"
        ><el-select v-model="form.preloadSkillKeys" multiple
          ><el-option
            v-for="key in form.skillKeys"
            :key="key"
            :label="skills.find((s) => s.key === key)?.name ?? key"
            :value="key" /></el-select
      ></el-form-item>
      <SkillBindings v-model="form.skillVersions" :keys="form.skillKeys" :skills="skills" />
      <TeamEditor
        v-if="form.team"
        v-model="form.team"
        :experts="experts"
        :skills="skills"
        @skills-added="addSkills"
      />
      <details class="expert-options">
        <summary>快速开始与高级配置</summary>
        <el-form-item label="推荐问法（每行一条，最多 6 条）"
          ><el-input v-model="prompts" type="textarea" :rows="3"
        /></el-form-item>
        <el-form-item label="默认引导语"
          ><el-input v-model="form.defaultInitPrompt" :maxlength="1000"
        /></el-form-item>
        <el-form-item label="标签（逗号分隔，最多 10 个）"
          ><el-input v-model="tags"
        /></el-form-item>
        <el-form-item label="最大轮次（模型运行时生效）"
          ><el-input-number v-model="form.maxTurns" :min="1" :max="200"
        /></el-form-item>
      </details>
      <p class="muted">
        专家可以有默认身份与口吻；具体账号的表达要求优先。保存会生成新版本，历史任务不变。专家团需要显式选择模型连接后执行，保存配置不会调用模型。
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <el-button :disabled="busy" @click="open = false">取消</el-button
        ><el-button type="primary" native-type="submit" :loading="busy">{{
          expert && !copy ? '保存为新版本' : '创建专家'
        }}</el-button>
      </div>
    </el-form>
  </el-dialog>
</template>

<style scoped>
.expert-options {
  margin: 24px 0;
}
summary {
  cursor: pointer;
  margin-bottom: 16px;
  font-weight: 600;
}
</style>
