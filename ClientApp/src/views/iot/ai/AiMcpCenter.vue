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
										<el-input :model-value="scopeLabel" disabled />
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
								<el-tag effect="plain">{{ mcpTools.length }} tools</el-tag>
							</div>
							<el-table :data="mcpTools" stripe>
								<el-table-column prop="name" label="工具" min-width="180" />
								<el-table-column prop="capability" label="能力" min-width="220" />
								<el-table-column prop="scope" label="数据范围" min-width="180" />
								<el-table-column label="类型" width="100"><template #default><el-tag size="small" type="success">只读</el-tag></template></el-table-column>
							</el-table>
						</section>
					</el-tab-pane>
				</el-tabs>
			</section>
		</ConsolePageShell>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { storeToRefs } from 'pinia';
import ConsolePageShell from '/@/components/console/ConsolePageShell.vue';
import { aiApi, type AiSettingsScope } from '/@/api/ai';
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

const normalizedRoles = computed(() => (userInfos.value.roles || [])
	.flatMap((value: unknown) => String(value).split(','))
	.map((value: string) => value.trim().toLowerCase())
	.filter(Boolean));
const customerId = computed(() => String((userInfos.value as any).customer?.id || ''));
const tenantId = computed(() => String((userInfos.value as any).tenant?.id || ''));
const isCustomerAdmin = computed(() => normalizedRoles.value.includes('customeradmin') && Boolean(customerId.value));
const isTenantAdmin = computed(() => normalizedRoles.value.includes('tenantadmin') && Boolean(tenantId.value));
const canManage = computed(() => isCustomerAdmin.value || isTenantAdmin.value);
const scope = computed<AiSettingsScope>(() => isCustomerAdmin.value ? 'customer' : 'tenant');
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
const badges = computed(() => [scopeLabel.value, settings.enable ? 'MCP 已启用' : 'MCP 已停用', `${mcpTools.length} 个只读工具`]);
const metrics = computed(() => [
	{ label: 'AI 接入状态', value: settings.enable ? '可用' : '停用', hint: '由当前作用域 AISettings 控制。', tone: settings.enable ? 'success' as const : 'warning' as const },
	{ label: 'MCP 工具', value: mcpTools.length, hint: '设备和属性只读查询能力。', tone: 'primary' as const },
	{ label: '访问范围', value: scope.value === 'customer' ? '客户' : '租户', hint: 'API Key 不会越过当前数据范围。', tone: 'accent' as const },
	{ label: '传输协议', value: 'HTTP', hint: 'MCP Streamable HTTP，无状态服务。', tone: 'primary' as const },
]);

const mcpTools = [
	{ name: 'echo', capability: '验证客户端连接和协议会话', scope: '无业务数据' },
	{ name: 'DevicesList', capability: '查询当前范围内的设备清单', scope: '客户或租户设备' },
	{ name: 'GetDeviceStatus', capability: '查询指定设备当前连接状态', scope: '客户或租户设备' },
	{ name: 'GetDeviceAttributes', capability: '查询指定设备的全部最新属性', scope: '客户或租户设备' },
	{ name: 'GetDeviceAttribute', capability: '查询指定设备的单个最新属性', scope: '客户或租户设备' },
];
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
@media (max-width: 1050px) { .mcp-layout,.ai-boundary-panel { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .ai-overview-grid { grid-template-columns: 1fr; } .ai-center-card,.mcp-tools-panel { padding: 16px; border-radius: 20px; } }
</style>
