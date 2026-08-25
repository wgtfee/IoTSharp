<template>
	<div class="ai-center-page">
		<ConsolePageShell
			eyebrow="AI CONTROL PLANE"
			title="AI 与 MCP 能力中心"
			description="通过租户隔离的 MCP 服务把 IoTSharp 设备、状态和属性能力提供给 AI 客户端；密钥、开关和作用域均由平台控制。"
			:badges="badges"
			:metrics="metrics"
		>
			<template #actions>
				<el-button type="primary" :loading="loading" @click="loadSettings">刷新状态</el-button>
				<el-button v-if="activeTab !== 'mcp'" @click="activeTab = 'mcp'">配置 MCP</el-button>
			</template>

			<el-alert
				v-if="!canManage"
				title="当前账号没有 AI/MCP 管理权限"
				description="需要 CustomerAdmin 或 TenantAdmin 角色。普通设备用户仍可使用管理员已经配置好的受控能力。"
				type="warning"
				:closable="false"
				show-icon
			/>

			<section class="ai-center-card">
				<el-tabs v-model="activeTab" class="ai-center-tabs">
					<el-tab-pane name="overview" label="AI 功能">
						<div class="ai-overview-grid">
							<article v-for="feature in aiFeatures" :key="feature.title" class="ai-feature-card">
								<div class="ai-feature-card__icon">{{ feature.icon }}</div>
								<div>
									<h3>{{ feature.title }}</h3>
									<p>{{ feature.description }}</p>
									<el-button text type="primary" @click="copyText(feature.prompt, '示例问题已复制')">复制示例问题</el-button>
								</div>
							</article>
						</div>

						<div class="ai-boundary-panel">
							<div>
								<span>当前实现边界</span>
								<h3>AI 客户端通过 MCP 使用 IoTSharp 能力</h3>
								<p>平台当前已经实现设备清单、在线状态和属性查询工具。大模型由支持 Streamable HTTP MCP 的客户端提供，IoTSharp 负责身份范围、数据隔离和工具执行。</p>
							</div>
							<el-steps :active="settings.enable && settings.mcpApiKey ? 3 : 1" finish-status="success" simple>
								<el-step title="启用能力" />
								<el-step title="连接 AI 客户端" />
								<el-step title="调用受控工具" />
							</el-steps>
						</div>
					</el-tab-pane>

					<el-tab-pane name="mcp" label="MCP 服务">
						<div class="mcp-layout">
							<section class="mcp-settings-panel">
								<div class="panel-heading">
									<div><span>ACCESS SETTINGS</span><h3>服务配置</h3></div>
									<el-tag :type="settings.enable ? 'success' : 'info'">{{ settings.enable ? '已启用' : '已停用' }}</el-tag>
								</div>

								<el-form label-position="top" :model="settings">
									<el-form-item label="配置名称">
										<el-input v-model="settings.name" maxlength="80" placeholder="例如：生产环境 AI 接入" />
									</el-form-item>
									<el-form-item label="MCP 服务状态">
										<el-switch v-model="settings.enable" active-text="允许连接" inactive-text="禁止连接" />
									</el-form-item>
									<el-form-item label="作用域">
										<el-radio-group v-if="isCustomerAdmin && isTenantAdmin" v-model="selectedScope" @change="loadSettings">
											<el-radio-button value="customer">当前客户</el-radio-button>
											<el-radio-button value="tenant">当前租户</el-radio-button>
										</el-radio-group>
										<el-input v-else :model-value="scopeLabel" disabled />
									</el-form-item>
									<el-form-item label="MCP API Key">
										<el-input :model-value="visibleApiKey" readonly>
											<template #append><el-button @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</el-button></template>
										</el-input>
									</el-form-item>
									<div class="mcp-form-actions">
										<el-button type="primary" :loading="saving" :disabled="!canManage" @click="saveSettings(false)">保存设置</el-button>
										<el-button :loading="saving" :disabled="!canManage" @click="rotateApiKey">轮换密钥</el-button>
									</div>
								</el-form>
							</section>

							<section class="mcp-connection-panel">
								<div class="panel-heading">
									<div><span>CLIENT CONNECTION</span><h3>客户端接入</h3></div>
									<el-button size="small" :loading="testing" :disabled="!mcpEndpointReady" @click="testMcpConnection">测试连接</el-button>
								</div>
								<label>MCP Endpoint</label>
								<div class="copy-row"><code>{{ displayEndpoint }}</code><el-button size="small" @click="copyText(mcpEndpoint, 'MCP 地址已复制')">复制</el-button></div>
								<label>Streamable HTTP 配置</label>
								<div class="client-config"><pre>{{ clientConfig }}</pre><el-button size="small" @click="copyText(clientConfig, '客户端配置已复制')">复制配置</el-button></div>
								<el-alert title="API Key 等同于当前作用域的 AI 访问凭据；轮换后旧客户端会立即失效。" type="warning" :closable="false" show-icon />
							</section>
						</div>

						<section class="mcp-tools-panel">
							<div class="panel-heading">
								<div><span>TOOL CATALOG</span><h3>已注册 MCP 工具</h3></div>
								<div class="tool-heading-actions">
									<el-tag effect="plain">{{ mcpTools.length }} tools</el-tag>
									<el-button type="primary" :disabled="!canManage || !settings.mcpApiKey" @click="openToolEditor()">新增 Tool</el-button>
								</div>
							</div>
							<el-alert v-if="canManage && !settings.mcpApiKey" title="请先保存 MCP 服务设置，生成 API Key 后即可新增动态 Tool。" type="info" :closable="false" show-icon />
							<el-table v-loading="toolsLoading" :data="mcpTools" stripe>
								<el-table-column label="工具" min-width="190">
									<template #default="{ row }"><strong>{{ row.name }}</strong><small class="tool-subtitle">{{ row.title || row.capability }}</small></template>
								</el-table-column>
								<el-table-column prop="capability" label="能力 / Endpoint" min-width="280" show-overflow-tooltip />
								<el-table-column label="来源" width="110"><template #default="{ row }"><el-tag size="small" :type="row.source === 'builtin' ? 'info' : 'primary'">{{ row.source === 'builtin' ? '内置' : '数据库' }}</el-tag></template></el-table-column>
								<el-table-column label="方法" width="90"><template #default="{ row }">{{ row.httpMethod || '--' }}</template></el-table-column>
								<el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
								<el-table-column label="操作" width="236" fixed="right">
									<template #default="{ row }">
										<template v-if="row.source === 'dynamic'">
											<el-button link type="primary" @click="openToolEditor(row.raw)">编辑</el-button>
											<el-button link type="success" @click="openToolTest(row.raw)">测试</el-button>
											<el-button link @click="openInvocations(row.raw)">记录</el-button>
											<el-button link type="danger" @click="deleteTool(row.raw)">删除</el-button>
										</template>
										<span v-else class="builtin-lock">代码注册</span>
									</template>
								</el-table-column>
							</el-table>
						</section>
					</el-tab-pane>
				</el-tabs>
			</section>
		</ConsolePageShell>

		<el-dialog v-model="toolEditorVisible" :title="editingToolId ? '编辑动态 MCP Tool' : '新增动态 MCP Tool'" width="780px" destroy-on-close>
			<el-form label-position="top" :model="toolForm">
				<div class="tool-form-grid">
					<el-form-item label="Tool 名称（MCP 调用名）"><el-input v-model="toolForm.name" maxlength="64" placeholder="例如：get_production_order" /></el-form-item>
					<el-form-item label="显示名称"><el-input v-model="toolForm.title" maxlength="128" placeholder="例如：查询生产订单" /></el-form-item>
				</div>
				<el-form-item label="能力说明"><el-input v-model="toolForm.description" type="textarea" :rows="2" maxlength="2048" show-word-limit placeholder="清楚说明 AI 何时应调用该工具及返回什么结果" /></el-form-item>
				<div class="tool-form-grid tool-form-grid--http">
					<el-form-item label="HTTP Method"><el-select v-model="toolForm.httpMethod"><el-option v-for="method in httpMethods" :key="method" :label="method" :value="method" /></el-select></el-form-item>
					<el-form-item label="超时（秒）"><el-input-number v-model="toolForm.timeoutSeconds" :min="1" :max="60" controls-position="right" /></el-form-item>
				</div>
				<el-form-item label="Endpoint Template">
					<el-input v-model="toolForm.endpointTemplate" placeholder="https://api.example.com/devices/{deviceId}/status" />
					<div class="form-hint">花括号参数必须在下方 Schema 的 properties 中定义。GET/DELETE 的其余参数拼入查询串，其他方法写入 JSON Body。</div>
				</el-form-item>
				<el-form-item label="输入 JSON Schema">
					<el-input v-model="toolForm.inputSchemaJson" type="textarea" :rows="9" class="code-editor" />
				</el-form-item>
				<el-form-item label="固定请求头（JSON，保存后不回显）">
					<el-input v-model="toolForm.headersJson" type="textarea" :rows="3" class="code-editor" :placeholder="headersPlaceholder" />
					<div class="form-hint">适合填写 Authorization 或 X-API-Key。空白表示编辑时保留原密钥；填写 {} 会清空。请求头使用平台数据保护密钥加密入库。</div>
				</el-form-item>
				<div class="tool-switches">
					<el-switch v-model="toolForm.enabled" active-text="启用 Tool" />
					<el-switch v-model="toolForm.readOnlyHint" active-text="标记为只读" />
					<el-switch v-model="toolForm.allowPrivateNetwork" active-text="允许访问内网 API" />
				</div>
				<el-alert v-if="toolForm.allowPrivateNetwork" title="仅对可信工业内网地址启用。该 Tool 将能够访问本机或私有网段 API。" type="warning" :closable="false" show-icon />
			</el-form>
			<template #footer><el-button @click="toolEditorVisible = false">取消</el-button><el-button type="primary" :loading="toolSaving" @click="saveTool">保存 Tool</el-button></template>
		</el-dialog>

		<el-dialog v-model="toolTestVisible" :title="`测试 Tool · ${testingTool?.name || ''}`" width="720px" destroy-on-close>
			<el-alert title="测试会真实调用目标 API，并写入执行审计。" type="warning" :closable="false" show-icon />
			<label class="dialog-label">调用参数（JSON Object）</label>
			<el-input v-model="testArgumentsJson" type="textarea" :rows="8" class="code-editor" />
			<div v-if="testResult" class="test-result" :class="{ 'test-result--error': !testResult.succeeded }">
				<div><strong>{{ testResult.succeeded ? '调用成功' : '调用失败' }}</strong><span>HTTP {{ testResult.statusCode || '--' }} · {{ testResult.durationMs }} ms</span></div>
				<pre>{{ testResult.succeeded ? testResult.body : testResult.errorMessage }}</pre>
			</div>
			<template #footer><el-button @click="toolTestVisible = false">关闭</el-button><el-button type="primary" :loading="toolTesting" @click="runToolTest">执行测试</el-button></template>
		</el-dialog>

		<el-drawer v-model="invocationsVisible" :title="`执行记录 · ${invocationToolName}`" size="650px">
			<el-table v-loading="invocationsLoading" :data="invocations" stripe>
				<el-table-column label="时间" min-width="170"><template #default="{ row }">{{ formatDate(row.startedAt) }}</template></el-table-column>
				<el-table-column prop="invocationSource" label="来源" width="100" />
				<el-table-column prop="argumentKeys" label="参数名" min-width="130" show-overflow-tooltip />
				<el-table-column label="结果" width="90"><template #default="{ row }"><el-tag size="small" :type="row.succeeded ? 'success' : 'danger'">{{ row.succeeded ? '成功' : '失败' }}</el-tag></template></el-table-column>
				<el-table-column label="耗时" width="90"><template #default="{ row }">{{ row.durationMs }} ms</template></el-table-column>
			</el-table>
		</el-drawer>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { storeToRefs } from 'pinia';
