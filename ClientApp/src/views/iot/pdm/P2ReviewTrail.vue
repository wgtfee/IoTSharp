<template>
  <div class="pdm-review-trail">
    <div class="pdm-review-head">
      <div>
        <strong>审批与审计记录</strong>
        <p>只读审核台账 · 未经授权不能批准、拒绝或下发工单</p>
      </div>
      <el-button size="small" :loading="busy" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" type="warning" :title="error" :closable="false" show-icon />
    <el-skeleton v-if="busy" :rows="3" animated />
    <template v-else-if="data">
      <el-table :data="data.rows" stripe size="small" empty-text="暂无真实审批记录">
        <el-table-column prop="title" label="维护提案" min-width="170" show-overflow-tooltip />
        <el-table-column label="审核状态" min-width="130">
          <template #default="{ row }">
            <el-tag :type="stateTag(row.state)" size="small">{{ stateLabel(row.state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="profileVersion" label="规则版本" width="85" />
        <el-table-column label="记录时间(UTC)" min-width="150">
          <template #default="{ row }">{{ utc(row.createdAtUtc) }}</template>
        </el-table-column>
      </el-table>
      <div class="pdm-review-footer">
        <span>工单创建：未启用</span>
        <el-pagination
          background size="small" layout="prev,pager,next"
          :current-page="page" :page-size="20" :total="data.total"
          @current-change="changePage"
        />
      </div>
      <el-collapse v-if="data.audits.length > 0" class="pdm-review-audits">
        <el-collapse-item title="展开审批审计轨迹" name="audits">
          <el-timeline>
            <el-timeline-item
              v-for="entry in data.audits"
              :key="entry.id"
              :timestamp="utc(entry.atUtc)"
              placement="top"
            >
              <strong>{{ auditLabel(entry.action) }}</strong>
              <p>{{ entry.reason }}</p>
            </el-timeline-item>
          </el-timeline>
        </el-collapse-item>
      </el-collapse>
    </template>
    <el-empty v-else-if="!error" description="审核台账未部署或无数据" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { getPdmP2Reviews } from '/@/api/pdm/p2reviews';
import type { PdmP2ReviewPage } from '/@/api/pdm/p2reviews';

const props = defineProps<{ deviceId: string }>();
const page = ref(1);
const data = ref<PdmP2ReviewPage | null>(null);
const busy = ref(false);
const error = ref('');
let sequence = 0;

function stateLabel(state: string) {
  return ({
    AwaitingHumanReview: '等待人工复核',
    ApprovedForPlanning: '已审核，仅供规划',
    Rejected: '审核拒绝'
  } as Record<string,string>)[state] || '未知状态';
}
function stateTag(state: string): 'info' | 'success' | 'danger' {
  return state === 'ApprovedForPlanning' ? 'success'
    : state === 'Rejected' ? 'danger' : 'info';
}
function auditLabel(action: string) {
  return ({
    DraftCreated: '创建审批草稿',
    ApprovedForPlanning: '同意进入规划',
    Rejected: '审核拒绝'
  } as Record<string, string>)[action] || '审核记录';
}
function utc(value: string) {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf())
    ? date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
    : '—';
}
function changePage(nextPage: number) {
  page.value = nextPage;
  void load();
}
async function load() {
  const current = ++sequence;
  data.value = null;
  error.value = '';
  if (!props.deviceId) return;
  busy.value = true;
  try {
    const response = await getPdmP2Reviews(props.deviceId, page.value);
    if (current === sequence) data.value = response.data;
  } catch {
    if (current === sequence) {
      error.value = '审批台账尚未部署或只读门禁未启用；当前不会展示模拟记录。';
    }
  } finally {
    if (current === sequence) busy.value = false;
  }
}
watch(() => props.deviceId, () => { page.value = 1; void load(); }, { immediate: true });
</script>

<style scoped lang="scss">
.pdm-review-trail { padding: 18px; border: 1px solid var(--el-border-color-light); border-radius: 12px; display: grid; gap: 15px; }
.pdm-review-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.pdm-review-head p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.pdm-review-footer { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--el-text-color-placeholder); }
.pdm-review-audits p { margin: 4px 0; font-size: 12px; line-height: 1.7; }
</style>

