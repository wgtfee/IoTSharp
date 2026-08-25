import { createRouter, createWebHashHistory } from 'vue-router';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';
import pinia from '/@/stores/index';
import { storeToRefs } from 'pinia';
import { useKeepALiveNames } from '/@/stores/keepAliveNames';
import { useRoutesList } from '/@/stores/routesList';
import { useThemeConfig } from '/@/stores/themeConfig';
import { Session } from '/@/utils/storage';
import { staticRoutes, notFoundAndNoPower } from '/@/router/route';
import { initFrontEndControlRoutes } from '/@/router/frontEnd';
import { initBackEndControlRoutes } from '/@/router/backEnd';
import { clearIamBrowserSession, completeOidcLogin, hasOidcCallback } from '/@/security/oidc';
import { loadSecurityProfile } from '/@/security/security-profile';

const storesThemeConfig = useThemeConfig(pinia);
const { themeConfig } = storeToRefs(storesThemeConfig);
const { isRequestRoutes } = themeConfig.value;

export const router = createRouter({
	history: createWebHashHistory(),
	routes: [...notFoundAndNoPower, ...staticRoutes],
});

export function formatFlatteningRoutes(arr: any[]) {
	if (!Array.isArray(arr) || arr.length === 0) return [];

	const flattenedRoutes: any[] = [];
	const appendRoutes = (routes: any[]) => {
		routes.forEach((route) => {
			flattenedRoutes.push(route);
			if (Array.isArray(route.children) && route.children.length > 0) appendRoutes(route.children);
		});
	};

	appendRoutes(arr);
	return flattenedRoutes;
}

export function formatTwoStageRoutes(arr: any[]) {
	if (!Array.isArray(arr) || arr.length === 0) return [];

	const [rootRoute, ...childRoutes] = arr;
	const newArr: any = [
		{
			component: rootRoute.component,
			name: rootRoute.name,
			path: rootRoute.path,
			redirect: rootRoute.redirect,
			meta: rootRoute.meta,
			children: [],
		},
	];
	const cacheList: Array<string> = [];
	const routeNames = new Set<string>();
	const routePaths = new Set<string>();

	childRoutes.forEach((route: any) => {
		// 后端菜单目录没有可渲染组件，只用于菜单分组，不能注册为页面路由。
		if (!route.component && !route.redirect) return;

		const routeName = route.name == null ? '' : String(route.name);
		const routePath = route.path == null ? '' : String(route.path);
		if ((routeName && routeNames.has(routeName)) || (routePath && routePaths.has(routePath))) return;
		if (routeName) routeNames.add(routeName);
		if (routePath) routePaths.add(routePath);

		const { children: _children, ...flatRoute } = route;
		flatRoute.meta = { ...(route.meta || {}) };
		if (routePath.indexOf('/:') > -1) {
			flatRoute.meta.isDynamic = true;
			flatRoute.meta.isDynamicPath = routePath;
		}
		newArr[0].children.push(flatRoute);

		if (newArr[0].meta?.isKeepAlive && flatRoute.meta.isKeepAlive && routeName) {
			cacheList.push(routeName);
			const stores = useKeepALiveNames(pinia);
			stores.setCacheKeepAlive(cacheList);
		}
	});
	return newArr;
}

router.beforeEach(async (to, from, next) => {
	NProgress.configure({ showSpinner: false });
	if (to.meta.title) NProgress.start();

	// OIDC redirect_uri points to /iot/ without a hash. Complete PKCE before the
	// HashRouter evaluates the regular token guard.
	if (hasOidcCallback()) {
		try {
			const returnUrl = await completeOidcLogin();
			NProgress.done();
			return next(returnUrl);
		} catch (error) {
			console.error('IoT IAM OIDC callback failed', error);
			Session.clear();
			clearIamBrowserSession();
			NProgress.done();
			return next('/login?iam_callback=failed');
		}
	}

	let securityProfile;
	try {
		securityProfile = await loadSecurityProfile();
	} catch (error) {
		console.error('IoT authentication mode detection failed', error);
		if (to.path !== '/' && to.path !== '/login') {
			NProgress.done();
			return next('/login?security_profile=unavailable');
		}
	}

	if (securityProfile) {
		if (to.path === '/signup' && (securityProfile.centralMode || securityProfile.localUserManagementMode !== 'Enabled')) {
			NProgress.done();
			return next('/login');
		}
		if (to.path === '/installer' && (securityProfile.centralMode || securityProfile.localUserManagementMode === 'Hidden')) {
			NProgress.done();
			return next('/login');
		}

		const activeMode = Session.get('iam_auth_mode');
		if (Session.get('token') && !activeMode && securityProfile.authenticationMode === 'Local') {
			Session.set('iam_auth_mode', 'Local');
		} else if (Session.get('token') && activeMode !== securityProfile.authenticationMode) {
			Session.remove('token');
			if (activeMode === 'Centralized') clearIamBrowserSession();
			else Session.remove('iam_auth_mode');
		}
	}

	const token = Session.get('token');
	if ((to.path === '/' || to.path === '/login' || to.path === '/installer' || to.path === '/signup') && !token) {
		next();
		NProgress.done();
	} else if (!token) {
		next(`/login?redirect=${encodeURIComponent(to.path)}&params=${encodeURIComponent(JSON.stringify(to.query ? to.query : to.params))}`);
		Session.clear();
		NProgress.done();
	} else if (token && to.path === '/login') {
		next('/dashboard');
		NProgress.done();
	} else {
		const storesRoutesList = useRoutesList(pinia);
		const { routesList } = storeToRefs(storesRoutesList);
		if (routesList.value.length === 0) {
			if (isRequestRoutes) {
				await initBackEndControlRoutes();
				next({ path: to.path, query: to.query });
			} else {
				await initFrontEndControlRoutes();
				next({ path: to.path, query: to.query });
			}
		} else {
			next();
		}
	}
});

router.afterEach(() => {
	NProgress.done();
});

export default router;
