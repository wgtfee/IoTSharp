<template>
	<div class="telemetry-page">
		<ConsolePageShell
			eyebrow="Telemetry Workspace"
			title="遥测数据"
			description="集中查看设备最新遥测、历史趋势和原始数据；EdgeNode 只负责采集运行与任务闭环，不替代设备遥测。"
			:badges="telemetryBadges"
			:metrics="telemetryMetrics"
		>
			<template #actions>
				<el-button type="success" @click="openTelemetryDialog">新增遥测</el-button>
				<el-tooltip :disabled="Boolean(selectedDeviceId)" content="请先新增并选择一台设备" placement="bottom">
					<span class="telemetry-action-wrapper">
						<el-button type="primary" :loading="summaryLoading" :disabled="!selectedDeviceId" @click="refreshTelemetry">刷新当前遥测</el-button>
					</span>
				</el-tooltip>
				<el-button :loading="devicesLoading" @click="loadDevices(currentPage)">刷新设备列表</el-button>
			</template>

			<section class="telemetry-workspace">
				<aside class="telemetry-device-panel">
					<div class="telemetry-panel__head">
						<div>
							<span>DEVICE SOURCE</span>
							<h3>选择设备</h3>
						</div>
						<el-tag effect="plain">{{ totalDevices }} 台</el-tag>
					</div>

					<div class="telemetry-device-filters">
						<el-input
							v-model="deviceName"
							clearable
							placeholder="设备名称或 ID"
							@keyup.enter="loadDevices(1)"
							@clear="loadDevices(1)"
						>
							<template #append><el-button @click="loadDevices(1)">查询</el-button></template>
						</el-input>
						<div class="telemetry-filter-switch">
							<span>仅显示在线设备</span>
							<el-switch v-model="onlyConnected" @change="loadDevices(1)" />
						</div>
					</div>

					<div v-loading="devicesLoading" class="telemetry-device-list">
						<button
							v-for="device in devices"
							:key="device.id"
							type="button"
							class="telemetry-device-item"
							:class="{ 'is-active': device.id === selectedDeviceId }"
							@click="selectedDeviceId = device.id"
						>
							<i :class="device.connected ? 'is-online' : 'is-offline'"></i>
							<span>
								<strong>{{ device.name || device.id }}</strong>
								<small>{{ device.deviceType || 'Device' }} · {{ device.connected ? '在线' : '离线' }}</small>
							</span>
						</button>
						<el-empty v-if="!devicesLoading && devices.length === 0" description="当前客户还没有设备" :image-size="72">
							<el-button type="primary" plain @click="router.push('/iot/devices/devicelist')">先新增设备</el-button>
						</el-empty>
					</div>

					<el-pagination
						v-if="totalDevices > pageSize"
						v-model:current-page="currentPage"
						background
						small
						layout="prev, pager, next"
						:page-size="pageSize"
						:total="totalDevices"
						@current-change="loadDevices"
					/>
				</aside>

				<main class="telemetry-data-panel">
					<template v-if="selectedDevice">
						<header class="telemetry-selected-device">
							<div>
								<span>当前设备</span>
								<h2>{{ selectedDevice.name || selectedDevice.id }}</h2>
								<p>{{ selectedDevice.id }}</p>
							</div>
							<div class="telemetry-selected-device__tags">
								<el-tag :type="selectedDevice.connected ? 'success' : 'info'">{{ selectedDevice.connected ? '在线' : '离线' }}</el-tag>
								<el-tag effect="plain">{{ selectedDevice.deviceType || 'Device' }}</el-tag>
							</div>
						</header>

						<el-tabs v-model="activeTab" class="telemetry-tabs">
							<el-tab-pane name="realtime" label="最新遥测">
								<DeviceDetailTelemetry
									:key="`realtime-${selectedDeviceId}-${telemetryRefreshKey}`"
									:device-id="selectedDeviceId"
								/>
							</el-tab-pane>
							<el-tab-pane name="history" label="遥测历史" lazy>
								<DeviceDetailTelemetryHistory
									:key="`history-${selectedDeviceId}-${telemetryRefreshKey}`"
									:device-id="selectedDeviceId"
								/>
							</el-tab-pane>
						</el-tabs>
					</template>
					<el-empty v-else :description="totalDevices === 0 ? '请先新增设备，再上报遥测数据' : '请先从左侧选择设备'" />
				</main>
			</section>
		</ConsolePageShell>

		<el-dialog
			v-model="telemetryDialogVisible"
			title="新增遥测数据"
			width="760px"
			append-to-body
			destroy-on-close
			:close-on-click-modal="false"
		>
			<div class="telemetry-create-summary">
				<div>
					<span>目标设备</span>
					<strong>{{ selectedDevice?.name || selectedDevice?.id }}</strong>
					<small>{{ selectedDeviceId }}</small>
				</div>
				<el-date-picker
					v-model="telemetryDraft.timestamp"
					type="datetime"
					placeholder="采集时间"
					format="YYYY-MM-DD HH:mm:ss"
					:clearable="false"
				/>
			</div>

			<el-alert
				title="数据将通过 IoTSharp 原有事件总线写入时序存储，并触发该设备绑定的遥测规则链。"
				type="info"
				:closable="false"
				show-icon
			/>

			<div class="telemetry-create-table">
				<div class="telemetry-create-row telemetry-create-row--head">
					<span>遥测 Key</span>
					<span>数据类型</span>
					<span>值</span>
					<span></span>
				</div>
				<div v-for="(row, index) in telemetryDraft.values" :key="row.id" class="telemetry-create-row">
					<el-input v-model="row.keyName" maxlength="128" :placeholder="`例如 temperature_${index + 1}`" />
					<el-select v-model="row.dataType" @change="resetTelemetryRowValue(row)">
						<el-option v-for="option in telemetryTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
					</el-select>
					<el-switch
						v-if="row.dataType === 'Boolean'"
						v-model="row.value"
						inline-prompt
						active-text="true"
						inactive-text="false"
					/>
					<el-date-picker
						v-else-if="row.dataType === 'DateTime'"
						v-model="row.value"
						type="datetime"
						placeholder="日期时间"
						format="YYYY-MM-DD HH:mm:ss"
					/>
					<el-input
						v-else
						v-model="row.value"
						:placeholder="telemetryValuePlaceholder(row.dataType)"
						:type="row.dataType === 'Json' ? 'textarea' : 'text'"
						:rows="2"
					/>
					<el-button
						type="danger"
						text
						:disabled="telemetryDraft.values.length === 1"
						@click="removeTelemetryRow(index)"
					>删除</el-button>
				</div>
			</div>

			<el-button class="telemetry-add-row" plain type="primary" @click="addTelemetryRow">+ 添加一项遥测</el-button>

			<template #footer>
				<el-button :disabled="telemetrySubmitting" @click="telemetryDialogVisible = false">取消</el-button>
				<el-button type="primary" :loading="telemetrySubmitting" @click="submitTelemetry">提交并刷新</el-button>
			</template>
		</el-dialog>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import ConsolePageShell from '/@/components/console/ConsolePageShell.vue';