import ConsolePageShell from '/@/components/console/ConsolePageShell.vue';
import {
	aiApi,
	type AiSettingsScope,
	type McpToolDefinition,
	type McpToolExecutionResult,
	type McpToolInvocation,
	type SaveMcpToolDefinition,
} from '/@/api/ai';
import { useUserInfo } from '/@/stores/userInfo';

const props = withDefaults(defineProps<{ initialTab?: 'overview' | 'mcp' }>(), { initialTab: 'overview' });
const userInfoStore = useUserInfo();
const { userInfos } = storeToRefs(userInfoStore);
const activeTab = ref<'overview' | 'mcp'>(props.initialTab);
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const showApiKey = ref(false);
const settings = reactive({ name: 'IoTSharp AI 接入', enable: true, mcpApiKey: '' });
const toolsLoading = ref(false);
const toolSaving = ref(false);
const dynamicTools = ref<McpToolDefinition[]>([]);
const toolEditorVisible = ref(false);
const editingToolId = ref('');
const editingHasHeaders = ref(false);
const toolTestVisible = ref(false);
const toolTesting = ref(false);
const testingTool = ref<McpToolDefinition>();
const testArgumentsJson = ref('{}');
const testResult = ref<McpToolExecutionResult>();
const invocationsVisible = ref(false);
const invocationsLoading = ref(false);
const invocationToolName = ref('');
const invocations = ref<McpToolInvocation[]>([]);
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const defaultInputSchema = JSON.stringify({
	type: 'object',
	properties: {
		deviceId: { type: 'string', description: '设备 ID' },
	},
	required: ['deviceId'],
}, null, 2);
const toolForm = reactive({
	name: '',
	title: '',
	description: '',
	httpMethod: 'GET',
	endpointTemplate: '',
	inputSchemaJson: defaultInputSchema,
	headersJson: '',
	timeoutSeconds: 15,
	enabled: true,
	readOnlyHint: true,
	allowPrivateNetwork: false,
});

