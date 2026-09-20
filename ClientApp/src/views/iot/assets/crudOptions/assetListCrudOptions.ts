import type { CrudExpose, CrudOptions, PageRequest, AddRequest, EditRequest, DelRequest } from '@fast-crud/fast-crud';
import type { Ref } from 'vue';
import { errorMessage } from '/@/utils/errorMessage';
import { assetApi } from '/@/api/asset';
import * as _ from 'lodash-es';
import { TableDataRow } from '../model/assetList';
import { ElMessage } from 'element-plus';
import { dict } from '@fast-crud/fast-crud';
export const createAssetListCrudOptions = function ({ expose }: { expose: CrudExpose }, assetDetailRef: Ref<{ openDialog: (row: Record<string, unknown>) => void } | undefined>, overviewState?: { total: number; pageCount: number; typeCount: number; describedCount: number; lastRefresh: string }): { crudOptions: CrudOptions; deviceId?: string } {
	let records: any[] = [];
	const FsButton = {
		link: true,
	};
	const customSwitchComponent = {
		activeColor: 'var(--el-color-primary)',
		inactiveColor: 'var(el-switch-of-color)',
	};
	const pageRequest: PageRequest = async (query) => {
		let {
			form: { name },
			page: { currentPage: currentPage, pageSize: limit },
		} = query;
		let offset = currentPage === 1 ? 0 : currentPage - 1;
		const res = await assetApi().assetList({ name, limit, offset });
		records = res.data.rows;
		if (overviewState) {
			overviewState.total = res.data.total ?? 0;
			overviewState.pageCount = records.length;
			overviewState.typeCount = new Set(records.map((item: any) => item.assetType).filter(Boolean)).size;
			overviewState.describedCount = records.filter((item: any) => item.description).length;
			overviewState.lastRefresh = new Date().toLocaleTimeString('zh-CN', { hour12: false });
		}
		return {
			records,
			currentPage: currentPage,
			pageSize: limit,
			total: res.data.total,
		};
	};
	const editRequest: EditRequest = async ({ form, row }) => {
		form.id = row.id;
		try {
			await assetApi().putAsset(form);
			return form;
		} catch (e) {
			ElMessage.error(errorMessage(e));
            throw e;
		}
	};
	const delRequest: DelRequest = async ({ row }) => {
		try {
			await assetApi().deleteAsset(row.id);
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
			await assetApi().postAsset({
				...form,
			});
			records.push(form);
			return form;
		} catch (e) {
			ElMessage.error(errorMessage(e));
            throw e;
		}
	};
	return {
		crudOptions: {
			request: {
				pageRequest,
				addRequest,
				delRequest,
				editRequest,
			},
			table: {
				border: false,
			},
			form: {
				labelWidth: '80px',
			},
			search: {
				show: true,
			},
			rowHandle: {
				width: 200,
				buttons: {
					view: {
						icon: 'View',
						...FsButton,
						show: false,
					},
					edit: {
						icon: 'EditPen',
						...FsButton,
						order: 2,
					},
					remove: {
						icon: 'Delete',
						...FsButton,
						order: 3,
					},
				},
			},
			columns: {
				name: {
					title: '资产名称',
					type: 'button',
					search: { show: true },
					addForm: {
						show: true,
						component: customSwitchComponent,
					},
					column: {
						component: {
							...FsButton,
							type: 'primary',
							on: {
								onClick({ row }) {
									assetDetailRef?.value?.openDialog(row);
								},
							},
						},
					},
					editForm: {
						show: true,
						component: customSwitchComponent,
					},
				},
				assetType: {
					title: '类型',
					type: 'dict-select',
					column: { width: 180 },
					addForm: {
						show: true,
						component: customSwitchComponent,
					},
					dict: dict({
						data: [
							{ value: 'Gateway', label: '网关' },
							{ value: 'Device', label: '设备', color: 'warning' },
						],
					}),
					editForm: {
						show: true,
						component: customSwitchComponent,
					},
				},
				description: {
					title: '描述',
					column: { width: 150 },
					type: 'textarea',
					form: {
						col: {
							span: 24,
							style: { gridColumn: 'span 2' }, // grid 模式控制跨列
						},
					},
					addForm: {
						show: true,
						component: customSwitchComponent,
					},
					editForm: {
						show: true,
						component: customSwitchComponent,
					},
				},
			},
		},
	};
};