import { deviceApi } from '/@/api/devices';
import { useUserInfo } from '/@/stores/userInfo';
import DeviceDetailTelemetry from '/@/views/iot/devices/detail/DeviceDetailTelemetry.vue';
import DeviceDetailTelemetryHistory from '/@/views/iot/devices/detail/DeviceDetailTelemetryHistory.vue';

interface TelemetryDevice {
	id: string;
	name?: string;
	deviceType?: string;
	connected?: boolean;
	active?: boolean;
	lastActivityDateTime?: string;
	lastConnectDateTime?: string;
}

interface LatestTelemetryValue {
	keyName?: string;
	value?: unknown;
	dateTime?: string;
}

type TelemetryInputType = 'Boolean' | 'String' | 'Long' | 'Double' | 'Json' | 'DateTime';

interface TelemetryDraftRow {
	id: number;
	keyName: string;
	dataType: TelemetryInputType;
	value: any;
}

const route = useRoute();
const router = useRouter();
const userInfoStore = useUserInfo();
const { userInfos } = storeToRefs(userInfoStore);
const devices = ref<TelemetryDevice[]>([]);
const selectedDeviceId = ref(String(route.query.deviceId || ''));
const deviceName = ref('');
const onlyConnected = ref(false);
const devicesLoading = ref(false);
const summaryLoading = ref(false);
const currentPage = ref(1);
const pageSize = 20;
const totalDevices = ref(0);
const activeTab = ref<'realtime' | 'history'>('realtime');
const telemetryRefreshKey = ref(0);
const latestValues = ref<LatestTelemetryValue[]>([]);
const telemetryDialogVisible = ref(false);
const telemetrySubmitting = ref(false);
let telemetryRowId = 0;
const telemetryDraft = reactive<{ timestamp: Date; values: TelemetryDraftRow[] }>({
	timestamp: new Date(),
	values: [],
});
const telemetryTypeOptions: Array<{ label: string; value: TelemetryInputType }> = [
	{ label: '浮点数', value: 'Double' },
	{ label: '整数', value: 'Long' },
	{ label: '布尔值', value: 'Boolean' },
	{ label: '字符串', value: 'String' },
	{ label: '日期时间', value: 'DateTime' },
	{ label: 'JSON', value: 'Json' },
];

