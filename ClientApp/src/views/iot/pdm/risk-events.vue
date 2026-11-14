<template>
  <ConsolePageShell eyebrow="RISK MANAGEMENT" title="预测性维护风险事件"
    description="查看真实设备风险及证据；具备维修工单管理员权限时，可从已核验的持续异常创建内部维修工单。"
    :badges="[feature?.configured ? '只读查询' : '尚未启用']"
    :metrics="metrics">
    <template #actions><el-button :loading="loading" @click="reload">刷新事件</el-button></template>
    <el-alert v-if="feature && !feature.configured" title="风险事件服务尚未启用"
      :description="feature.message" type="warning" :closable="false" show-icon class="pdm-alert" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="pdm-alert" />
    <section class="pdm-panel">
      <header class="pdm-head">
        <div><h3>风险事件明细</h3><p>离线、停机与数据质量未知时不会自动解除现有风险。</p></div>
        <el-select v-model="riskStatus" style="width: 156px" :disabled="!feature?.configured" @change="changeFilter">
          <el-option label="未解除" value="Open" />
          <el-option label="已解除" value="Cleared" />
          <el-option label="全部事件" value="All" />
        </el-select>
      </header>
      <el-table :data="data?.rows ?? []" v-loading="loading" row-key="id" stripe empty-text="暂无真实风险事件">
        <el-table-column label="设备 ID" min-width="220">
          <template #default="{ row }"><span class="pdm-code">{{ row.deviceId }}</span></template>
        </el-table-column>
        <el-table-column label="风险等级" width="110">
          <template #default="{ row }"><el-tag :type="riskTag(row.riskLevel)">{{ riskLabel(row.riskLevel) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="row.status === 'Open' ? 'danger' : 'success'" effect="plain">{{ row.status === 'Open' ? '未解除' : '已解除' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="首次发现 (UTC)" min-width="178">
          <template #default="{ row }">{{ time(row.firstObservedUtc) }}</template>
        </el-table-column>
        <el-table-column label="最后发现 (UTC)" min-width="178">
          <template #default="{ row }">{{ time(row.lastObservedUtc) }}</template>
        </el-table-column>
        <el-table-column prop="occurrenceCount" label="发生次数" width="95" />
        <el-table-column label="操作" width="174" fixed="right">
          <template #default="{ row }"><el-button link type="primary" @click="viewRisk(row)">详情</el-button>
          <el-button v-if="row.status === 'Open'" link type="primary" :loading="creatingRiskId === row.id" @click="createInternalOrder(row)">建维修工单</el-button></template>
        </el-table-column>
      </el-table>
      <footer class="pdm-footer">
        <span>所有事件来自已批准的 PdM 独立元数据存储，不包含测试模拟数据。</span>
        <el-pagination v-model:current-page="page" background layout="total,prev,pager,next"
          :page-size="20" :total="data?.total ?? 0" :disabled="!feature?.configured" @current-change="loadRisks" />
      </footer>
    </section>
  </ConsolePageShell>
  <el-drawer v-model="drawer" title="风险分析证据（只读）" size="min(720px,94vw)">
    <div v-if="selected" class="pdm-detail">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="设备 ID">{{ selected.deviceId }}</el-descriptions-item>
        <el-descriptions-item label="风险等级">{{ riskLabel(selected.riskLevel) }}</el-descriptions-item>
        <el-descriptions-item label="事件状态">{{ selected.status === 'Open' ? '未解除' : '已解除' }}</el-descriptions-item>
        <el-descriptions-item label="首次发现">{{ time(selected.firstObservedUtc) }}</el-descriptions-item>
        <el-descriptions-item label="最后出现">{{ time(selected.lastObservedUtc) }}</el-descriptions-item>
        <el-descriptions-item label="解除时间">{{ time(selected.clearedAtUtc) }}</el-descriptions-item>
        <el-descriptions-item label="发生次数">{{ selected.occurrenceCount }}</el-descriptions-item>
        <el-descriptions-item label="配置版本">{{ selected.profileVersion }}</el-descriptions-item>
      </el-descriptions>
      <h4>异常与恢复证据</h4>
      <pre class="pdm-evidence">{{ prettyEvidence(selected.evidenceJson) }}</pre>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ConsolePageShell from '/@/components/console/ConsolePageShell.vue';
