<template>
  <section class="pdm-p2-panel">
    <div class="pdm-p2-head">
      <div>
        <div class="pdm-p2-eyebrow">P2 · SHADOW ANALYSIS</div>
        <h3>趋势分析与维护建议</h3>
        <p>根据已保存的 P1 健康历史生成只读提案，不执行通知、审批、工单或设备控制。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新影子分析</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <el-skeleton v-if="loading" :rows="5" animated />
    <template v-else-if="result">
      <el-alert
        v-if="result.state !== 'ProposalOnly'"
        :title="stateLabel(result.state)"
        :description="result.message"
        type="warning" :closable="false" show-icon
        class="pdm-p2-alert"
      />
      <el-alert v-else
        title="影子分析（仅用于人工复核）"
        :description="result.message" type="info" :closable="false" show-icon
        class="pdm-p2-alert"
      />
      <div class="pdm-p2-grid">
        <article class="pdm-p2-tile">
          <span>健康趋势</span>
          <strong>{{ trendLabel(result.trend.direction) }}</strong>
          <small>{{ result.trend.validWindows }} 个连续可信窗口</small>
        </article>
        <article class="pdm-p2-tile">
          <span>变化斜率</span>
          <strong>{{ formatSlope(result.trend.slopePointsPerHour) }}</strong>
          <small>健康指数点 / 小时</small>
        </article>
        <article class="pdm-p2-tile">
          <span>预警决策</span>
          <strong>{{ alertLabel(result.alert.kind) }}</strong>
          <small>仅为只读提案，未发送</small>
        </article>
      </div>
      <el-descriptions :column="1" border class="pdm-p2-description">
        <el-descriptions-item label="趋势解释">{{ result.trend.reason }}</el-descriptions-item>
        <el-descriptions-item label="预警解释">{{ result.alert.reason }}</el-descriptions-item>
        <el-descriptions-item label="最近评估 (UTC)">{{ utcTime(result.latestWindowUtc) }}</el-descriptions-item>
        <el-descriptions-item label="配置版本">V{{ result.profileVersion }}</el-descriptions-item>
        <el-descriptions-item label="提案编号">
          <code v-if="result.alert.idempotencyKey" class="pdm-p2-code">{{ result.alert.idempotencyKey }}</code>
          <span v-else>未生成</span>
        </el-descriptions-item>
      </el-descriptions>
      <div class="pdm-p2-maintenance">
        <div class="pdm-p2-title">
          <h4>人工维护建议</h4>
          <el-tag :type="result.maintenance.state === 'ReadyForHumanReview' ? 'warning' : 'info'">
            {{ adviceLabel(result.maintenance.state) }}
          </el-tag>
        </div>
        <strong>{{ result.maintenance.title }}</strong>
        <p>{{ result.maintenance.explanation }}</p>
        <ul v-if="result.maintenance.suggestedChecks.length">
          <li v-for="(item, index) in result.maintenance.suggestedChecks" :key="index">{{ item }}</li>
        </ul>
        <p class="pdm-p2-boundary">
          本页无审批或工单操作。建议仍需核验点位类别、现场工况及审批权限；不可把规则指标解读为故障概率或剩余寿命。
        </p>
      </div>
    </template>
    <el-empty v-else-if="!error" description="当前没有可显示的影子分析结果" />
    <P2ReviewTrail :device-id="props.deviceId" />
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { getPdmP2Shadow } from '/@/api/pdm/p2';
import P2ReviewTrail from './P2ReviewTrail.vue';
import type { PdmP2Shadow } from '/@/api/pdm/p2';

const props = defineProps<{ deviceId: string }>();
const result = ref<PdmP2Shadow | null>(null);
const loading = ref(false);
const error = ref('');
let requestSequence = 0;

function stateLabel(state: string): string {
  return ({
    Unknown: '尚无可信的 P2 评估数据',
    NoOpenRisk: '当前没有未解除风险',
    Unverified: '趋势数据尚未通过核验',
    ProposalOnly: '只读提案'
  } as Record<string, string>)[state] || '待核验';
}
function trendLabel(direction: string): string {
  return ({ Unknown: '未知', Stable: '基本稳定', Declining: '持续下降', Improving: '持续改善' } as Record<string, string>)[direction] || '未知';
}
function alertLabel(kind: string): string {
  return ({
    Held: '暂缓提案', BelowThreshold: '未达到阈值',
    Suppressed: '冷却期抑制', Notify: '待人工审核', Escalate: '升级待审核'
  } as Record<string, string>)[kind] || '未知';
}
function adviceLabel(state: string): string {
  return ({
    NeedsDataVerification: '需核验',
    NotApplicable: '暂不适用',
    ReadyForHumanReview: '待人工审核'
  } as Record<string, string>)[state] || '未知';
}
function formatSlope(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '未知' : (value > 0 ? '+' : '') + value.toFixed(2);
}
function utcTime(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? '—' : d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}
async function load() {
  const sequence = ++requestSequence;
  const deviceId = props.deviceId;
  result.value = null;
  error.value = '';
  if (!deviceId) return;
  loading.value = true;
  try {
    const response = await getPdmP2Shadow(deviceId);
    if (sequence !== requestSequence) return;
    result.value = response.data;
  } catch {
    if (sequence === requestSequence) error.value =
      'P2 影子分析尚不可用；请确认只读接口、数据库和发布门禁，不会展示模拟数据。';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}
watch(() => props.deviceId, () => { void load(); }, { immediate: true });
</script>

<style scoped lang="scss">
.pdm-p2-panel { display: grid; gap: 18px; padding: 8px 2px 24px; }
.pdm-p2-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pdm-p2-eyebrow { font-size: 11px; color: #326da8; font-weight: 700; letter-spacing: .12em; }
.pdm-p2-head h3 { margin: 7px 0; font-size: 19px; }
.pdm-p2-head p { margin: 0; color: #8296aa; font-size: 12px; line-height: 1.8; }
.pdm-p2-alert { margin-top: 2px; }
.pdm-p2-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pdm-p2-tile { padding: 14px 15px; border: 1px solid #e0eaf6; background: #f5f9fe; border-radius: 11px; }
.pdm-p2-tile span,.pdm-p2-tile small { display: block; color: #73879a; font-size: 12px; }
.pdm-p2-tile strong { display: block; margin: 8px 0; font-size: 20px; color: #285781; }
.pdm-p2-description :deep(.el-descriptions__label) { width: 155px; }
.pdm-p2-code { font-size: 10px; word-break: break-all; color: #59758f; }
.pdm-p2-maintenance { display: grid; gap: 12px; padding: 18px; border: 1px solid #dde8f4; border-radius: 13px; }
.pdm-p2-maintenance h4 { margin: 0; font-size: 17px; }
.pdm-p2-maintenance > strong { color: #284766; }
.pdm-p2-maintenance p { margin: 0; line-height: 1.8; font-size: 13px; color: #64798d; }
.pdm-p2-maintenance ul { margin: 0; padding-left: 22px; line-height: 1.9; font-size: 13px; }
.pdm-p2-title { display: flex; align-items: center; justify-content: space-between; }
.pdm-p2-maintenance .pdm-p2-boundary { color: #b27637; font-size: 12px; }
@media (max-width: 750px) { .pdm-p2-head { flex-direction: column; } .pdm-p2-grid { grid-template-columns: 1fr; } }
</style>

