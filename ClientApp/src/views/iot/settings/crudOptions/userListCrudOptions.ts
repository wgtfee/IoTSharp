import type { CrudExpose, DynamicallyCrudOptions, PageRequest, AddRequest, EditRequest, DelRequest } from '@fast-crud/fast-crud';
import type { Ref } from 'vue';
import { errorMessage } from '/@/utils/errorMessage';
import { accountApi } from '/@/api/user';
import * as _ from 'lodash-es';
import { TableDataRow } from '../model/userListModel';
import { ElMessage } from 'element-plus';
import { compute, dict } from '@fast-crud/fast-crud';
export const createUserListCrudOptions = function ({ expose }: { expose: CrudExpose }, customerId: string | (() => string), overviewState?: { total: number; pageCount: number; lockedCount: number; failedCount: number; contactCount: number; lastRefresh: string }): { crudOptions: DynamicallyCrudOptions; deviceId?: string } {
    let records: any[] = [];
    const selectedCustomerId = () => typeof customerId === 'function' ? customerId() : customerId;
    const customerDict = dict({
        cache: false,
        immediate: true,
        getData: async () => {
            const response = await accountApi().assignableCustomers();
            if (response.code !== 10000) throw new Error(response.info || '无权读取可绑定客户');
            return response.data.map(c => ({
                value: c.id,
                label: c.name + '（' + c.tenantName + '）',
            }));
        },
    });
    const roleDict = dict({
        cache: false,
        immediate: true,
        getData: async () => {
            const response = await accountApi().assignableRoles();
            if (response.code !== 10000) throw new Error(response.info || '无权读取可分配角色');
            return response.data.map(role => ({
                value: role.name,
                label: role.displayName + '（' + role.name + '）',
            }));
        },
    });
    const FsButton = {
        link: true,
    };
    const customSwitchComponent = {
        activeColor: 'var(--el-color-primary)',
        inactiveColor: 'var(el-switch-of-color)',
    };
    const requiredCustomSwitchComponent = {
        required: 'required',
        activeColor: 'var(--el-color-primary)',
        inactiveColor: 'var(el-switch-of-color)',
    };
    const pageRequest: PageRequest = async (query) => {
        let {
            form: { userName: name },
            page: { currentPage: currentPage, pageSize: limit },
        } = query;
        let offset = currentPage === 1 ? 0 : currentPage - 1;
        const res = await accountApi().accountList({ name, limit, offset, customerId: selectedCustomerId() });
        records = res.data.rows;
        if (overviewState) {
            overviewState.total = res.data.total ?? 0;
            overviewState.pageCount = records.length;
            overviewState.lockedCount = records.filter((item: any) => item.lockoutEnabled).length;
            overviewState.failedCount = records.reduce((sum: number, item: any) => sum + Number(item.accessFailedCount || 0), 0);
            overviewState.contactCount = records.filter((item: any) => item.phoneNumber).length;
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
            if (!form.customerId) throw new Error('请选择所属客户');
            if (!Array.isArray(form.roleNames) || !form.roleNames.includes('NormalUser'))
                throw new Error('请选择角色并保留普通用户角色');
            const result = await accountApi().putAccount(form);
            if (result.code !== 10000) throw new Error(result.info || '保存用户失败');
            return form;
        } catch (e) {
            ElMessage.error(errorMessage(e));
            throw e;
        }
    };
    const delRequest: DelRequest = async ({ row }) => {
        try {
            await accountApi().deleteAccount(row.id);
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
            if (!form.customerId) throw new Error('请选择所属客户');
            if (!Array.isArray(form.roleNames) || !form.roleNames.includes('NormalUser'))
                throw new Error('请选择角色并保留普通用户角色');
            //验证
            var userName = form.userName;
            var email = form.email;
            if (userName) {
                if (email) {
                    const regEmail = /^([a-zA-Z0-9_-])+@([a-zA-Z0-9_-])+(\.[a-zA-Z0-9_-])+/;
                    if (regEmail.test(email)) {
                        const result = await accountApi().postAccount({
                            ...form,
                            customerId: form.customerId,
                        });
                        if (result.code !== 10000) throw new Error(result.info || '新增用户失败');
                        records.push(form);
                        return form;
                    } else {
                        ElMessage.error('请输入合法邮箱');
                    }
                } else {
                    ElMessage.error('请填写邮箱');
                }
            } else {
                ElMessage.error('请填写用户名');
            }
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
            actionbar: {
                buttons: {
                    add: {

                    },
                },
            },
            form: {
                labelWidth: '80px', //
                beforeSubmit: async function (subParam) {
                    var form = subParam.form;
                    if (subParam.mode == 'add') {
                        //验证
                        var userName = form.userName;
                        var email = form.email;
                        if (userName) {
                            if (email) {
                                const regEmail = /^([a-zA-Z0-9_-])+@([a-zA-Z0-9_-])+(\.[a-zA-Z0-9_-])+/;
                                if (regEmail.test(email)) {
                                   //需要验证是否重复

                                } else {
                                    ElMessage.error('请输入合法邮箱');
                                    throw new Error('请输入合法邮箱');
                                }
                            } else {
                                ElMessage.error('请填写邮箱');
                                throw new Error('请填写邮箱');
                            }
                        } else {
                            ElMessage.error('请填写用户名');
                            throw new Error('请填写用户名');
                        }
                    }
                    return true;
                }
            },
            search: {
                show: true,
            },
            rowHandle: {
                // Always expose actions; backend enforces permissions.
                show: true,
                fixed: 'right',
                width: 210,
                buttons: {
                    view: {
                        icon: 'View',
                        ...FsButton,
                        show: false,
                    },
                    edit: {
                        text: '编辑',
                        icon: 'EditPen',
                        ...FsButton,
                        order: 1,
                        show: true,
                    },
                    remove: {
                        text: '删除',
                        icon: 'Delete',
                        ...FsButton,
                        order: 2,
                        show: true,
                    }, //删除按钮
                },
            },
            columns: {
                password: {
                    title: '初始密码', type: 'text', column: { show: false },
                    addForm: { show: true, component: { type: 'password', showPassword: true, autocomplete: 'new-password' }, rules: [{ required: true, message: '请输入初始密码' }, { min: 6, message: '密码至少 6 位，并符合平台密码策略' }] },
                    editForm: { show: false }, viewForm: { show: false },
                },
                tenantName: {
                    title: '所属租户',
                    type: 'text',
                    column: { width: 140 },
                    addForm: {
                        show: false,
                    },
                    editForm: {
                        show: false,
                    },
                },
                customerName: {
                    title: '所属客户',
                    type: 'text',
                    column: { width: 140 },
                    addForm: {
                        show: false,
                    },
                    editForm: {
                        show: false,
                    },
                },
                customerId: {
                    title: '所属客户',
                    type: 'dict-select',
                    dict: customerDict,
                    column: { show: false },
                    addForm: {
                        show: true,
                        component: { clearable: false, filterable: true, placeholder: '请选择所属客户' },
                        rules: [{ required: true, message: '请选择所属客户' }],
                    },
                    editForm: {
                        show: true,
                        component: { clearable: false, filterable: true, placeholder: '请选择所属客户' },
                        rules: [{ required: true, message: '请选择所属客户' }],
                    },
                },
                roleNames: {
                    title: '绑定角色',
                    type: 'dict-select',
                    dict: roleDict,
                    column: { width: 230, showOverflowTooltip: true },
                    addForm: {
                        show: true,
                        value: ['NormalUser'],
                        component: {
                            multiple: true, filterable: true, collapseTags: true,
                            collapseTagsTooltip: true, placeholder: '选择一个或多个角色',
                        },
                        helper: '默认普通用户；系统管理员可追加管理或自定义角色',
                        rules: [{ required: true, message: '请选择用户角色' }],
                    },
                    editForm: {
                        show: true,
                        component: {
                            multiple: true, filterable: true, collapseTags: true,
                            collapseTagsTooltip: true, placeholder: '选择一个或多个角色',
                        },
                        helper: '改动角色后，相关用户重新登录才会获得新的权限',
                        rules: [{ required: true, message: '请选择用户角色' }],
                    },
                },
                userSource: {
                    title: '账号来源',
                    type: 'dict-select',
                    column: { width: 110 },
                    dict: dict({
                        data: [
                            { value: 'Local', label: '本地' },
                            { value: 'IAM', label: 'IAM' },
                        ],
                    }),
                    addForm: { show: false },
                    editForm: { show: false },
                },
                iamUserId: {
                    title: 'IAM 用户标识',
                    type: 'text',
                    column: { width: 260, showOverflowTooltip: true },
                    addForm: { show: false },
                    editForm: { show: false },
                },
                //id: {
                //	title: 'Id',
                //	type: 'text',
                //	column: { width: 300 },
                //	addForm: {
                //		show: false,
                //	},
                //	editForm: {
                //		show: false,
                //	},
                //},
                userName: {
                    title: '登录账号',
                    type: 'text',
                    column: { width: 200 },
                    search: { show: true }, //显示查询
                    addForm: {
                        show: true,
                        component: requiredCustomSwitchComponent,
                    },
                    editForm: {
                        show: true,
                        component: requiredCustomSwitchComponent,
                    },
                },
                displayName: {
                    title: '姓名',
                    type: 'text',
                    column: { width: 150, showOverflowTooltip: true },
                    addForm: { show: true },
                    editForm: { show: true },
                },
                email: {
                    title: '邮件',
                    column: { width: 200 },
                    type: 'text',
                    addForm: {
                        show: true,
                        component: requiredCustomSwitchComponent,
                    },
                    editForm: {
                        show: true,
                        component: requiredCustomSwitchComponent,
                    },
                },
                phoneNumber: {
                    title: '电话',
                    column: { width: 140 },
                    type: 'text',
                    addForm: {
                        show: true,
                        component: customSwitchComponent,
                    },
                    editForm: {
                        show: true,
                        component: customSwitchComponent,
                    },
                },
                accessFailedCount: {
                    title: '登录失败次数',
                    column: { width: 135 },
                    type: 'text',
                    addForm: {
                        show: false,
                    },
                    editForm: {
                        show: false,
                    },
                },
                lockoutEnabled: {
                    title: '锁定',
                    addForm: {
                        show: false,
                    },
                    column: {
                        width: 100,
                        component: {
                            name: 'fs-dict-switch',
                            show: true,
                            disabled: compute((context) => context.row.userSource === 'IAM'),
                            onChange: compute((context) => {
                                return async () => {
                                    const { id: Id, lockoutEnabled } = context.row;
                                    await accountApi().updateAccountStatus({
                                        Id,
                                        opt: lockoutEnabled ? 'Lock' : 'Unlock',
                                    });
                                };
                            }),
                        },
                    },
                    editForm: {
                        show: false,
                    },
                },
                lockoutEnd: {
                    addForm: {
                        show: false,
                    },
                    title: '锁定截止时间',
                    //column: { width: 150 },
                    type: 'text',
                    editForm: {
                        show: false,
                    },
                },
            },
        },
    };
};
