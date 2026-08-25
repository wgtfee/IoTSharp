<template>
	<div class="auth-page">
		<div class="auth-page__aurora"></div>
		<div class="auth-shell">
			<AuthShowcase
				eyebrow="控制台入口"
				:title="pageTitle"
				:description="showcaseDescription"
				link-to="/"
				link-label="返回入口"
				:primary-card="showcasePrimaryCard"
				:metrics="showcaseMetrics"
				:tags="showcaseTags"
			/>

			<section class="auth-panel">
				<div class="auth-panel__header">
					<div class="auth-panel__eyebrow">Sign In</div>
					<h2>登录到 {{ pageTitle }}</h2>
					<p>{{ panelDescription }}</p>
				</div>

				<div class="auth-panel__highlights">
					<div v-for="item in panelHighlights" :key="item.label" class="auth-panel__highlight">
						<span>{{ item.label }}</span>
						<strong>{{ item.value }}</strong>
						<small>{{ item.hint }}</small>
					</div>
				</div>

				<CentralAccount v-if="securityState === 'central'" />
				<Account v-else-if="securityState === 'local'" />
				<div v-else-if="securityState === 'loading'" class="auth-mode-state">
					<div class="auth-mode-state__title">正在读取认证配置</div>
					<p>正在确认当前实例使用本地认证还是统一认证中心。</p>
				</div>
				<div v-else class="auth-mode-state auth-mode-state--error">
					<div class="auth-mode-state__title">认证配置不可用</div>
					<p>{{ securityError }}</p>
					<el-button type="primary" plain @click="detectSecurityMode">重新检测</el-button>
				</div>

				<div class="auth-panel__footer">
					<div>{{ footerDescription }}</div>
					<div>{{ currentYear }} {{ pageTitle }}</div>
				</div>
			</section>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useThemeConfig } from '/@/stores/themeConfig';
import { NextLoading } from '/@/utils/loading';
import { loadSecurityProfile } from '/@/security/security-profile';
import Account from '/@/views/login/component/account.vue';
import CentralAccount from '/@/views/login/component/central-account.vue';
import AuthShowcase from '/@/views/login/component/AuthShowcase.vue';

const storesThemeConfig = useThemeConfig();
const { themeConfig } = storeToRefs(storesThemeConfig);
const securityState = ref<'loading' | 'local' | 'central' | 'error'>('loading');
const securityError = ref('无法确认认证模式。为避免误开放本地登录，当前入口已关闭。');
const centralLogin = computed(() => securityState.value === 'central');

const pageTitle = computed(() => themeConfig.value.globalTitle || 'IoTSharp');
const currentYear = new Date().getFullYear();
const panelDescription = computed(() => {
	if (securityState.value === 'central') return '通过 Industrial IAM 登录；IoTSharp 本地角色与数据范围继续负责业务授权。';
	if (securityState.value === 'local') return '当前实例使用本地认证。输入账号和密码，完成验证码后进入控制台。';
	if (securityState.value === 'error') return '无法读取后端认证配置，本地登录不会自动降级开放。';
	return '正在确认当前实例的认证方式。';
});
const footerDescription = computed(() => {
	if (securityState.value === 'central') return '统一身份已启用；Shadow 阶段不改变 IoT 本地业务授权。';
	if (securityState.value === 'local') return '本地认证已启用；建议首次登录后立即修改默认密码。';
	return '认证模式必须由后端配置明确确认。';
});
const showcaseDescription = computed(() => centralLogin.value
	? 'Industrial IAM 统一登录入口；本地 IoTSharp 角色、Customer/Tenant 与设备范围继续保留。'
	: securityState.value === 'local'
		? '当前实例使用 IoTSharp 本地账号认证。'
		: '正在读取后端安全配置，以选择正确的认证入口。');

const showcasePrimaryCard = computed(() => {
	if (securityState.value === 'central') return {
		label: '当前入口', value: 'Industrial IAM', title: '统一身份登录', description: 'IAM 验证身份，IoTSharp 继续执行本地业务授权。',
	};
	if (securityState.value === 'local') return {
		label: '当前入口', value: 'Local', title: '本地账号登录', description: 'IoTSharp 本地验证账号，并按业务权限进入工作区。',
	};
	return {
		label: '认证模式', value: securityState.value === 'error' ? 'Unavailable' : 'Detecting', title: '等待后端确认', description: '认证模式未确认前不会显示任何登录表单。',
	};
});

const showcaseMetrics = computed(() => securityState.value === 'central' ? [
	{ label: '身份来源', value: 'IAM', description: '平台账号统一认证。', tone: 'primary' as const },
	{ label: '授权阶段', value: 'Shadow', description: '本地授权仍为正式结果。', tone: 'accent' as const },
	{ label: '数据范围', value: 'IoTSharp', description: 'Customer/Tenant/设备范围留在业务域。', tone: 'success' as const },
] : securityState.value === 'local' ? [
	{ label: '账号类型', value: '管理员', description: '支持管理员和授权用户登录。', tone: 'primary' as const },
	{ label: '校验方式', value: '验证码', description: '提交前需要完成一次交互校验。', tone: 'accent' as const },
	{ label: '登录结果', value: '按权限进入', description: '菜单和数据范围由当前账号权限决定。', tone: 'success' as const },
]: [
	{ label: '配置来源', value: 'Backend', description: '以后端安全配置为准。', tone: 'primary' as const },
	{ label: '本地入口', value: 'Closed', description: '检测失败不会降级开放。', tone: 'accent' as const },
	{ label: '下一步', value: 'Retry', description: '恢复连接后重新检测。', tone: 'success' as const },
]);