const normalizedRoles = computed(() => (userInfos.value.roles || [])
	.flatMap((value: unknown) => String(value).split(','))
	.map((value: string) => value.trim().toLowerCase())
	.filter(Boolean));
const customerId = computed(() => String((userInfos.value as any).customer?.id || ''));
const tenantId = computed(() => String((userInfos.value as any).tenant?.id || ''));
const isCustomerAdmin = computed(() => normalizedRoles.value.includes('customeradmin') && Boolean(customerId.value));
const isTenantAdmin = computed(() => normalizedRoles.value.includes('tenantadmin') && Boolean(tenantId.value));
const canManage = computed(() => isCustomerAdmin.value || isTenantAdmin.value);
const selectedScope = ref<AiSettingsScope>('customer');
const scope = computed<AiSettingsScope>(() => selectedScope.value === 'customer' && isCustomerAdmin.value ? 'customer' : 'tenant');
const scopeId = computed(() => scope.value === 'customer' ? customerId.value : tenantId.value);
const scopeLabel = computed(() => `${scope.value === 'customer' ? '客户' : '租户'} · ${shortId(scopeId.value)}`);
const publicMcpBase = computed(() => String(import.meta.env.VITE_MCP_PUBLIC_URL || `${window.location.origin}/mcp`).replace(/\/$/, ''));
const mcpEndpoint = computed(() => settings.mcpApiKey ? `${publicMcpBase.value}/${settings.mcpApiKey}` : publicMcpBase.value);
const mcpEndpointReady = computed(() => settings.enable && Boolean(settings.mcpApiKey));
const visibleApiKey = computed(() => !settings.mcpApiKey ? '尚未生成' : showApiKey.value ? settings.mcpApiKey : `${settings.mcpApiKey.slice(0, 6)}••••••••••••${settings.mcpApiKey.slice(-4)}`);
const displayEndpoint = computed(() => !settings.mcpApiKey || showApiKey.value ? mcpEndpoint.value : `${publicMcpBase.value}/${visibleApiKey.value}`);
const clientConfig = computed(() => JSON.stringify({
	mcpServers: {
		iotsharp: {
			type: 'streamable-http',
			url: mcpEndpoint.value,
		},
	},
}, null, 2));
const badges = computed(() => [scopeLabel.value, settings.enable ? 'MCP 已启用' : 'MCP 已停用', `${mcpTools.value.length} 个工具`]);
const metrics = computed(() => [
	{ label: 'AI 接入状态', value: settings.enable ? '可用' : '停用', hint: '由当前作用域 AISettings 控制。', tone: settings.enable ? 'success' as const : 'warning' as const },
	{ label: 'MCP 工具', value: mcpTools.value.length, hint: `内置 5 个，动态 ${dynamicTools.value.length} 个。`, tone: 'primary' as const },
	{ label: '访问范围', value: scope.value === 'customer' ? '客户' : '租户', hint: 'API Key 不会越过当前数据范围。', tone: 'accent' as const },
	{ label: '传输协议', value: 'HTTP', hint: 'MCP Streamable HTTP，无状态服务。', tone: 'primary' as const },
]);

