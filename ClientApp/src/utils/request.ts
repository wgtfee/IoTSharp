import axios, { AxiosInstance } from 'axios';
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus';
import { Session } from '/@/utils/storage';
import {
	beginOidcLogin,
	canSilentlyRenewIamSession,
	clearIamBrowserSession,
	currentReturnUrl,
	isCentralAuthentication,
	isCentralTokenNearExpiry,
} from '/@/security/oidc';
import qs from 'qs';

const apiBaseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const normalizeApiPath = (url?: string) => url?.replace(/^\/api(?=\/)/, '') || url;
const appBaseURL = import.meta.env.BASE_URL || '/';
let oidcRenewalStarted = false;

const redirectToAppRoot = () => {
	window.location.href = appBaseURL;
};

const redirectForOidcRenewal = async () => {
	if (!canSilentlyRenewIamSession()) {
		clearIamBrowserSession();
		Session.clear();
		redirectToAppRoot();
		return;
	}
	if (oidcRenewalStarted) return;
	oidcRenewalStarted = true;
	await beginOidcLogin(currentReturnUrl());
};

const service: AxiosInstance = axios.create({
	baseURL: apiBaseURL,
	timeout: 50000,
	headers: { 'Content-Type': 'application/json' },
	paramsSerializer: {
		serialize(params) {
			return qs.stringify(params, { allowDots: true });
		},
	},
});

service.interceptors.request.use(
	async (config) => {
		config.url = normalizeApiPath(config.url);
		if (isCentralTokenNearExpiry()) {
			await redirectForOidcRenewal();
			return Promise.reject({ oidcRedirect: true });
		}
		if (Session.get('token')) config.headers!['Authorization'] = `Bearer ${Session.get('token')}`;
		return config;
	},
	(error) => Promise.reject(error)
);

service.interceptors.response.use(
	(response) => {
		const res = response.data;
		if (res.code && res.code !== 10000) {
			if (res.code === 401 || res.code === 4001) {
				if (isCentralAuthentication() && canSilentlyRenewIamSession()) {
					redirectForOidcRenewal().catch(() => {
						clearIamBrowserSession();
						Session.clear();
						redirectToAppRoot();
					});
					return Promise.reject({ oidcRedirect: true });
				}
				clearIamBrowserSession();
				Session.clear();
				redirectToAppRoot();
				ElMessageBox.alert('你已被登出，请重新登录', '提示', {}).catch(() => {});
				return Promise.reject(res);
			}

			ElNotification({
				title: `错误代码: ${res.code}`,
				type: 'error',
				message: res.msg,
			});
			return Promise.reject(res);
		}
		return res;
	},
	(error) => {
		if (error?.oidcRedirect) return Promise.reject(error);
		if (error.message?.includes('timeout')) {
			ElMessage.error('网络超时');
		} else if (error.message === 'Network Error') {
			ElMessage.error('网络连接错误');
		} else {
			const status = error.response?.status;
			if (status === 401) {
				if (isCentralAuthentication() && canSilentlyRenewIamSession()) {
					redirectForOidcRenewal().catch(() => {
						clearIamBrowserSession();
						Session.clear();
						redirectToAppRoot();
					});
					return Promise.reject({ oidcRedirect: true });
				}
				clearIamBrowserSession();
				Session.clear();
				redirectToAppRoot();
			}
			if (error.response?.data) ElMessage.error(error.response.statusText || '请求失败');
			else if (status) ElMessage.error(String(status));
			console.log(error);
		}
		return Promise.reject(error);
	}
);

export default service;
