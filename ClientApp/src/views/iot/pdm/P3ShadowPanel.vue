<template>
  <section class="pdm-p3-panel">
    <header class="pdm-p3-heading">
      <div>
        <span class="pdm-p3-eyebrow">P3 · OFFLINE SHADOW</span>
        <h3>离线异常检测与实验记录</h3>
        <p>仅展示服务端核验后的历史统计结果；不代表故障概率、剩余寿命或自动派工许可。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <el-skeleton v-if="loading" :rows="5" animated />
    <template v-else-if="report">
      <el-alert
        :type="report.state === 'StatisticsOnly' ? 'info' : 'warning'"
        :title="stateLabel(report.state)"
        :description="report.explanation"
        :closable="false"
        show-icon
      />
      <div class="pdm-p3-metrics">
        <div><small>统计偏离分数</small><strong>{{ metric(report.robustDeviationScore) }}</strong></div>
        <div><small>历史基线中位数</small><strong>{{ metric(report.baselineMedian) }}</strong></div>
        <div><small>历史基线 MAD</small><strong>{{ metric(report.baselineMad) }}</strong></div>
      </div>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="点位">
          {{ report.pointKey || '未核验' }}
        </el-descriptions-item>
        <el-descriptions-item label="单位">
          {{ report.unit || '未核验' }}
        </el-descriptions-item>
        <el-descriptions-item label="工况">
          {{ report.operatingMode || '未核验' }}
        </el-descriptions-item>
        <el-descriptions-item label="评估时间 (UTC)">
          {{ utcTime(report.windowEndUtc) }}
        </el-descriptions-item>
        <el-descriptions-item label="规则版本">V{{ report.profileVersion }}</el-descriptions-item>
        <el-descriptions-item label="实验版本指纹">
          <code class="pdm-p3-fingerprint">{{ report.experimentSha256 || '未登记' }}</code>
        </el-descriptions-item>
      </el-descriptions>
      <p class="pdm-p3-boundary">
        统计偏离只意味着当前样本相对于历史基线的变化。未通过真实故障标签、误报和漏报验收之前，不能解释为故障预测准确率。此页面无审批、通知或工单执行按钮。
      </p>
    </template>
    <el-empty v-else-if="!error" description="暂无经过核验的 P3 离线结果" />
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { getPdmP3Shadow } from '/@/api/pdm/p3';
import type { PdmP3Shadow } from '/@/api/pdm/p3';
import { checkPdmP3Evidence } from './Batch3P3EvidencePolicy';

const props = defineProps<{ deviceId: string }>();
const report = ref<PdmP3Shadow | null>(null);
const error = ref('');
const loading = ref(false);
let currentRequest = 0;

function metric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '未知' : value.toFixed(3);
}
function stateLabel(value: string): string {
  return ({
    Unverified: '数据或实验来源尚未核验',
    StatisticsOnly: '离线统计证据（只读）',
    HistoricalStatisticsOnly: '历史统计证据（不代表当前状态）'
  } as Record<string, string>)[value] || '不可信状态';
}
function utcTime(value: string | null): string {
  if (!value) return '—';
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? '—' :
    time.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}
async function load() {
  const request = ++currentRequest;
  const deviceId = props.deviceId;
  report.value = null;
  error.value = '';
  if (!deviceId) return;
  loading.value = true;
  try {
    const response = await getPdmP3Shadow(deviceId);
    if (request === currentRequest) {
      const verdict = checkPdmP3Evidence(response.data);
      report.value = verdict.report;
      if (!verdict.report) error.value = verdict.reason;
    }
  } catch {
    if (request === currentRequest) error.value =
      'P3 离线证据尚未部署或未通过发布门禁。这里不生成虚拟分数，也不调用在线预测。';
  } finally {
    if (request === currentRequest) loading.value = false;
  }
}
watch(() => props.deviceId, () => { void load(); }, { immediate: true });
</script>

<style scoped lang="scss">
.pdm-p3-panel { display: grid; gap: 16px; padding: 12px 0 20px; }
.pdm-p3-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.pdm-p3-heading h3 { margin: 6px 0; font-size: 19px; }
.pdm-p3-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.75; }
.pdm-p3-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .1em; color: #4778af; }
.pdm-p3-metrics { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; }
.pdm-p3-metrics > div { padding: 15px; background: #f5f8fc; border: 1px solid #dde8f6; border-radius: 11px; }
.pdm-p3-metrics small { display: block; color: #71859a; }
.pdm-p3-metrics strong { display: block; margin-top: 9px; font-size: 19px; color: #285780; }
.pdm-p3-fingerprint { word-break: break-all; font-size: 11px; }
.pdm-p3-boundary { color: #a47738; font-size: 12px; line-height: 1.9; margin: 0; }
@media (max-width: 740px) {
  .pdm-p3-heading { flex-direction: column; }
  .pdm-p3-metrics { grid-template-columns: 1fr; }
}
</style>