const builtInTools = [
	{ name: 'echo', title: '连接验证', capability: '验证客户端连接和协议会话' },
	{ name: 'DevicesList', title: '设备清单', capability: '查询当前范围内的设备清单' },
	{ name: 'GetDeviceStatus', title: '设备状态', capability: '查询指定设备当前连接状态' },
	{ name: 'GetDeviceAttributes', title: '全部属性', capability: '查询指定设备的全部最新属性' },
	{ name: 'GetDeviceAttribute', title: '单个属性', capability: '查询指定设备的单个最新属性' },
];
const mcpTools = computed(() => [
	...builtInTools.map((tool) => ({ ...tool, source: 'builtin', enabled: true, httpMethod: '', raw: null })),
	...dynamicTools.value.map((tool) => ({
		name: tool.name,
		title: tool.title,
		capability: `${tool.httpMethod} ${tool.endpointTemplate}`,
		source: 'dynamic',
		enabled: tool.enabled,
		httpMethod: tool.httpMethod,
		raw: tool,
	})),
]);
const headersPlaceholder = computed(() => editingHasHeaders.value
	? '已保存加密请求头；留空保持不变，填写 {} 清空'
	: '{\n  "Authorization": "Bearer ..."\n}');
const aiFeatures = [
	{ icon: '01', title: '设备清单问答', description: '让 AI 在当前客户或租户范围内了解已有设备和设备类型。', prompt: '请列出 IoTSharp 中的所有设备，并按设备类型分组。' },
	{ icon: '02', title: '在线状态诊断', description: '查询设备连接状态，辅助定位离线设备和运行异常。', prompt: '请检查我的设备在线状态，并列出当前离线的设备。' },
	{ icon: '03', title: '属性查询', description: '读取设备最新属性，为运维问答和现场判断提供上下文。', prompt: '请读取指定设备的最新属性，并解释哪些值值得关注。' },
	{ icon: '04', title: '受控 AI 接入', description: '通过作用域密钥约束 AI 客户端，避免绕过 IoTSharp 权限边界。', prompt: '请先说明你可以使用哪些 IoTSharp MCP 工具，再执行只读检查。' },
];

