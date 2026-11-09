<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  saveWritingCardsSchema,
  writingCardKindLabels,
  writingCardsSchema,
  type Account,
  type WritingCard,
} from '@creator-ai/contracts';
import { errorMessage, post, request } from '../api/client';
import WritingCardsPreview from './WritingCardsPreview.vue';

const props = defineProps<{ account: Account }>();
const emit = defineEmits<{ saved: [account: Account] }>();
const open = ref(false),
  busy = ref(false),
  error = ref(''),
  needsRead = ref(false);
const cards = ref<WritingCard[]>([]),
  baseRevision = ref(0),
  serverAccount = ref<Account | null>(null);
const characters = computed(() => cards.value.reduce((sum, c) => sum + c.content.length, 0));
function begin() {
  cards.value = (props.account.writingCards ?? []).map((c) => ({ ...c }));
  baseRevision.value = props.account.revision;
  error.value = '';
  needsRead.value = false;
  serverAccount.value = null;
  open.value = true;
}
function add() {
  cards.value.push({
    id: crypto.randomUUID(),
    kind: 'writing',
    title: '',
    content: '',
    enabled: true,
  });
}
async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || busy.value || needsRead.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (files.length + cards.value.length > 8)
      throw new Error('每个账号最多 8 份资料，请减少文件后重试。');
    const imported = await Promise.all(
      files.map(async (file): Promise<WritingCard> => {
        if (!/\.(md|txt)$/i.test(file.name) || file.size > 65536)
          throw new Error('只支持 UTF-8 的 .md / .txt 文件，单文件最多 64 KiB。');
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          throw new Error('文件无法按 UTF-8 读取，请转换编码后再导入。');
        }
        const title = file.name.replace(/\.(md|txt)$/i, '');
        return {
          id: crypto.randomUUID(),
          title,
          content,
          enabled: true,
          kind: /范文|样文|sample/i.test(title)
            ? 'sample'
            : /人物|人设|persona/i.test(title)
              ? 'persona'
              : 'writing',
        };
      }),
    );
    const parsed = writingCardsSchema.safeParse([...cards.value, ...imported]);
    if (!parsed.success)
      throw new Error(
        '导入未完成：每份正文 1–8,000 字符、标题 1–80 字符，全部正文合计最多 24,000 字符；请检查空文件或控制字符。',
      );
    cards.value = parsed.data;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value || needsRead.value) return;
  const parsed = saveWritingCardsSchema.safeParse({
    baseRevision: baseRevision.value,
    writingCards: cards.value,
  });
  if (!parsed.success) {
    error.value =
      '请检查资料：标题 1–80 字符，每份正文 1–8,000 字符，合计最多 24,000 字符，不能包含控制字符。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const account = await post<Account>(`/accounts/${props.account.id}/writing-cards`, parsed.data);
    emit('saved', account);
    open.value = false;
  } catch (reason) {
    needsRead.value = true;
    error.value = `${errorMessage(reason)} 本地资料仍保留。请先读取服务器资料核对保存结果。`;
  } finally {
    busy.value = false;
  }
}
async function readServer() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    serverAccount.value = await request<Account>(`/accounts/${props.account.id}`);
    emit('saved', serverAccount.value);
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
function useServer() {
  if (!serverAccount.value) return;
  cards.value = (serverAccount.value.writingCards ?? []).map((c) => ({ ...c }));
  baseRevision.value = serverAccount.value.revision;
  needsRead.value = false;
  serverAccount.value = null;
  error.value = '';
}
function keepLocal() {
  if (!serverAccount.value) return;
  baseRevision.value = serverAccount.value.revision;
  needsRead.value = false;
  serverAccount.value = null;
  error.value = '已保留本地内容，请核对后再次保存。';
}
</script>

