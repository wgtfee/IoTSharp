<template>
	<div class="central-login">
		<div class="central-login__tip">
			<div class="central-login__eyebrow">Industrial IAM</div>
			<div class="central-login__title">统一身份认证</div>
			<p>当前 IoTSharp 已进入 Shadow 身份阶段。IAM 负责登录，本地 IoTSharp 角色、Customer/Tenant 数据范围仍决定正式访问结果。</p>
		</div>

		<el-button type="primary" size="large" class="central-login__submit" :loading="loading" @click="signIn">
			前往认证中心
		</el-button>
		<p class="central-login__notice">账号和密码只在认证中心页面输入，IoTSharp 不接收统一身份凭据。</p>
	</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { beginOidcLogin } from '/@/security/oidc';

const route = useRoute();
const loading = ref(false);

const signIn = async () => {
	loading.value = true;
	try {
		const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
		await beginOidcLogin(redirect);
	} catch (error: any) {
		loading.value = false;
		ElMessage.error(error?.message || 'IAM 登录失败。');
	}
};
</script>

<style scoped lang="scss">
.central-login {
	display: flex;
	flex-direction: column;
	gap: 20px;
}
.central-login__tip {
	padding: 18px 20px;
	border: 1px solid rgba(37, 99, 235, 0.16);
	border-radius: 22px;
	background: linear-gradient(135deg, rgba(37, 99, 235, 0.07), rgba(14, 165, 233, 0.08));
	color: #5f7289;
	line-height: 1.75;
}
.central-login__tip p { margin: 10px 0 0; font-size: 13px; }
.central-login__eyebrow { color: #2563eb; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.central-login__title { margin-top: 6px; color: #123b6d; font-size: 18px; font-weight: 700; }
.central-login__submit { width: 100%; }
.central-login__notice { margin: 0; color: #64748b; font-size: 12px; line-height: 1.7; text-align: center; }
</style>