const customerId = computed(() => String(route.query.id || (userInfos.value as any).customer?.id || ''));
const selectedDevice = computed(() => devices.value.find((device) => device.id === selectedDeviceId.value));
const latestDateTime = computed(() => {
	const timestamps = latestValues.value
		.map((item) => item.dateTime ? new Date(item.dateTime).getTime() : Number.NaN)
		.filter(Number.isFinite);
	return timestamps.length ? new Date(Math.max(...timestamps)) : undefined;
});
const numericKeyCount = computed(() => latestValues.value.filter((item) => typeof item.value === 'number').length);
const onlineCount = computed(() => devices.value.filter((device) => device.connected).length);
const telemetryBadges = computed(() => [
	selectedDevice.value ? `当前：${selectedDevice.value.name || selectedDevice.value.id}` : '尚未选择设备',
	onlyConnected.value ? '仅在线设备' : '全部连接状态',
	`客户范围 ${shortId(customerId.value)}`,
]);
const telemetryMetrics = computed(() => [
	{ label: '设备总数', value: totalDevices.value, hint: '当前客户范围内可查看的设备。', tone: 'primary' as const },
	{ label: '当前页在线', value: onlineCount.value, hint: `当前页共 ${devices.value.length} 台设备。`, tone: 'success' as const },
	{ label: '最新遥测 Key', value: latestValues.value.length, hint: `其中 ${numericKeyCount.value} 个数值型测点。`, tone: 'accent' as const },
	{ label: '最近采集时间', value: latestDateTime.value ? latestDateTime.value.toLocaleTimeString('zh-CN', { hour12: false }) : '--', hint: latestDateTime.value ? latestDateTime.value.toLocaleDateString('zh-CN') : '当前设备暂无遥测。', tone: 'warning' as const },
]);

const shortId = (value: string) => !value ? '--' : value.length > 12 ? `${value.slice(0, 8)}…` : value;
const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const createTelemetryRow = (): TelemetryDraftRow => ({
	id: ++telemetryRowId,
	keyName: '',
	dataType: 'Double',
	value: '',
});

const addTelemetryRow = () => telemetryDraft.values.push(createTelemetryRow());
const removeTelemetryRow = (index: number) => telemetryDraft.values.splice(index, 1);

const resetTelemetryRowValue = (row: TelemetryDraftRow) => {
	if (row.dataType === 'Boolean') row.value = false;
	else if (row.dataType === 'DateTime') row.value = new Date();
	else if (row.dataType === 'Json') row.value = '{}';
	else row.value = '';
};

const telemetryValuePlaceholder = (dataType: TelemetryInputType) => {
	if (dataType === 'Double') return '例如 23.5';
	if (dataType === 'Long') return '例如 1200';
	if (dataType === 'Json') return '例如 {"status":"running"}';
	return '请输入值';
};

const openTelemetryDialog = () => {
	if (!selectedDeviceId.value) {
		ElMessage.warning(totalDevices.value === 0 ? '当前客户还没有设备，请先新增设备' : '请先从左侧选择设备');
		if (totalDevices.value === 0) router.push('/iot/devices/devicelist');
		return;
	}
	telemetryDraft.timestamp = new Date();
	telemetryDraft.values = [createTelemetryRow()];
	telemetryDialogVisible.value = true;
};

const parseTelemetryDraftValue = (row: TelemetryDraftRow) => {
	if (row.dataType === 'Boolean') return Boolean(row.value);
	if (row.dataType === 'DateTime') {
		if (!(row.value instanceof Date) || Number.isNaN(row.value.getTime())) throw new Error('请选择有效日期时间');
		return row.value.toISOString();
	}
	const text = String(row.value ?? '').trim();
	if (!text) throw new Error('值不能为空');
	if (row.dataType === 'Long') {
		if (!/^[+-]?\d+$/.test(text)) throw new Error('请输入整数');
		return text;
	}
	if (row.dataType === 'Double') {
		const value = Number(text);
		if (!Number.isFinite(value)) throw new Error('请输入有效数值');
		return text;
	}
	if (row.dataType === 'Json') {
		try { return JSON.parse(text); }
		catch { throw new Error('请输入合法 JSON'); }
	}
	return String(row.value ?? '');
};