function shortId(value: string) {
	return !value ? '--' : value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

async function loadSettings() {
	if (!canManage.value || !scopeId.value) return;
	loading.value = true;
	try {
		const value = await aiApi().getSettings(scope.value, scopeId.value);
		settings.name = value.name && value.name !== 'None' ? value.name : 'IoTSharp AI 接入';
		settings.enable = value.enable;
		settings.mcpApiKey = value.mcpApiKey;
		await loadTools();
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || 'AI/MCP 配置加载失败');
	} finally {
		loading.value = false;
	}
}

async function saveSettings(regenerateApiKey: boolean) {
	if (!canManage.value || !scopeId.value) return;
	saving.value = true;
	try {
		const value = await aiApi().saveSettings(scope.value, scopeId.value, {
			name: settings.name.trim() || 'IoTSharp AI 接入',
			enable: settings.enable,
			regenerateApiKey,
		});
		Object.assign(settings, value);
		await loadTools();
		ElMessage.success(regenerateApiKey ? 'MCP 密钥已轮换，旧客户端已失效' : 'AI/MCP 设置已保存');
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || 'AI/MCP 设置保存失败');
	} finally {
		saving.value = false;
	}
}

async function rotateApiKey() {
	await ElMessageBox.confirm('轮换密钥后，所有使用旧地址的 AI 客户端会立即失效。确定继续吗？', '轮换 MCP API Key', { type: 'warning' });
	await saveSettings(true);
}