const showcaseTags = computed(() => securityState.value === 'central' ? ['IAM', 'PKCE', 'Shadow', '数据范围'] : securityState.value === 'local' ? ['Local', '验证码', '权限', '工作区'] : ['模式检测', 'Fail Closed']);
const panelHighlights = computed(() => securityState.value === 'central' ? [
	{ label: '登录方式', value: 'IAM账号', hint: '通过平台统一身份验证。' },
	{ label: '业务角色', value: '本地映射', hint: '显式绑定已有 IdentityUser。' },
	{ label: '权限结果', value: 'Local优先', hint: '中央结果只做 Shadow 对比。' },
] : securityState.value === 'local' ? [
	{ label: '登录方式', value: '账号密码', hint: '使用已分配的控制台账号。' },
	{ label: '安全校验', value: '滑块拼图', hint: '提交前完成验证码校验。' },
	{ label: '进入后', value: '控制台', hint: '按权限加载菜单和数据。' },
]: [
	{ label: '认证模式', value: '检测中', hint: '读取后端安全配置。' },
	{ label: '本地入口', value: '未开放', hint: '不会自动降级。' },
	{ label: '处理方式', value: '明确选择', hint: 'Local 或 Centralized。' },
]);

const detectSecurityMode = async () => {
	securityState.value = 'loading';
	try {
		const security = await loadSecurityProfile(true);
		securityState.value = security.centralMode ? 'central' : 'local';
	} catch (error) {
		securityState.value = 'error';
		securityError.value = error instanceof Error ? error.message : '无法确认认证模式。';
		console.warn('Unable to detect Industrial Security mode; login remains closed.', error);
	} finally {
		NextLoading.done();
	}
};

onMounted(detectSecurityMode);
</script>

<style scoped lang="scss">
.auth-page {
	position: relative;
	height: 100vh;
	min-height: 100vh;
	padding: 24px;
	background:
		radial-gradient(circle at top left, rgba(14, 165, 233, 0.18), transparent 26%),
		radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.18), transparent 28%),
		linear-gradient(180deg, #f3f8ff 0%, #edf6ff 44%, #f9fcff 100%);
	overflow-x: hidden;
	overflow-y: auto;
	overscroll-behavior-y: contain;
	scrollbar-gutter: stable;
	-webkit-overflow-scrolling: touch;
}

.auth-page__aurora {
	position: absolute;
	inset: 0;
	background:
		linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
		linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
	background-size: 48px 48px;
	mask-image: radial-gradient(circle at center, #000 42%, transparent 88%);
	pointer-events: none;
}

.auth-shell {
	position: relative;
	z-index: 1;
	display: grid;
	grid-template-columns: 1.15fr minmax(400px, 480px);
	width: min(1240px, 100%);
	margin: 0 auto;
	min-height: min(780px, calc(100vh - 48px));
	border-radius: 34px;
	border: 1px solid rgba(255, 255, 255, 0.72);
	background: rgba(255, 255, 255, 0.38);
	box-shadow: 0 30px 80px rgba(15, 23, 42, 0.12);
	backdrop-filter: blur(18px);
	overflow: hidden;
}

.auth-panel {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 24px;
	padding: 36px 40px;
	background: rgba(255, 255, 255, 0.95);
}

.auth-panel__eyebrow {
	margin-bottom: 12px;
	color: #2563eb;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.18em;
	text-transform: uppercase;
}

.auth-panel__header h2 {
	margin: 0 0 12px;
	color: #123b6d;
	font-size: 32px;
	letter-spacing: -0.04em;
}

.auth-panel__header p {
	margin: 0;
	color: #64748b;
	font-size: 14px;
	line-height: 1.85;
}

.auth-panel__highlights {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 12px;
}

.auth-panel__highlight {
	padding: 14px 16px;
	border-radius: 18px;
	border: 1px solid rgba(226, 232, 240, 0.92);
	background: linear-gradient(180deg, rgba(248, 251, 255, 0.96), rgba(255, 255, 255, 0.98));
}

.auth-panel__highlight span { display: block; color: #64748b; font-size: 12px; }
.auth-panel__highlight strong { display: block; margin-top: 10px; color: #123b6d; font-size: 18px; font-weight: 700; letter-spacing: -0.03em; }
.auth-panel__highlight small { display: block; margin-top: 6px; color: #7c8da1; font-size: 12px; line-height: 1.6; }

.auth-panel__footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding-top: 18px;
	border-top: 1px solid rgba(226, 232, 240, 0.9);
	color: #64748b;
	font-size: 12px;
}

.auth-mode-state {
	padding: 24px;
	border: 1px solid rgba(37, 99, 235, 0.16);
	border-radius: 20px;
	background: rgba(239, 246, 255, 0.72);
	color: #5f7289;
}

.auth-mode-state--error {
	border-color: rgba(220, 38, 38, 0.18);
	background: rgba(254, 242, 242, 0.82);
}

.auth-mode-state__title { color: #123b6d; font-size: 16px; font-weight: 700; }
.auth-mode-state p { margin: 10px 0 16px; font-size: 13px; line-height: 1.75; }

@media (max-width: 1080px) {
	.auth-shell { grid-template-columns: 1fr; max-width: 720px; }
}

@media (max-width: 767px) {
	.auth-page { padding: 0; }
	.auth-shell { min-height: 100vh; border-radius: 0; }
	.auth-panel { padding: 24px; }
	.auth-panel__highlights { grid-template-columns: 1fr; }
	.auth-panel__footer { flex-direction: column; align-items: flex-start; }
}
</style>