const waitForTelemetry = async (keys: string[], submittedAt: number) => {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await delay(attempt === 0 ? 160 : 280);
		const response = await deviceApi().getDeviceLatestTelemetry(selectedDeviceId.value);
		const current = Array.isArray(response.data) ? response.data : [];
		latestValues.value = current;
		const stored = keys.every((key) => current.some((item: LatestTelemetryValue) =>
			item.keyName === key && item.dateTime && new Date(item.dateTime).getTime() >= submittedAt));
		if (stored) return;
	}
};

const submitTelemetry = async () => {
	if (!selectedDeviceId.value || telemetryDraft.values.length === 0) return;
	const keys = new Set<string>();
	let payloadValues: Array<{ keyName: string; dataType: TelemetryInputType; value: unknown }>;
	try {
		payloadValues = telemetryDraft.values.map((row) => {
			const keyName = row.keyName.trim();
			if (!keyName) throw new Error('遥测 Key 不能为空');
			const normalizedKey = keyName.toLocaleLowerCase();
			if (keys.has(normalizedKey)) throw new Error(`遥测 Key ${keyName} 重复`);
			keys.add(normalizedKey);
			return { keyName, dataType: row.dataType, value: parseTelemetryDraftValue(row) };
		});
	} catch (error: any) {
		ElMessage.warning(error?.message || '请检查遥测数据');
		return;
	}

	telemetrySubmitting.value = true;
	const submittedAt = Date.now() - 5000;
	try {
		await deviceApi().addDeviceTelemetry(selectedDeviceId.value, {
			timestamp: telemetryDraft.timestamp.toISOString(),
			values: payloadValues,
		});
		telemetryDialogVisible.value = false;
		activeTab.value = 'realtime';
		await waitForTelemetry(payloadValues.map((item) => item.keyName), submittedAt);
		telemetryRefreshKey.value += 1;
		ElMessage.success(`已新增 ${payloadValues.length} 项遥测数据`);
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || '遥测数据新增失败');
	} finally {
		telemetrySubmitting.value = false;
	}
};

const loadLatestSummary = async () => {
	latestValues.value = [];
	if (!selectedDeviceId.value) return;
	summaryLoading.value = true;
	try {
		const response = await deviceApi().getDeviceLatestTelemetry(selectedDeviceId.value);
		latestValues.value = Array.isArray(response.data) ? response.data : [];
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || '最新遥测加载失败');
	} finally {
		summaryLoading.value = false;
	}
};

const loadDevices = async (page = currentPage.value) => {
	currentPage.value = page;
	devicesLoading.value = true;
	try {
		const response = await deviceApi().devcieList({
			offset: page - 1,
			limit: pageSize,
			customerId: customerId.value,
			name: deviceName.value.trim(),
			onlyConnected: onlyConnected.value,
		});
		devices.value = (response.data?.rows || []).map((device: any) => ({ ...device, id: String(device.id) }));
		totalDevices.value = Number(response.data?.total || 0);
		if (!devices.value.some((device) => device.id === selectedDeviceId.value)) selectedDeviceId.value = devices.value[0]?.id || '';
	} catch (error: any) {
		devices.value = [];
		totalDevices.value = 0;
		ElMessage.error(error?.msg || error?.message || '设备列表加载失败');
	} finally {
		devicesLoading.value = false;
	}
};

const refreshTelemetry = async () => {
	telemetryRefreshKey.value += 1;
	await loadLatestSummary();
};

watch(selectedDeviceId, async (value) => {
	activeTab.value = 'realtime';
	telemetryRefreshKey.value += 1;
	if (String(route.query.deviceId || '') !== value) {
		await router.replace({ query: { ...route.query, deviceId: value || undefined } });
	}
	await loadLatestSummary();
});

onMounted(async () => {
	await loadDevices(1);
	if (selectedDeviceId.value) await loadLatestSummary();
});
</script>

<style scoped lang="scss">
.telemetry-page {
	--device-detail-pane-height: 560px;
}