async function copyText(value: string, message: string) {
	try {
		await navigator.clipboard.writeText(value);
		ElMessage.success(message);
	} catch {
		ElMessage.error('浏览器不允许访问剪贴板，请手动复制');
	}
}

async function testMcpConnection() {
	if (!mcpEndpointReady.value) return;
	testing.value = true;
	try {
		const response = await fetch(mcpEndpoint.value, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'IoTSharp Console', version: '1.0.0' } },
			}),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		ElMessage.success('MCP 服务连接成功');
	} catch (error: any) {
		ElMessage.error(`MCP 连接失败：${error?.message || '未知错误'}`);
	} finally {
		testing.value = false;
	}
}

async function loadTools() {
	if (!canManage.value || !scopeId.value || !settings.mcpApiKey) {
		dynamicTools.value = [];
		return;
	}
	toolsLoading.value = true;
	try {
		dynamicTools.value = await aiApi().getTools(scope.value, scopeId.value);
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || '动态 Tool 加载失败');
	} finally {
		toolsLoading.value = false;
	}
}

function resetToolForm() {
	Object.assign(toolForm, {
		name: '', title: '', description: '', httpMethod: 'GET', endpointTemplate: '',
		inputSchemaJson: defaultInputSchema, headersJson: '', timeoutSeconds: 15,
		enabled: true, readOnlyHint: true, allowPrivateNetwork: false,
	});
	editingToolId.value = '';
	editingHasHeaders.value = false;
}

function openToolEditor(tool?: McpToolDefinition) {
	resetToolForm();
	if (tool) {
		editingToolId.value = tool.id;
		editingHasHeaders.value = tool.hasProtectedHeaders;
		Object.assign(toolForm, {
			name: tool.name,
			title: tool.title,
			description: tool.description,
			httpMethod: tool.httpMethod,
			endpointTemplate: tool.endpointTemplate,
			inputSchemaJson: prettyJson(tool.inputSchemaJson),
			headersJson: '',
			timeoutSeconds: tool.timeoutSeconds,
			enabled: tool.enabled,
			readOnlyHint: tool.readOnlyHint,
			allowPrivateNetwork: tool.allowPrivateNetwork,
		});
	}
	toolEditorVisible.value = true;
}

