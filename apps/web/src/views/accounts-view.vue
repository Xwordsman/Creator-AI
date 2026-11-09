<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { BookOpen, Plus } from '@lucide/vue';
import {
  accountInputSchema,
  type Account,
  type AccountInput,
  type Expert,
} from '@creator-ai/contracts';
import { ElMessage } from 'element-plus/es/components/message/index';
import { errorMessage, listAll, post } from '../api/client';
import AccountWritingCards from '../components/AccountWritingCards.vue';

const accounts = ref<Account[]>([]);
const experts = ref<Expert[]>([]);
const newDefault = ref('');
const bindingAccount = ref<Account | null>(null);
const bindingId = ref('');
const bindingError = ref('');
const bindingNeedsReload = ref(false);
const dialog = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const formError = ref('');
const form = reactive<AccountInput>({ name: '', platform: 'wechat', audience: '', persona: '' });
const platformLabels = { wechat: '微信公众号', toutiao: '头条号', generic: '通用文字' };
async function load() {
  loading.value = true;
  error.value = '';
  try {
    [accounts.value, experts.value] = await Promise.all([
      listAll<Account>('/accounts'),
      listAll<Expert>('/experts'),
    ]);
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}
function openCreate() {
  Object.assign(form, { name: '', platform: 'wechat', audience: '', persona: '' });
  formError.value = '';
  newDefault.value = '';
  dialog.value = true;
}
async function save() {
  const parsed = accountInputSchema.safeParse(form);
  if (!parsed.success) {
    formError.value = '请完整填写账号名称、目标读者和作者人设。';
    return;
  }
  busy.value = true;
  formError.value = '';
  try {
    await post<Account>('/accounts', { ...parsed.data, defaultExpertId: newDefault.value || null });
    dialog.value = false;
    ElMessage.success('账号档案已保存');
    await load();
  } catch (reason) {
    formError.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
function openBinding(account: Account) {
  bindingAccount.value = account;
  bindingId.value = account.defaultExpertId ?? '';
  bindingError.value = '';
  bindingNeedsReload.value = false;
}
async function reloadBinding() {
  const id = bindingAccount.value?.id;
  if (busy.value || !id) return;
  busy.value = true;
  try {
    const rows = await listAll<Account>('/accounts');
    accounts.value = rows;
    const current = rows.find((row) => row.id === id);
    if (!current) throw new Error('账号已不可用，请关闭后刷新列表。');
    openBinding(current);
  } catch (reason) {
    bindingError.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function saveBinding() {
  if (busy.value || !bindingAccount.value || bindingNeedsReload.value) return;
  busy.value = true;
  bindingError.value = '';
  try {
    const updated = await post<Account>(`/accounts/${bindingAccount.value.id}/default-expert`, {
      expertId: bindingId.value || null,
      baseRevision: bindingAccount.value.revision,
    });
    accounts.value = accounts.value.map((item) => (item.id === updated.id ? updated : item));
    bindingAccount.value = null;
    ElMessage.success('默认专家已更新，仅影响新创作');
  } catch (reason) {
    bindingError.value = `${errorMessage(reason)} 请先读取服务器配置，再确认是否需要修改。`;
    bindingNeedsReload.value = true;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow">VOICE & AUDIENCE</span>
      <h1>每个账号，都有自己的声音。</h1>
      <p>把定位与人设留下，不必每次重新交代。</p>
    </div>
    <el-button type="primary" size="large" @click="openCreate"
      ><Plus :size="18" /> 新建账号</el-button
    >
  </section>
  <div class="inline-note">
    <BookOpen :size="18" /><span
      >这里保存的是创作档案，不需要提供公众号密码或平台 Cookie，也不会登录平台。</span
    >
  </div>
  <p v-if="error" role="alert" class="form-error">
    {{ error }} <el-button text @click="load">重试</el-button>
  </p>
  <div v-if="loading" class="panel muted">正在读取账号…</div>
  <div v-else-if="!accounts.length" class="empty-state panel">
    <BookOpen :size="36" />
    <h2>让第一篇内容有一个归属</h2>
    <p>创建账号，告诉专家你面向谁、用什么方式表达。</p>
    <el-button @click="openCreate">创建第一个账号</el-button>
  </div>
  <div v-else class="card-grid">
    <article v-for="account in accounts" :key="account.id" class="panel profile-card">
      <div class="card-top">
        <span class="avatar large">{{ account.name.slice(0, 1) }}</span
        ><span class="small-tag">{{ platformLabels[account.platform] }}</span>
      </div>
      <h2>{{ account.name }}</h2>
      <span class="field-caption">目标读者</span>
      <p>{{ account.audience }}</p>
      <span class="field-caption">作者人设</span>
      <p class="preserve-lines">{{ account.persona }}</p>
      <span class="field-caption">默认专家</span>
      <p>
        {{
          experts.find((expert) => expert.id === account.defaultExpertId)?.name ??
          (account.defaultExpertId ? '默认专家不可用' : '未设置 · 创作时选择')
        }}{{
          experts.find((expert) => expert.id === account.defaultExpertId)?.enabled === false
            ? '（已停用）'
            : ''
        }}
      </p>
      <div class="catalog-actions">
        <AccountWritingCards
          :account="account"
          @saved="
            (updated) => {
              accounts = accounts.map((a) => (a.id === updated.id ? updated : a));
            }
          "
        />
        <el-button text @click="openBinding(account)">设置默认专家</el-button>
        <router-link :to="{ path: '/', query: { accountId: account.id } }"
          >为这个账号创作</router-link
        >
      </div>
    </article>
  </div>
  <el-dialog
    v-model="dialog"
    title="新建账号档案"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="save">
      <el-form-item label="账号名称"
        ><el-input v-model="form.name" :maxlength="80" placeholder="例如：我的 AI 观察手记"
      /></el-form-item>
      <el-form-item label="平台类型"
        ><el-select v-model="form.platform"
          ><el-option
            v-for="(label, value) in platformLabels"
            :key="value"
            :label="label"
            :value="value" /></el-select
      ></el-form-item>
      <el-form-item label="目标读者"
        ><el-input
          v-model="form.audience"
          type="textarea"
          :rows="2"
          :maxlength="500"
          placeholder="谁会读你的内容？他们关心什么？"
      /></el-form-item>
      <el-form-item label="作者人设与表达习惯"
        ><el-input
          v-model="form.persona"
          type="textarea"
          :rows="4"
          :maxlength="3000"
          placeholder="你的身份视角、语气、习惯，以及明确不做的事。"
      /></el-form-item>
      <el-form-item label="默认专家（可选）">
        <el-select v-model="newDefault" :empty-values="[null, undefined]">
          <el-option label="不设置 · 创作时选择" value="" />
          <el-option
            v-for="expert in experts"
            :key="expert.id"
            :label="`${expert.name}${expert.expertType === 'team' ? '（专家团 · 需模型）' : ''}`"
            :value="expert.id"
            :disabled="expert.enabled === false"
          />
        </el-select>
      </el-form-item>
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <div class="dialog-actions">
        <el-button :disabled="busy" @click="dialog = false">取消</el-button
        ><el-button type="primary" native-type="submit" :loading="busy">保存账号</el-button>
      </div>
    </el-form>
  </el-dialog>
  <el-dialog
    :model-value="!!bindingAccount"
    title="账号默认专家"
    width="560px"
    :show-close="!busy"
    :close-on-press-escape="!busy"
    :close-on-click-modal="false"
    @update:model-value="
      (value: boolean) => {
        if (!value && !busy) bindingAccount = null;
      }
    "
  >
    <el-form
      label-position="top"
      :disabled="busy || bindingNeedsReload"
      @submit.prevent="saveBinding"
    >
      <p>{{ bindingAccount?.name }} · 配置 r{{ bindingAccount?.revision }}</p>
      <el-form-item label="默认专家 / 专家团">
        <el-select v-model="bindingId" :empty-values="[null, undefined]">
          <el-option label="清除默认 · 创作时选择" value="" />
          <el-option
            v-for="expert in experts"
            :key="expert.id"
            :label="`${expert.name}${expert.enabled === false ? '（已停用）' : expert.expertType === 'team' ? '（专家团 · 需模型）' : ''}`"
            :value="expert.id"
            :disabled="expert.enabled === false"
          />
        </el-select>
      </el-form-item>
      <p class="fine-print">
        工作台会沿用此选择，也可以临时换专家。默认绑定跟随专家当前版本，不固定专家历史；不改变已有任务，不自动选择模型或产生费用。
      </p>
      <p v-if="bindingError" role="alert" class="form-error">{{ bindingError }}</p>
      <div class="dialog-actions">
        <el-button :disabled="busy" @click="bindingAccount = null">关闭</el-button>
        <el-button v-if="!bindingNeedsReload" type="primary" native-type="submit" :loading="busy"
          >保存默认专家</el-button
        >
      </div>
    </el-form>
    <el-button v-if="bindingNeedsReload" :loading="busy" @click="reloadBinding"
      >读取服务器配置</el-button
    >
  </el-dialog>
</template>