.telemetry-workspace {
	display: grid;
	grid-template-columns: 300px minmax(0, 1fr);
	min-height: 680px;
	border: 1px solid rgba(203, 213, 225, 0.8);
	border-radius: 26px;
	background: #fff;
	box-shadow: 0 16px 38px rgba(15, 23, 42, 0.06);
	overflow: hidden;
}

.telemetry-device-panel {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: 16px;
	padding: 22px;
	border-right: 1px solid #e2e8f0;
	background: linear-gradient(180deg, #f8fbff, #f1f6fc);
}

.telemetry-panel__head,
.telemetry-selected-device,
.telemetry-filter-switch {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.telemetry-panel__head span,
.telemetry-selected-device span {
	color: #2563eb;
	font-size: 11px;
	font-weight: 800;
	letter-spacing: 0.14em;
}

.telemetry-panel__head h3,
.telemetry-selected-device h2 {
	margin: 5px 0 0;
	color: #123b6d;
}

.telemetry-device-filters {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.telemetry-filter-switch {
	color: #64748b;
	font-size: 12px;
}

.telemetry-device-list {
	display: flex;
	min-height: 360px;
	flex: 1;
	flex-direction: column;
	gap: 8px;
}

.telemetry-device-item {
	display: grid;
	grid-template-columns: 10px minmax(0, 1fr);
	align-items: center;
	gap: 10px;
	width: 100%;
	padding: 12px;
	border: 1px solid transparent;
	border-radius: 14px;
	background: rgba(255, 255, 255, 0.78);
	color: inherit;
	text-align: left;
	cursor: pointer;
	transition: 0.18s ease;
}

.telemetry-device-item:hover,
.telemetry-device-item.is-active {
	border-color: #93c5fd;
	background: #fff;
	box-shadow: 0 8px 20px rgba(37, 99, 235, 0.1);
}

.telemetry-device-item i {
	width: 8px;
	height: 8px;
	border-radius: 50%;
}

.telemetry-device-item i.is-online { background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12); }
.telemetry-device-item i.is-offline { background: #94a3b8; }
.telemetry-device-item span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.telemetry-device-item strong { overflow: hidden; color: #1e3a5f; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.telemetry-device-item small { color: #7c8da1; font-size: 11px; }

.telemetry-device-panel :deep(.el-pagination) {
	justify-content: center;
}

.telemetry-data-panel {
	min-width: 0;
	padding: 24px 26px;
}

.telemetry-selected-device {
	padding-bottom: 18px;
	border-bottom: 1px solid #e2e8f0;
}

.telemetry-selected-device p {
	margin: 6px 0 0;
	color: #94a3b8;
	font-size: 11px;
}

.telemetry-selected-device__tags {
	display: flex;
	gap: 8px;
}

.telemetry-tabs {
	margin-top: 14px;
}

.telemetry-tabs :deep(.el-tabs__item) {
	font-weight: 700;
}

.telemetry-action-wrapper {
	display: inline-flex;
}

:global(.telemetry-create-summary) {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 18px;
	margin-bottom: 16px;
	padding: 14px 16px;
	border-radius: 14px;
	background: #f5f8fc;
}

:global(.telemetry-create-summary > div) { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
:global(.telemetry-create-summary span) { color: #64748b; font-size: 11px; }
:global(.telemetry-create-summary strong) { color: #123b6d; }
:global(.telemetry-create-summary small) { overflow: hidden; color: #94a3b8; text-overflow: ellipsis; }

:global(.telemetry-create-table) {
	display: flex;
	max-height: 390px;
	margin-top: 16px;
	flex-direction: column;
	gap: 10px;
	overflow-y: auto;
}

:global(.telemetry-create-row) {
	display: grid;
	grid-template-columns: minmax(150px, 1fr) 120px minmax(220px, 1.4fr) 54px;
	align-items: center;
	gap: 10px;
}

:global(.telemetry-create-row--head) { padding: 0 2px; color: #64748b; font-size: 12px; font-weight: 700; }
:global(.telemetry-create-row .el-date-editor) { width: 100%; }
:global(.telemetry-add-row) { width: 100%; margin-top: 14px; }

@media (max-width: 980px) {
	.telemetry-workspace { grid-template-columns: 1fr; }
	.telemetry-device-panel { border-right: 0; border-bottom: 1px solid #e2e8f0; }
	.telemetry-device-list { max-height: 320px; min-height: 220px; overflow: auto; }
}
</style>