async function saveTool() {
	if (!toolForm.name.trim() || !toolForm.title.trim() || !toolForm.description.trim() || !toolForm.endpointTemplate.trim()) {
		ElMessage.warning('请填写 Tool 名称、显示名称、能力说明和 Endpoint');
		return;
	}
	try {
		const schema = JSON.parse(toolForm.inputSchemaJson);
		if (!schema || schema.type !== 'object') throw new Error('Schema 根节点 type 必须为 object');
		const headerText = toolForm.headersJson.trim();
		if (headerText) {
			const headers = JSON.parse(headerText);
			if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('固定请求头必须是 JSON Object');
		}
		const payload: SaveMcpToolDefinition = {
			name: toolForm.name.trim(),
			title: toolForm.title.trim(),
			description: toolForm.description.trim(),
			handlerType: 'HttpApi',
			inputSchemaJson: JSON.stringify(schema),
			httpMethod: toolForm.httpMethod,
			endpointTemplate: toolForm.endpointTemplate.trim(),
			headersJson: editingToolId.value && !headerText ? null : (headerText || '{}'),
			timeoutSeconds: toolForm.timeoutSeconds,
			enabled: toolForm.enabled,
			readOnlyHint: toolForm.readOnlyHint,
			allowPrivateNetwork: toolForm.allowPrivateNetwork,
		};
		toolSaving.value = true;
		if (editingToolId.value) await aiApi().updateTool(scope.value, scopeId.value, editingToolId.value, payload);
		else await aiApi().createTool(scope.value, scopeId.value, payload);
		ElMessage.success(editingToolId.value ? 'Tool 已更新' : 'Tool 已创建并写入数据库');
		toolEditorVisible.value = false;
		await loadTools();
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || 'Tool 保存失败');
	} finally {
		toolSaving.value = false;
	}
}

async function deleteTool(tool: McpToolDefinition) {
	await ElMessageBox.confirm(`删除动态 Tool“${tool.name}”？历史执行记录仍保留在数据库。`, '删除 MCP Tool', { type: 'warning' });
	try {
		await aiApi().deleteTool(scope.value, scopeId.value, tool.id);
		ElMessage.success('Tool 已删除');
		await loadTools();
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || 'Tool 删除失败');
	}
}

function openToolTest(tool: McpToolDefinition) {
	testingTool.value = tool;
	testArgumentsJson.value = buildSampleArguments(tool.inputSchemaJson);
	testResult.value = undefined;
	toolTestVisible.value = true;
}

async function runToolTest() {
	if (!testingTool.value) return;
	try {
		const args = JSON.parse(testArgumentsJson.value);
		if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('调用参数必须是 JSON Object');
		toolTesting.value = true;
		testResult.value = await aiApi().testTool(scope.value, scopeId.value, testingTool.value.id, args);
		ElMessage[testResult.value.succeeded ? 'success' : 'warning'](testResult.value.succeeded ? 'Tool 调用成功' : 'Tool 调用返回失败');
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || 'Tool 测试失败');
	} finally {
		toolTesting.value = false;
	}
}

async function openInvocations(tool: McpToolDefinition) {
	invocationToolName.value = tool.name;
	invocations.value = [];
	invocationsVisible.value = true;
	invocationsLoading.value = true;
	try {
		invocations.value = await aiApi().getToolInvocations(scope.value, scopeId.value, tool.id);
	} catch (error: any) {
		ElMessage.error(error?.msg || error?.message || '执行记录加载失败');
	} finally {
		invocationsLoading.value = false;
	}
}

