import { IListQueryParam } from '../iapiresult';
import request from '/@/utils/request';

/**
 * 租户api接口集合
 * @method ruleList 租户列表
 * @method getrule 获取租户
 * @method postrule 新增租户
 * @method putrule 修改租户
 * @method deleterule 删除租户
 */
export function ruleApi() {
	return {
		ruleList: (params: QueryParam) => {
			return request({
				url: '/api/rules/Index',
				method: 'post',
				data: params,
			});
		},
		getrule: (ruleId: string) => {
			return request({
				url: '/api/rules/Get?id=' + ruleId,
				method: 'get',
			});
		},

		postrule: (params: any) => {
			return request({
				url: '/api/rules/Save',
				method: 'post',
				data: params,
			});
		},

		putrule: (params: any) => {
			return request({
				url: '/api/rules/Update',
				method: 'post',
				data: params,
			});
		},
		deleterule: (id: string) => {
			return request({
				url: '/api/rules/Delete?id=' + id,
				method: 'get',
				data: {},
			});
		},
		getexecutors: () => {
			return request({
				url: '/api/rules/getexecutors',
				method: 'get',
				data: {},
			});
		},

		getDiagram: (id: string) => {
			return request({
				url: '/api/rules/GetDiagramV?id=' + id,
				method: 'get',
			});
		},
		saveDiagramV: (data: any) => {
			return request({
				url: '/api/rules/SaveDiagramV',
				method: 'post',
				data: data,
			});
		},


		active: (data: any) => {
			return request({
				url: '/api/rules/active',
				method: 'post',
				data: data,
			});
		},

		floweventslist: (data: any) => {
			return request({
				url: '/api/rules/flowevents',
				method: 'post',
				data: {
					Offset: Number(data?.offset) || 0,
					Limit: Number(data?.limit) || 10,
					Name: data?.Name || '',
					RuleId: normalizeOptionalValue(data?.RuleId),
					Creator: normalizeOptionalValue(data?.Creator),
					CreatorName: data?.CreatorName || '',
					CreatTime: normalizeDateRange(data?.CreatTime),
				},
			});
		},


		getFlows: (ruleId: string) => {
			return request({
				url: '/api/rules/GetFlows?ruleId=' + ruleId,
				method: 'get',
			});
		},
		bindDevice: (data: any) => {
			return request({
				url: '/api/rules/binddevice',
				method: 'post', data: data,
			});
		},




	};
}

interface QueryParam extends IListQueryParam {
	name?: string
}

function normalizeOptionalValue(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeDateRange(value: unknown) {
	return Array.isArray(value) && value.length === 2 ? value : undefined;
}