<template>
  <el-button text @click="begin"
    >写作资料 · {{ account.writingCards?.filter((c) => c.enabled).length ?? 0 }}</el-button
  >
  <el-dialog
    v-model="open"
    title="账号写作资料"
    width="760px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <p>{{ account.name }} · 配置 r{{ baseRevision }}</p>
    <p class="fine-print">
      人物卡保存作者视角，写作卡约定写法，范文参考节奏和语气。导入后可编辑，点击保存才写入账号。资料会发送给创作时选择的模型。
    </p>
    <div class="card-tools">
      <label class="import-label"
        >导入 Markdown / TXT<input
          aria-label="导入写作资料文件"
          type="file"
          multiple
          accept=".md,.txt"
          :disabled="busy || needsRead"
          @change="importFiles"
      /></label>
      <el-button :disabled="busy || needsRead || cards.length >= 8" @click="add"
        >手动添加资料</el-button
      >
    </div>
    <p class="fine-print">
      {{ cards.length }}/8 份 · 正文 {{ characters.toLocaleString() }}/24,000 字符；单份最多 8,000
      字符。文件使用 UTF-8，单文件最多 64 KiB。
    </p>
    <fieldset
      v-for="(card, index) in cards"
      :key="card.id"
      :disabled="busy || needsRead"
      class="writing-card"
    >
      <legend>第 {{ index + 1 }} 份资料</legend>
      <label
        >资料名称<input
          v-model="card.title"
          :aria-label="`第 ${index + 1} 份资料名称`"
          maxlength="80"
      /></label>
      <label
        >资料类型<select v-model="card.kind" :aria-label="`第 ${index + 1} 份资料类型`">
          <option v-for="(label, kind) in writingCardKindLabels" :key="kind" :value="kind">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >正文<textarea
          v-model="card.content"
          :aria-label="`第 ${index + 1} 份资料正文`"
          rows="5"
          maxlength="8000"
        />
      </label>
      <div class="card-tools">
        <label><input v-model="card.enabled" type="checkbox" /> 创作时使用</label
        ><el-button text :disabled="busy || needsRead" @click="cards.splice(index, 1)"
          >移除资料 {{ index + 1 }}</el-button
        >
      </div>
    </fieldset>
    <p v-if="!cards.length" class="fine-print">
      可以直接导入你们已有的人物卡和写作卡，无须改成技能包。
    </p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <section v-if="serverAccount" class="notice-banner" aria-label="服务器写作资料">
      <strong>服务器配置 r{{ serverAccount.revision }} · 请与上方本地内容核对</strong>
      <WritingCardsPreview :cards="serverAccount.writingCards ?? []" />
      <div class="card-tools">
        <el-button @click="useServer">采用服务器资料</el-button
        ><el-button @click="keepLocal">保留本地内容，重新确认</el-button>
      </div>
    </section>
    <p class="fine-print">
      保存影响新创作。已有文章可在 AI
      协作中选择本轮使用账号最新资料；历史任务保持原快照。关闭窗口会放弃尚未保存的本地编辑。
    </p>
    <div class="dialog-actions">
      <el-button :disabled="busy" @click="open = false">关闭</el-button
      ><el-button v-if="needsRead" :loading="busy" @click="readServer">读取服务器资料</el-button
      ><el-button v-else type="primary" :loading="busy" @click="save">保存写作资料</el-button>
    </div>
  </el-dialog>
</template>

<style scoped>
.card-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.writing-card {
  margin-block: 18px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  min-width: 0;
}
.writing-card > label {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
}
.writing-card label > input:not([type='checkbox']),
.writing-card select,
.writing-card textarea {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  line-height: 1.7;
  min-height: 44px;
}
.writing-card textarea {
  resize: vertical;
}
.writing-card :is(input, select, textarea):focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}
.writing-card input[type='checkbox'] {
  accent-color: var(--green);
}
.writing-card:disabled {
  opacity: 0.65;
}
.import-label {
  font-size: 13px;
}
.import-label input {
  display: block;
  max-width: 100%;
  margin-top: 8px;
}
.card-tools input[type='checkbox'] {
  width: auto;
}
</style>
