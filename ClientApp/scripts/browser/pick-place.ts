import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import Harness from './PickPlaceHarness.vue';
createApp(Harness).use(ElementPlus).mount('#app');