function prettyJson(value: string) {
	try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function buildSampleArguments(schemaJson: string) {
	try {
		const schema = JSON.parse(schemaJson);
		const values: Record<string, unknown> = {};
		for (const name of schema.required || []) {
			const property = schema.properties?.[name] || {};
			values[name] = property.default ?? ({ string: '', number: 0, integer: 0, boolean: false, array: [], object: {} } as any)[property.type] ?? '';
		}
		return JSON.stringify(values, null, 2);
	} catch { return '{}'; }
}

function formatDate(value: string) {
	return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
}

onMounted(loadSettings);
</script>

<style scoped lang="scss">
.ai-center-card,
.mcp-tools-panel {
	padding: 22px 24px;
	border: 1px solid rgba(203, 213, 225, 0.82);
	border-radius: 26px;
	background: #fff;
	box-shadow: 0 16px 38px rgba(15, 23, 42, 0.06);
}

.ai-center-tabs :deep(.el-tabs__item) { font-weight: 700; }
.ai-overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 8px 0 18px; }
.ai-feature-card { display: grid; grid-template-columns: 52px 1fr; gap: 16px; padding: 20px; border: 1px solid #dbeafe; border-radius: 20px; background: linear-gradient(145deg, #f8fbff, #fff); }
.ai-feature-card__icon { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 16px; color: #fff; font-weight: 800; background: linear-gradient(135deg, #2563eb, #0ea5e9); }
.ai-feature-card h3,.ai-boundary-panel h3,.panel-heading h3 { margin: 0; color: #123b6d; }
.ai-feature-card p,.ai-boundary-panel p { color: #64748b; font-size: 13px; line-height: 1.75; }
.ai-boundary-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(420px, .8fr); align-items: center; gap: 24px; padding: 24px; border-radius: 22px; background: #f1f6fc; }
.ai-boundary-panel span,.panel-heading span { color: #2563eb; font-size: 11px; font-weight: 800; letter-spacing: .14em; }
.mcp-layout { display: grid; grid-template-columns: minmax(320px, .8fr) minmax(420px, 1.2fr); gap: 18px; padding: 8px 0 18px; }
.mcp-settings-panel,.mcp-connection-panel { padding: 20px; border: 1px solid #e2e8f0; border-radius: 20px; background: #f8fbff; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.panel-heading h3 { margin-top: 5px; }
.mcp-form-actions { display: flex; gap: 10px; }
.mcp-connection-panel label { display: block; margin: 16px 0 8px; color: #64748b; font-size: 12px; font-weight: 700; }
.copy-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.copy-row code,.client-config { min-width: 0; padding: 12px; border: 1px solid #dbeafe; border-radius: 12px; background: #fff; color: #1e3a5f; word-break: break-all; }
.client-config { position: relative; }
.client-config pre { margin: 0; overflow: auto; font-size: 12px; line-height: 1.6; }
.client-config .el-button { position: absolute; top: 8px; right: 8px; }
.mcp-connection-panel .el-alert { margin-top: 16px; }
.mcp-tools-panel { margin-top: 0; }
.mcp-tools-panel .el-alert { margin-bottom: 14px; }
.tool-heading-actions { display: flex; align-items: center; gap: 10px; }
.tool-subtitle { display: block; margin-top: 4px; color: #64748b; font-size: 12px; font-weight: 400; }
.builtin-lock { color: #94a3b8; font-size: 12px; }
.tool-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.tool-form-grid--http { grid-template-columns: minmax(180px, .45fr) minmax(180px, .55fr); }
.tool-form-grid :deep(.el-select),.tool-form-grid :deep(.el-input-number) { width: 100%; }
.form-hint { margin-top: 7px; color: #64748b; font-size: 12px; line-height: 1.6; }
.code-editor :deep(textarea) { font-family: Consolas, 'SFMono-Regular', monospace; font-size: 12px; line-height: 1.55; }
.tool-switches { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 18px; }
.dialog-label { display: block; margin: 18px 0 8px; color: #475569; font-size: 13px; font-weight: 700; }
.test-result { margin-top: 16px; padding: 16px; border: 1px solid #bbf7d0; border-radius: 14px; background: #f0fdf4; }
.test-result--error { border-color: #fecaca; background: #fef2f2; }
.test-result > div { display: flex; justify-content: space-between; gap: 12px; color: #166534; }
.test-result--error > div { color: #991b1b; }
.test-result pre { max-height: 300px; margin: 12px 0 0; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
@media (max-width: 1050px) { .mcp-layout,.ai-boundary-panel { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .ai-overview-grid,.tool-form-grid { grid-template-columns: 1fr; } .ai-center-card,.mcp-tools-panel { padding: 16px; border-radius: 20px; } }
</style>
