<template>
	<div class="central-login">
		<div class="central-login__tip">
			<div class="central-login__eyebrow">Industrial IAM</div>
			<div class="central-login__title">统一身份认证</div>
			<p>当前 IoTSharp 已进入 Shadow 身份阶段。IAM 负责登录，本地 IoTSharp 角色、Customer/Tenant 数据范围仍决定正式访问结果。</p>
		</div>

		<el-form size="large" @submit.prevent="signIn">
			<el-form-item>
				<el-input v-model="form.userName" autocomplete="username" placeholder="请输入 IAM 账号" @keyup.enter="signIn">
					<template #prefix><el-icon><User /></el-icon></template>
				</el-input>
			</el-form-item>
			<el-form-item>
				<el-input v-model="form.password" type="password" show-password autocomplete="current-password" placeholder="请输入 IAM 密码" @keyup.enter="signIn">
					<template #prefix><el-icon><Unlock /></el-icon></template>
				</el-input>
			</el-form-item>
			<el-button type="primary" class="central-login__submit" native-type="submit" :loading="loading">IAM 统一登录</el-button>
		</el-form>
	</div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Unlock, User } from '@element-plus/icons-vue';
import { beginOidcLogin, establishIamSession } from '/@/security/oidc';

const route = useRoute();
const loading = ref(false);
const form = reactive({ userName: '', password: '' });

const signIn = async () => {
	if (!form.userName || !form.password) {
		ElMessage.warning('请输入 IAM 账号和密码。');
		return;
	}

	loading.value = true;
	try {
		await establishIamSession(form.userName, form.password);
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
</style>
