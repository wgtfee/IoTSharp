import { defineStore } from 'pinia';
import Cookies from 'js-cookie';
import { Session } from '/@/utils/storage';
import { useLoginApi } from '../api/login';

const apiBaseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const normalizeAvatarUrl = (avatar?: string) => {
	if (!avatar || /^(?:https?:|data:|blob:)/i.test(avatar)) return avatar || '';
	if (avatar.startsWith('/api/')) {
		// Repair legacy cached values such as /api/iot/iot/Account/Avatar, then apply the gateway base once.
		const backendPath = avatar.replace(/^\/api(?:\/iot)+(?=\/)/i, '/api');
		return `${apiBaseURL}${backendPath.replace(/^\/api(?=\/)/, '')}`;
	}
	return avatar;
};

/**
 * 用户信息
 * @methods setUserInfos 设置用户信息
 */
export const useUserInfo = defineStore('userInfo', {
	state: (): UserInfosState => ({
		userInfos: {
			userName: '',
			photo: '',
			time: 0,
			roles: [],
			authBtnList: [],
		},
	}),
	actions: {
		async setUserInfos() {
			// 存储用户信息到浏览器缓存
			if (Session.get('userInfo')) {
				const cachedUserInfos = Session.get('userInfo');
				cachedUserInfos.photo = normalizeAvatarUrl(cachedUserInfos.photo);
				this.userInfos = cachedUserInfos;
				Session.set('userInfo', cachedUserInfos);
			} else {
				const userInfos: any = await this.getApiUserInfo();
				this.userInfos = userInfos;
				Session.set('userInfo', userInfos);
			}
		},
		// 模拟接口数据
		// https://gitee.com/lyt-top/vue-next-admin/issues/I5F1HP
		async getApiUserInfo() {
			return useLoginApi()
				.GetUserInfo({})
				.then((res) => {
					const userInfos = {
						userName: res.data.name,
						photo: normalizeAvatarUrl(res.data.avatar),
						time: new Date().getTime(),
						roles: [res.data.roles],
						authBtnList: ['btn.add', 'btn.del', 'btn.edit', 'btn.link'],
						customer: res.data.customer,
						tenant: res.data.tenant,
					};
					return userInfos;
				})
				.catch();
		},
	},
});
