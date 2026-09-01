import { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
	interface RouteMeta {
		title?: string;
		isLink?: string;
		isHide?: boolean;
		isKeepAlive?: boolean;
		isAffix?: boolean;
		isIframe?: boolean;
		roles?: string[];
		icon?: string;
	}
}

// These routes are part of the frontend application itself.  Keep them separate
// from the menu response because back-end controlled routing replaces
// dynamicRoutes[0].children after login.
export const digitalTwinSupplementalRoutes: Array<RouteRecordRaw> = [
	{
		path: '/iot/digital-twin/scenes',
		name: 'digitaltwinscenes',
		component: () => import('/@/views/iot/digital-twin/scenes.vue'),
		meta: { title: '孪生场景中心', isLink: '', isHide: false, isKeepAlive: false, isAffix: false, isIframe: false, roles: ['admin', 'common'], icon: 'iconfont icon-shuju' },
	},
	{
		path: '/iot/digital-twin/viewer',
		name: 'digitaltwinviewer',
		component: () => import('/@/views/iot/digital-twin/viewer.vue'),
		meta: { title: '孪生只读运行态', isHide: true, isKeepAlive: false, roles: ['admin', 'common'] },
	},
	{
		path: '/iot/digital-twin/2d-viewer',
		name: 'digitaltwin2dviewer',
		component: () => import('/@/views/iot/digital-twin/2d-viewer.vue'),
		meta: { title: '2D 孪生只读运行态', isHide: true, isKeepAlive: false, roles: ['admin', 'common'], icon: 'iconfont icon-shuju' },
	},
	{
		path: '/iot/digital-twin/2d-scene',
		name: 'digitaltwin2dscene',
		component: () => import('/@/views/iot/digital-twin/2d-scene.vue'),
		meta: { title: '2D 场景设计器', isLink: '', isHide: false, isKeepAlive: false, isAffix: false, isIframe: false, roles: ['admin', 'common'], icon: 'iconfont icon-shuju' },
	},
	{
		path: '/iot/digital-twin/yt-pack-2d',
		name: 'digitaltwinytpack2d',
		component: () => import('/@/views/iot/digital-twin/yt-pack-2d/index.vue'),
		meta: { title: '亚特包装线 2D', isLink: '', isHide: false, isKeepAlive: true, isAffix: false, isIframe: false, roles: ['admin', 'common'], icon: 'iconfont icon-shuju' },
	},
];

export const dynamicRoutes: Array<RouteRecordRaw> = [
	{
		path: '/console',
		name: 'console-shell',
		component: () => import('/@/layout/index.vue'),
		redirect: '/dashboard',
		meta: {
			isKeepAlive: true,
		},
		children: [
			{
				path: '/dashboard',
				name: 'dashboard',
				component: () => import('/@/views/dashboard/index.vue'),
				meta: {
					title: 'message.router.home',
					isLink: '',
					isHide: false,
					isKeepAlive: true,
					isAffix: true,
					isIframe: false,
					roles: ['admin', 'common'],
					icon: 'iconfont icon-shouye',
				},
			},
			...digitalTwinSupplementalRoutes,
			{
				path: '/iot/digital-twin/model-generator',
				name: 'digitaltwinmodelgenerator',
				component: () => import('/@/views/iot/digital-twin/model-generator.vue'),
				meta: {
					title: '模型生成',
					isLink: '',
					isHide: false,
					isKeepAlive: false,
					isAffix: false,
					isIframe: false,
					roles: ['admin', 'common'],
					icon: 'iconfont icon-shuju',
				},
			},
			{
				path: '/iot/digital-twin/workbench',
				name: 'digitaltwinworkbench',
				component: () => import('/@/views/iot/digital-twin/workbench.vue'),
				meta: {
					title: '三维场景',
					isLink: '',
					isHide: false,
					isKeepAlive: false,
					isAffix: false,
					isIframe: false,
					roles: ['admin', 'common'],
					icon: 'iconfont icon-shuju',
				},
			},
		],
	},
];

