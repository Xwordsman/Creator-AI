<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { KeyRound, Plus } from '@lucide/vue';
import type { ModelConnection, ModelConnectionInput } from '@creator-ai/contracts';
import { modelConnectionInputSchema } from '@creator-ai/contracts';
import { errorMessage, post, request } from '../api/client';
import { useRuntimeStore } from '../stores/runtime';
import ModelCheckDialog from '../components/ModelCheckDialog.vue';

const runtime = useRuntimeStore();
const canCall = computed(() => runtime.capabilities?.canConfigureModels === true);
const connections = ref<ModelConnection[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const editing = ref(false);
const checking = ref<ModelConnection | null>(null);
const form = ref<ModelConnectionInput>({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  tokenParameter: 'max_completion_tokens',
  maxInputTokens: 16000,
  maxOutputTokens: 4096,
});
async function load() {
  loading.value = true;
  error.value = '';
  await runtime.refresh();
  try {
    connections.value = await request<ModelConnection[]>('/models');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
async function save() {
  error.value = '';
  const parsed = modelConnectionInputSchema.safeParse(form.value);
  if (!parsed.success) {
    error.value = '请填写有效的名称、完整接口地址、模型标识、API Key 和额度。';
    return;
  }
  busy.value = true;
  try {
    await post<ModelConnection>('/models', parsed.data);
    editing.value = false;
    form.value.name = '';
    form.value.baseUrl = '';
    form.value.model = '';
    await load();
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
    form.value.apiKey = '';
  }
}
async function toggle(connection: ModelConnection) {
  busy.value = true;
  error.value = '';
  try {
    await post(`/models/${connection.id}/availability`, { enabled: !connection.enabled });
    await load();
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
function close() {
  editing.value = false;
  form.value.apiKey = '';
}
onMounted(load);
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">THE ENGINE ROOM</span>
      <h1>给编辑部，接上引擎。</h1>
      <p>保存模型连接，每次创作再决定是否调用。模拟模式始终保留。</p>
    </div>
    <el-button
      type="primary"
      :disabled="loading || !runtime.capabilities?.canConfigureModels"
      @click="editing = true"
      ><Plus :size="17" /> 添加模型连接</el-button
    >
  </section>
  <p v-if="error || runtime.error" class="form-error" role="alert">
    {{ error || runtime.error }} <el-button text @click="load">重新加载</el-button>
  </p>
  <section v-if="!runtime.capabilities?.canConfigureModels" class="panel boundary-note">
    <KeyRound :size="24" />
    <h2>服务器当前仅开放模拟模式</h2>
    <p>
      先由部署者设置 MODEL_MODE=configured、持久化的 MODEL_ENCRYPTION_KEY 和 MODEL_ALLOWED_HOSTS
      出站白名单，再添加连接。没有保存 API Key，也不会自动发起测试调用。
    </p>
  </section>
  <div v-else class="inline-note warning">
    调用会将本次主题、账号人设、专家指令、已加载技能与阶段交付发送至所选服务商，并可能产生费用。只读技能不授予脚本、联网或
    MCP 权限。
  </div>
  <p v-if="runtime.capabilities?.allowedHosts.length" class="fine-print">
    允许的接口主机：{{ runtime.capabilities.allowedHosts.join('、') }}
  </p>
  <section v-if="loading" class="panel muted">正在读取模型连接…</section>
  <div v-else class="catalog-grid">
    <article v-for="connection in connections" :key="connection.id" class="panel catalog-card">
      <span class="small-tag">{{ connection.enabled ? '已启用' : '已停用' }} · 密钥已加密保存</span>
      <h2>{{ connection.name }}</h2>
      <strong>{{ connection.model }}</strong>
      <p class="endpoint-text">{{ connection.baseUrl }}</p>
      <p class="fine-print">
        输入保守预留上限 {{ connection.maxInputTokens.toLocaleString() }} / 单次最大输出
        {{ connection.maxOutputTokens.toLocaleString() }} Token
      </p>
      <el-button :disabled="busy" @click="toggle(connection)">{{
        connection.enabled ? '停用连接' : '启用连接'
      }}</el-button>
      <el-button :disabled="busy" @click="checking = connection">检查连接 / 记录</el-button>
    </article>
    <section
      v-if="!connections.length && runtime.capabilities?.canConfigureModels"
      class="panel muted"
    >
      还没有模型连接。添加连接只保存配置，不会自动调用模型。
    </section>
  </div>
  <el-dialog
    :model-value="editing"
    title="添加模型连接"
    width="640px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @close="close"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="save">
      <el-form-item label="连接名称"
        ><el-input v-model="form.name" :maxlength="80" placeholder="例如：创作主模型"
      /></el-form-item>
      <el-form-item label="API 基础地址"
        ><el-input
          v-model="form.baseUrl"
          :maxlength="500"
          placeholder="https://白名单主机/v1"
        /><span class="fine-print"
          >服务端追加 /chat/completions。只支持非流式、兼容 Chat Completions 的接口。</span
        ></el-form-item
      >
      <el-form-item label="模型标识"
        ><el-input v-model="form.model" :maxlength="120" placeholder="填写服务商提供的 model 标识"
      /></el-form-item>
      <el-form-item label="API Key"
        ><el-input
          v-model="form.apiKey"
          :type="'pass' + 'word'"
          autocomplete="off"
          :maxlength="4096"
        /><span class="fine-print"
          >密钥不会返回浏览器；保存或关闭后清空输入。没有自动连通性测试。</span
        ></el-form-item
      >
      <el-form-item label="输出额度参数"
        ><el-select v-model="form.tokenParameter"
          ><el-option
            label="max_completion_tokens（新接口）"
            value="max_completion_tokens" /><el-option
            label="max_tokens（部分兼容接口）"
            value="max_tokens" /></el-select
      ></el-form-item>
      <div class="form-columns">
        <el-form-item label="输入保守预留上限"
          ><el-input-number v-model="form.maxInputTokens" :min="1000" :max="64000" :step="1000"
        /></el-form-item>
        <el-form-item label="单次最大输出 Token"
          ><el-input-number v-model="form.maxOutputTokens" :min="256" :max="16000" :step="256"
        /></el-form-item>
      </div>
      <p class="fine-print">
        输入按 UTF-8
        字节与封装余量预留，不是精确分词，也不是服务商的上下文窗口。真实兼容性和账单以服务商为准。
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <el-button :disabled="busy" @click="close">取消</el-button
        ><el-button type="primary" native-type="submit" :loading="busy"
          >保存连接（不调用模型）</el-button
        >
      </div>
    </el-form>
  </el-dialog>
  <ModelCheckDialog
    v-if="checking"
    :key="checking.id"
    :connection="checking"
    :can-call="canCall"
    @close="checking = null"
  />
</template>
