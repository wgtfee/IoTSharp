import type { CrudExpose, CrudOptions, PageRequest, AddRequest, EditRequest, DelRequest } from '@fast-crud/fast-crud';
import type { Ref } from 'vue';
import { errorMessage } from '/@/utils/errorMessage';
import { deviceApi } from '/@/api/devices';
import * as _ from 'lodash-es';
import { dict } from '@fast-crud/fast-crud';
import { TableDataRow } from '/@/views/iot/devices/model';
import { ElMessage } from 'element-plus';
import { ruleApi } from '/@/api/flows';
// eslint-disable-next-line no-unused-vars
export const createDeviceRulesCrudOptions = function ({ expose }: { expose: CrudExpose }, deviceId: string): { crudOptions: CrudOptions; deviceId?: string } {
	let records: any[] = [];
	let rulesDict: { ruleId: string; name: string }[] = [];

	const FsButton = {
		link: true,
	};

	const pageRequest: PageRequest = async () => {
		const res = await deviceApi().getDeviceRules(deviceId);
		records = res.data;
		return {
			records,
			currentPage: 1,
			pageSize: res.data.length,
			total: res.data.length,
		};
	};
	const delRequest: DelRequest = async ({ row }) => {
		try {
			await deviceApi().deleteDeviceRules(deviceId, row.ruleId);
			_.remove(records, (item: TableDataRow) => {
				return item.id === row.id;
			});
		} catch (e) {
			ElMessage.error(errorMessage(e));
            throw e;
		}
	};

	const addRequest: AddRequest = async ({ form }) => {
		try {
			await deviceApi().setDeviceRules(deviceId, form.ruleId);
			records.push(form);
			return form;
		} catch (e) {
			ElMessage.error(errorMessage(e));
            throw e;
		}
	};
	const getRulesDict = async () => {
		try {
			const res = await ruleApi().ruleList({ limit: 100 });
			rulesDict = res.data.rows;
			return res.data.rows;
		} catch (e) {
			ElMessage.error(errorMessage(e));
            throw e;
		}
	};

	return {
		deviceId,
		crudOptions: {
			request: {
				pageRequest,
				addRequest,
				delRequest,
			},
			table: {
				border: false,
			},
			form: {
				labelWidth: '130px', //
			},
			search: {
				show: false,
			},
			toolbar: {
				buttons: {
					search: {
						show: false,
					},
				},
			},
			pagination: {
				show: false,
			},
			rowHandle: {
				width: 100,
				dropdown: {
					more: {
						//更多按钮配置
						text: '属性',
						...FsButton,
						icon: 'operation',
					},
				},
				buttons: {
					view: { show: false },
					edit: { show: false },
					remove: {
						icon: 'Delete',
						...FsButton,
						order: 5,
					}, //删除按钮
				},
			},
			columns: {
				ruleId: {
					title: '规则名称',
					type: 'dict-select',
					dict: dict({
						cloneable: true,
						value: 'ruleId',
						label: 'name',
						async getData() {
							return getRulesDict();
						},
					}),
					addForm: {
						component: {
							dict: dict({
								cloneable: true,
								value: 'ruleId',
								label: 'name',
								async getData() {
									return getRulesDict();
								},
							}),
						},
					},
				},
				ruleDesc: {
					title: '备注',
					type: 'text',
					addForm: {
						show: false,
					},
				},
			},
		},
	};
};