export const frontEndRoutes: Array<RouteRecordRaw> = [
	{
		path: '/profile',
		name: 'profile',
		component: () => import('/@/views/profile/index.vue'),
		meta: {
			title: '个人中心',
			isHide: true,
		},
	},
	{
		path: '/iot/rules/flowdesigner',
		name: 'flowdesigner',
		component: () => import('/@/views/iot/rules/flowdesigner.vue'),
		meta: {
			title: '规则设计器',
			isHide: true,
		},
	},
	{
		path: '/iot/forms/edit',
		name: 'edit',
		component: () => import('/@/views/iot/forms/edit.vue'),
		meta: {
			title: '编辑',
			isHide: true,
		},
	},
	{
		path: '/iot/rules/flowsimulator',
		name: 'flowsimulator',
		component: () => import('/@/views/iot/rules/flowsimulator.vue'),
		meta: {
			title: 'message.router.home',
			isHide: true,
		},
	},
	{
		path: '/iot/rules/flowevents',
		name: 'flowevents',
		component: () => import('/@/views/iot/rules/flowevents.vue'),
		meta: {
			title: 'message.router.home',
			isHide: true,
		},
	},
	{
		path: '/iot/devices/assetdesigner',
		name: 'assetdesigner',
		component: () => import('/@/views/iot/assets/designer/assetdesigner.vue'),
		meta: {
			title: 'message.router.home',
			isHide: true,
		},
	},
	{
		path: '/iot/devices/gatewaydesigner',
		name: 'gatewaydesigner',
		component: () => import('/@/views/iot/devices/gatewaydesigner.vue'),
		meta: {
			title: 'message.router.home',
			isHide: true,
		},
	},
	{
		path: '/iot/devices/telemetry',
		name: 'telemetry',
		component: () => import('/@/views/iot/devices/telemetry.vue'),
		meta: {
			title: '遥测数据',
			isHide: true,
		},
	},
	{
		path: '/iot/ai/workbench',
		name: 'aiworkbench',
		component: () => import('/@/views/iot/ai/workbench.vue'),
		meta: {
			title: 'AI 功能',
			isHide: true,
		},
	},
	{
		path: '/iot/ai/mcp',
		name: 'mcpservice',
		component: () => import('/@/views/iot/ai/mcp.vue'),
		meta: {
			title: 'MCP 服务',
			isHide: true,
		},
	},
	{
		path: '/iot/devices/edgetasks',
		name: 'edgetasks',
		component: () => import('/@/views/iot/edge/edgetasks.vue'),
		meta: {
			title: 'Edge任务',
			isHide: true,
		},
	},
	{
		path: '/iot/devices/edgelist',
		name: 'edgelist',
		component: () => import('/@/views/iot/devices/edgelist.vue'),
		meta: {
			title: 'Edge管理',
			isHide: true,
		},
	},
];

export const notFoundAndNoPower: Array<RouteRecordRaw> = [
	{
		path: '/401',
		name: 'noPower',
		component: () => import('/@/views/error/401.vue'),
		meta: {
			title: 'message.staticRoutes.noPower',
			isHide: true,
		},
	},
	{
		path: '/:path(.*)*',
		name: 'notFound',
		component: () => import('/@/views/error/404.vue'),
		meta: {
			title: 'message.staticRoutes.notFound',
			isHide: true,
		},
	},
];

export const staticRoutes: Array<RouteRecordRaw> = [
	{
		path: '/',
		name: 'landing',
		component: () => import('/@/views/landing/index.vue'),
		meta: {
			title: 'IoTSharp',
		},
	},
	{
		path: '/login',
		name: 'login',
		component: () => import('/@/views/login/index.vue'),
		meta: {
			title: '登录',
		},
	},
	{
		path: '/signup',
		name: 'signup',
		component: () => import('/@/views/login/signup.vue'),
		meta: {
			title: '注册',
		},
	},
	{
		path: '/installer',
		name: 'installer',
		component: () => import('/@/views/installer/index.vue'),
		meta: {
			title: '初始化系统',
		},
	},
];