import { getPdmRisks, getPdmStatus } from '/@/api/pdm';
import { createPdmInternalWorkOrderFromRisk } from '/@/api/pdm/workorders';
import type { PdmStatus, PdmRisks, PdmRiskEvent } from '/@/api/pdm';

const feature = ref<PdmStatus | null>(null);
const data = ref<PdmRisks | null>(null);
const loading = ref(false);
const error = ref('');
const riskStatus = ref<'Open'|'Cleared'|'All'>('Open');
const page = ref(1);
const drawer = ref(false);
const selected = ref<PdmRiskEvent | null>(null);
const creatingRiskId = ref('');
const metrics = computed(() => {
  if (!feature.value?.configured || !data.value) return [];
  return [{ label: '当前筛选结果', value: data.value.total, hint: '独立风险事件', tone: 'warning' as const }];
});
function riskLabel(v: string) {
  return ({ Normal: '正常', Attention: '关注', Warning: '预警', Critical: '严重', Unknown: '未知' } as Record<string,string>)[v] || '未知';
}
function riskTag(v: string): 'success'|'warning'|'danger'|'info' {
  return v === 'Normal' ? 'success' : v === 'Critical' ? 'danger' : v === 'Warning' || v === 'Attention' ? 'warning' : 'info';
}
function time(value?: string | null) {
  if (!value) return '—';
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toISOString().replace('T',' ').slice(0,19) + ' UTC';
}
function prettyEvidence(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value || '暂无分析证据'; }
}
function viewRisk(item: unknown) { selected.value = item as PdmRiskEvent; drawer.value = true; }
async function createInternalOrder(item: unknown) {
  const row = item as PdmRiskEvent;
  if (row.status !== 'Open' || creatingRiskId.value) return;
  creatingRiskId.value = row.id;
  try {
    const response = await createPdmInternalWorkOrderFromRisk(row.id);
    ElMessage.success('内部维修工单已保存：' + response.data.workOrderNo);
  } catch {
    ElMessage.warning('建单未完成：请检查现场异常证据、工单权限及独立 SQL Server 上线门禁。');
  } finally {
    creatingRiskId.value = '';
  }
}
function changeFilter() { page.value = 1; void loadRisks(); }
async function loadRisks() {
  if (!feature.value?.configured) return;
  loading.value = true;
  error.value = '';
  try { data.value = (await getPdmRisks(riskStatus.value, page.value)).data; }
  catch { error.value = '风险数据读取失败，请检查 PdM 独立数据库及访问范围。'; }
  finally { loading.value = false; }
}
async function reload() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    feature.value = (await getPdmStatus()).data;
    data.value = feature.value?.configured
      ? (await getPdmRisks(riskStatus.value, page.value)).data : null;
  } catch {
    feature.value = null;
    error.value = '无法读取预测性维护状态，请检查后端 API。';
  } finally { loading.value = false; }
}
onMounted(() => { void reload(); });
</script>

<style scoped lang="scss">
.pdm-alert { margin: 0 0 18px; }
.pdm-panel { padding: 20px 22px; border: 1px solid #dce6f3; border-radius: 18px; background: var(--el-bg-color,#fff); }
.pdm-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; gap: 18px; }
.pdm-head h3 { margin: 0 0 7px; font-size: 20px; }
.pdm-head p { margin: 0; color: #7e91a3; font-size: 13px; }
.pdm-code { font-family: Consolas,'Cascadia Code',monospace; font-size: 12px; }
.pdm-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; margin-top: 18px; font-size: 12px; color: #8296a8; }
.pdm-detail { display: grid; gap: 18px; }
.pdm-evidence { padding: 17px; white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f8fc; border-radius: 12px; max-height: 380px; overflow-y: auto; color: #385269; }
@media(max-width: 760px) { .pdm-panel { padding: 13px; } .pdm-head { flex-direction: column; } }
</style>
