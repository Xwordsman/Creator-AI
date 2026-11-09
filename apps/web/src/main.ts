import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { ElButton } from 'element-plus/es/components/button/index';
import { ElCheckbox, ElCheckboxGroup } from 'element-plus/es/components/checkbox/index';
import { ElConfigProvider } from 'element-plus/es/components/config-provider/index';
import { ElDialog } from 'element-plus/es/components/dialog/index';
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index';
import { ElInput } from 'element-plus/es/components/input/index';
import { ElInputNumber } from 'element-plus/es/components/input-number/index';
import { ElRadio, ElRadioButton, ElRadioGroup } from 'element-plus/es/components/radio/index';
import { ElOption, ElSelect } from 'element-plus/es/components/select/index';
import { ElPagination } from 'element-plus/es/components/pagination/index';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/checkbox-group/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/radio/style/css';
import 'element-plus/es/components/radio-button/style/css';
import 'element-plus/es/components/radio-group/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/message/style/css';
import './styles.css';
import App from './App.vue';
import { router } from './router';
import { setUnauthorizedHandler } from './api/client';
import { useSessionStore } from './stores/session';

const app = createApp({ render: () => h(ElConfigProvider, { locale: zhCn }, () => h(App)) });
const pinia = createPinia();
app.use(pinia);
setUnauthorizedHandler(() => {
  useSessionStore(pinia).clear();
  if (router.currentRoute.value.path !== '/login') {
    void router.replace({ path: '/login', query: { next: router.currentRoute.value.fullPath } });
  }
});
app.use(router);
for (const component of [
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElOption,
  ElPagination,
  ElSelect,
])
  app.use(component);
app.mount('#app');
