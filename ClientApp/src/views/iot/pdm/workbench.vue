<template>
  <ConsolePageShell eyebrow="PREDICTIVE MAINTENANCE" title="设备健康监测"
    description="按设备查看健康指数、遥测数据质量与趋势。规则健康指数不代表故障概率或剩余寿命。"
    :badges="[status?.configured ? '只读试运行' : '尚未启用']" :metrics="metrics">
    <template #actions><el-button :loading="busy" @click="reload">刷新数据</el-button></template>
    <el-alert v-if="status && !status.configured" title="预测性维护尚未通过上线门禁"
      :description="status.message" type="warning" :closable="false" show-icon class="pdm-alert" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="pdm-alert" />
    <section class="pdm-panel">
      <div class="pdm-heading"><h3>设备健康列表</h3><p>只显示当前登录租户和客户的真实设备数据。</p></div>
      <el-table :data="overview?.rows ?? []" v-loading="busy" row-key="profileId" stripe
        empty-text="暂无已核验的设备健康数据">
        <el-table-column label="设备 ID" min-width="220">
          <template #default="{ row }">
            <el-button link type="primary" class="pdm-code" @click="openDevice(row.deviceId)">{{ row.deviceId }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="健康指数" width="110">
          <template #default="{ row }"><b>{{ row.healthIndex == null ? '未知' : row.healthIndex.toFixed(1) }}</b></template>
        </el-table-column>
        <el-table-column label="风险级别" width="112">
          <template #default="{ row }"><el-tag :type="riskTag(row.riskLevel)">{{ riskLabel(row.riskLevel) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="数据质量" width="105" prop="dataQuality" />
        <el-table-column label="点位/工况" width="130">
          <template #default="{ row }">
            <div class="pdm-flags">
              <span :class="row.pointMappingsVerified ? 'good' : 'waiting'">{{ row.pointMappingsVerified ? '点位已核验' : '点位待核验' }}</span>
              <span :class="row.runStateVerified ? 'good' : 'waiting'">{{ row.runStateVerified ? '工况已核验' : '工况待核验' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近评估 (UTC)" min-width="170">
          <template #default="{ row }">{{ time(row.lastEvaluatedUtc) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="95" fixed="right">
          <template #default="{ row }"><el-button link type="primary" @click="openDevice(row.deviceId)">详情</el-button></template>
        </el-table-column>
      </el-table>
      <div class="pdm-footer">
        <span>未知和停机状态不自动判为健康。</span>
        <el-pagination v-model:current-page="page" background layout="total,prev,pager,next"
          :page-size="20" :total="overview?.totalDevices ?? 0" :disabled="!status?.configured" @current-change="loadOverview" />
      </div>
    </section>
  <InternalWorkOrders />
  </ConsolePageShell>

  <el-drawer v-model="drawer" title="设备健康详情" size="min(900px,94vw)" @closed="disposeChart">
    <div class="pdm-detail">
      <b class="pdm-code">{{ selectedDevice }}</b>
      <el-skeleton v-if="detailBusy" :rows="5" animated />
      <el-alert v-else-if="detailError" :title="detailError" type="error" show-icon :closable="false" />
      <template v-else>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="规则版本">{{ profile?.version ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="窗口分钟数">{{ profile?.windowMinutes ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="历史窗口数">{{ trend.length }}</el-descriptions-item>
        </el-descriptions>
        <el-tabs v-model="detailTab" @tab-change="renderChart">
          <el-tab-pane name="trend" label="健康指数趋势">
            <div class="pdm-tools">
              <span>只读规则评分 0–100，缺测为未知</span>
              <el-radio-group v-model="days" size="small" @change="reloadTrend">
                <el-radio-button :value="1">1 天</el-radio-button>
                <el-radio-button :value="7">7 天</el-radio-button>
                <el-radio-button :value="30">30 天</el-radio-button>
              </el-radio-group>
            </div>
            <el-empty v-if="trend.length === 0" description="暂无真实历史评估数据" />
            <div v-show="trend.length > 0" ref="chartEl" class="pdm-chart" />
          </el-tab-pane>
          <el-tab-pane name="p3" label="P3 离线 Shadow" lazy>
            <P3ShadowPanel :key="selectedDevice" :device-id="selectedDevice" />
          </el-tab-pane>
          <el-tab-pane name="p2" label="P2 影子分析" lazy>
            <P2ShadowPanel :key="selectedDevice" :device-id="selectedDevice" />
          </el-tab-pane>
          <el-tab-pane name="policies" label="监测点位规则">
            <el-alert v-if="!profile?.pointMappingsVerified || !profile?.runStateVerified"
              type="warning" title="现场点位或运行状态尚未核验" :closable="false" show-icon class="pdm-alert" />
            <el-table :data="profile?.points ?? []" stripe empty-text="暂无核验点位">
              <el-table-column prop="telemetryKey" label="遥测 Key" min-width="170" show-overflow-tooltip />
              <el-table-column prop="unit" label="单位" width="80" />
              <el-table-column prop="expectedIntervalSeconds" label="采样间隔(s)" width="115" />
              <el-table-column prop="warningHighValue" label="预警上限" width="100" />
              <el-table-column prop="criticalHighValue" label="严重上限" width="100" />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import * as echarts from 'echarts';
import ConsolePageShell from '/@/components/console/ConsolePageShell.vue';
import P2ShadowPanel from './P2ShadowPanel.vue';
import P3ShadowPanel from './P3ShadowPanel.vue';
import InternalWorkOrders from './InternalWorkOrders.vue';
import { getPdmOverview, getPdmProfile, getPdmStatus, getPdmTrend } from '/@/api/pdm';
import type { PdmOverview, PdmProfile, PdmStatus, PdmTrend } from '/@/api/pdm';

const status = ref<PdmStatus | null>(null);
const overview = ref<PdmOverview | null>(null);
const page = ref(1);
const busy = ref(false);
const error = ref('');
const drawer = ref(false);
const selectedDevice = ref('');
const detailBusy = ref(false);
const detailError = ref('');
const detailTab = ref('trend');
const days = ref(7);
const profile = ref<PdmProfile | null>(null);
const trend = ref<PdmTrend[]>([]);
const chartEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
let requestId = 0;

const metrics = computed(() => {
  if (!status.value?.configured || !overview.value) return [];
  const rows = overview.value.rows;
  return [
    { label: '设备数量', value: overview.value.totalDevices, hint: '本租户及客户', tone: 'primary' as const },
    { label: '未解除风险', value: overview.value.activeRisks, hint: 'Open 风险事件', tone: 'warning' as const },
    { label: '本页有评分', value: rows.filter(r => r.healthIndex != null).length, hint: '仅规则指标', tone: 'success' as const },
    { label: '本页未知', value: rows.filter(r => r.healthIndex == null).length, hint: '待采集或质量不足', tone: 'accent' as const },
  ];
});
function riskLabel(v: string) {
  return ({ Normal: '正常', Attention: '关注', Warning: '预警', Critical: '严重', Unknown: '未知' } as Record<string,string>)[v] || '未知';
}
function riskTag(v: string): 'success'|'warning'|'danger'|'info' {
  if (v === 'Normal') return 'success';
  if (v === 'Critical') return 'danger';
  if (v === 'Warning' || v === 'Attention') return 'warning';
  return 'info';
}
function time(s: string|null|undefined) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T',' ').slice(0,19) + ' UTC';
}
async function loadOverview() {
  if (!status.value?.configured) return;
  busy.value = true;
  try { overview.value = (await getPdmOverview(page.value)).data; }
  catch { error.value = '无法读取健康数据，请检查 PdM 独立元数据存储。'; }
  finally { busy.value = false; }
}
async function reload() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    status.value = (await getPdmStatus()).data;
    overview.value = status.value?.configured ? (await getPdmOverview(page.value)).data : null;
  } catch {
    status.value = null;
    error.value = '模块状态不可访问，请确认后端 API 是否更新。';
  } finally { busy.value = false; }
}
async function openDevice(id: string) {
  const seq = ++requestId;
  selectedDevice.value = id;
  drawer.value = true;
  detailBusy.value = true;
  detailError.value = '';
  detailTab.value = 'trend';
  days.value = 7;
  trend.value = [];
  profile.value = null;
  disposeChart();
  try {
    const [p, t] = await Promise.all([getPdmProfile(id), getPdmTrend(id, days.value)]);
    if (seq !== requestId) return;
    profile.value = p.data;
    trend.value = t.data;
  } catch {
    if (seq === requestId) detailError.value = '当前设备数据不存在或无访问权限。';
  } finally {
    if (seq === requestId) { detailBusy.value = false; await nextTick(); renderChart(); }
  }
}
async function reloadTrend() {
  const seq = ++requestId;
  detailBusy.value = true;
  try {
    const data = await getPdmTrend(selectedDevice.value, days.value);
    if (seq === requestId) trend.value = data.data;
  } catch {
    if (seq === requestId) detailError.value = '健康趋势查询失败。';
  } finally {
    if (seq === requestId) { detailBusy.value = false; await nextTick(); renderChart(); }
  }
}
function renderChart() {
  if (!drawer.value || detailTab.value !== 'trend' || !trend.value.length || !chartEl.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 50, top: 35, right: 22, bottom: 66 },
    xAxis: { type: 'category', boundaryGap: false,
      data: trend.value.map(x => time(x.windowEndUtc).replace(' UTC','')),
      axisLabel: { rotate: 32, fontSize: 10 } },
    yAxis: { type: 'value', min: 0, max: 100, name: '规则指数' },
    series: [{ type: 'line', name: '健康指数', connectNulls: false,
      data: trend.value.map(x => x.healthIndex), showSymbol: trend.value.length < 30,
      lineStyle: { color: '#266fc7' }, areaStyle: { color: 'rgba(38,111,199,.07)' } }],
  }, true);
  chart.resize();
}
function disposeChart() { chart?.dispose(); chart = null; }
function resize() { chart?.resize(); }
onMounted(() => { window.addEventListener('resize',resize); void reload(); });
onBeforeUnmount(() => { window.removeEventListener('resize',resize); disposeChart(); });
</script>

<style scoped lang="scss">
.pdm-alert { margin: 0 0 18px; }
.pdm-panel { padding: 20px 22px; border: 1px solid #dce6f3; border-radius: 18px; background: var(--el-bg-color,#fff); }
.pdm-heading { margin-bottom: 20px; }
.pdm-heading h3 { margin: 0 0 8px; font-size: 20px; color: var(--el-text-color-primary,#233c58); }
.pdm-heading p { margin: 0; font-size: 13px; color: #778da1; }
.pdm-code { font-family: Consolas,'Cascadia Code',monospace; font-size: 12px; word-break: break-all; }
.pdm-flags { display: grid; gap: 4px; font-size: 11px; }
.good { color: #148c62; }.waiting { color: #bd8746; }
.pdm-footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; color: #8598aa; font-size: 12px; margin-top: 19px; }
.pdm-detail { display: grid; gap: 18px; }
.pdm-tools { display: flex; gap: 12px; justify-content: space-between; align-items: center; color: #8194a7; font-size: 12px; flex-wrap: wrap; }
.pdm-chart { height: 320px; width: 100%; }
@media(max-width: 760px) { .pdm-panel { padding: 13px; } }
</style>
