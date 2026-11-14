<template>
  <section class="pdm-internal-orders">
    <div class="pdm-orders-header">
      <div>
        <h3>内部维修工单</h3>
        <p>IoTSharp 管理工单全生命周期，飞书仅发送新工单通知。通知失败不会删除工单。</p>
      </div>
      <div class="pdm-orders-actions">
        <el-select v-model="filterState" clearable placeholder="全部状态" style="width:138px"
          @change="changeFilter">
          <el-option label="待处理" value="Open" />
          <el-option label="已分配" value="Assigned" />
          <el-option label="处理中" value="InProgress" />
          <el-option label="已完成" value="Completed" />
          <el-option label="已关闭" value="Closed" />
        </el-select>
        <el-button size="small" :loading="busy" @click="load">刷新</el-button>
      </div>
    </div>
    <el-alert v-if="unavailable" title="内部维修工单尚未完成数据库上线门禁"
      description="当前不展示虚拟工单。正式启用需要独立 PdM SQL Server 表、真实设备点位及授权配置。"
      type="warning" show-icon :closable="false" class="pdm-orders-warning" />
    <el-alert v-else-if="error" :title="error" type="error" show-icon :closable="false"
      class="pdm-orders-warning" />
    <el-table :data="data?.rows ?? []" v-loading="busy" stripe row-key="id"
      empty-text="没有符合条件的真实维修工单">
      <el-table-column prop="workOrderNo" label="工单编号" min-width="260" show-overflow-tooltip />
      <el-table-column prop="title" label="工单主题" min-width="175" show-overflow-tooltip />
      <el-table-column label="风险" width="105">
        <template #default="{ row }">
          <el-tag :type="row.riskLevel === 'Critical' ? 'danger' : 'warning'" size="small">
            {{ row.riskLevel === 'Critical' ? '严重' : '预警' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="工单状态" width="108">
        <template #default="{ row }">
          <el-tag :type="stateTag(row.state)" size="small">{{ stateLabel(row.state) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="deviceId" label="设备 ID" min-width="220" show-overflow-tooltip />
      <el-table-column label="创建时间 UTC" min-width="167">
        <template #default="{ row }">{{ utc(row.createdAtUtc) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="94" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="open(row)">处理</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="pdm-orders-footer">
      <span>本页只显示已入库的真实工单，不展示模拟或合成模型产物。</span>
      <el-pagination background layout="total,prev,pager,next"
        v-model:current-page="page" :page-size="20" :total="data?.total ?? 0"
        :disabled="unavailable" @current-change="load" />
    </div>
    <el-dialog v-model="dialog" title="维修工单处理" width="min(590px,94vw)" destroy-on-close>
      <template v-if="selected">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="工单号">{{ selected.workOrderNo }}</el-descriptions-item>
          <el-descriptions-item label="设备 ID">{{ selected.deviceId }}</el-descriptions-item>
          <el-descriptions-item label="当前状态">{{ stateLabel(selected.state) }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ selected.assignedTo || '待分配' }}</el-descriptions-item>
          <el-descriptions-item label="建议">{{ selected.description }}</el-descriptions-item>
          <el-descriptions-item v-if="selected.resolution" label="维修结果">
            {{ selected.resolution }}
          </el-descriptions-item>
        </el-descriptions>
        <div v-if="nextAction" class="pdm-orders-form">
          <el-alert title="请按岗位权限进行操作；所有变更记录审计日志"
            type="info" :closable="false" />
          <el-form label-position="top">
            <el-form-item v-if="nextAction === 'Assign'" label="指派维修人用户 ID">
              <el-input v-model="assignedTo" placeholder="输入 IoTSharp 用户 GUID" maxlength="36" />
            </el-form-item>
            <el-form-item :label="nextAction === 'Complete' ? '维修处理结果' : '处理说明'">
              <el-input v-model="reason" type="textarea" :rows="3"
                maxlength="512" show-word-limit placeholder="填写实际操作和现场证据" />
            </el-form-item>
          </el-form>
        </div>
      </template>
      <template #footer>
        <el-button @click="dialog = false">关闭</el-button>
        <el-button v-if="nextAction" type="primary" :loading="saving"
          :disabled="!reason.trim() || (nextAction === 'Assign' && !validGuid(assignedTo))"
          @click="submit">{{ actionLabel(nextAction) }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { listPdmInternalWorkOrders, transitionPdmInternalWorkOrder } from '/@/api/pdm/workorders';
import type { PdmInternalWorkOrder, PdmInternalWorkOrderPage, PdmWorkOrderState } from '/@/api/pdm/workorders';

const props = withDefaults(defineProps<{ deviceId?: string }>(), { deviceId: '' });
const filterState = ref<PdmWorkOrderState | ''>('');
const page = ref(1);
const data = ref<PdmInternalWorkOrderPage | null>(null);
const busy = ref(false);
const error = ref('');
const unavailable = ref(false);
const dialog = ref(false);
const saving = ref(false);
const selected = ref<PdmInternalWorkOrder | null>(null);
const assignedTo = ref('');
const reason = ref('');
let seq = 0;

const nextAction = computed(() => {
  switch (selected.value?.state) {
    case 'Open': return 'Assign' as const;
    case 'Assigned': return 'Start' as const;
    case 'InProgress': return 'Complete' as const;
    case 'Completed': return 'Close' as const;
    default: return null;
  }
});
function stateLabel(s: PdmWorkOrderState) {
  return ({ Open: '待处理', Assigned: '已分配', InProgress: '处理中',
    Completed: '已完成', Closed: '已关闭' } as Record<PdmWorkOrderState,string>)[s] || '未知';
}
function stateTag(s: PdmWorkOrderState): 'success' | 'warning' | 'danger' | 'info' {
  return s === 'Closed' ? 'info' : s === 'Completed' ? 'success'
    : s === 'InProgress' ? 'warning' : s === 'Open' ? 'danger' : 'info';
}
function actionLabel(s: string) {
  return ({ Assign: '分配工单', Start: '开始维修',
    Complete: '完成维修', Close: '验收关闭' } as Record<string,string>)[s] || '处理';
}
function utc(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toISOString().replace('T',' ').slice(0,19) + ' UTC';
}
function validGuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function open(item: unknown) {
  const row = item as PdmInternalWorkOrder;
  selected.value = row;
  assignedTo.value = row.assignedTo ?? '';
  reason.value = '';
  dialog.value = true;
}
function changeFilter() { page.value = 1; void load(); }
async function load() {
  const id = ++seq;
  busy.value = true;
  error.value = '';
  try {
    const response = await listPdmInternalWorkOrders({
      page: page.value, pageSize: 20,
      ...(filterState.value ? { state: filterState.value } : {}),
      ...(props.deviceId ? { deviceId: props.deviceId } : {})
    });
    if (id === seq) { data.value = response.data; unavailable.value = false; }
  } catch {
    if (id === seq) {
      data.value = null;
      unavailable.value = true;
    }
  } finally {
    if (id === seq) busy.value = false;
  }
}
async function submit() {
  const row = selected.value;
  const action = nextAction.value;
  if (!row || !action || !reason.value.trim() ||
      (action === 'Assign' && !validGuid(assignedTo.value))) return;
  saving.value = true;
  try {
    await transitionPdmInternalWorkOrder(row.id, {
      expectedRevision: row.revision, action,
      assignedTo: action === 'Assign' ? assignedTo.value : null,
      reason: reason.value.trim()
    });
    dialog.value = false;
    ElMessage.success('工单状态已保存');
    await load();
  } catch {
    ElMessage.error('操作失败：请检查岗位权限、状态或工单版本');
    await load();
  } finally { saving.value = false; }
}
watch(() => props.deviceId, () => { page.value = 1; void load(); });
onMounted(() => { void load(); });
</script>

<style scoped lang="scss">
.pdm-internal-orders { margin-top: 24px; padding: 20px 22px; border: 1px solid #dce6f3; border-radius: 18px; background: var(--el-bg-color,#fff); }
.pdm-orders-header { display: flex; justify-content: space-between; gap: 15px; margin-bottom: 17px; align-items: flex-start; flex-wrap: wrap; }
.pdm-orders-header h3 { margin: 0 0 8px; font-size: 20px; color: var(--el-text-color-primary,#233c58); }
.pdm-orders-header p { margin: 0; color: var(--el-text-color-secondary,#7e91a3); font-size: 13px; }
.pdm-orders-actions { display: flex; align-items: center; gap: 10px; }
.pdm-orders-warning { margin-bottom: 15px; }
.pdm-orders-footer { margin-top: 16px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; color: #8296a8; font-size: 12px; }
.pdm-orders-form { display: grid; gap: 15px; margin-top: 18px; }
@media(max-width:760px) { .pdm-internal-orders { padding: 13px; } }
</style>
