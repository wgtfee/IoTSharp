import { IListQueryParam } from '../iapiresult';
import request from '/@/utils/request';

/**
 * 用户api接口集合
 * @method accountList 用户列表
 * @method getAccount 获取用户
 * @method postAccount 新增用户
 * @method putAccount 修改用户
 * @method deleteAccount 删除用户
 */
export function accountApi() {
	return {
		accountList: (params: CustomerQueryParam) => {
			return request({
				url: `/api/Account/List`,
				method: 'get',
				params,
			});
		},
		getAccount: (id: string) => {
			return request({
				url: '/api/Account/Get',
				method: 'get',
				params: { id },
			});
		},

        /** 调用受角色与客户范围保护的创建接口，不使用匿名注册入口。 */
        postAccount: (data: CreateAccountInput) => request({
            url: '/api/Account/PostAccount', method: 'post', data,
        }),
		putAccount: (data: any) => {
			return request({
				url: '/api/Account/Modify',
				method: 'put',
				data: data,
			});
		},
		updateAccountStatus: (data: any) => {
			return request({
				url: '/api/Account/Lock',
				method: 'put',
				data: data,
			});
		},
		deleteAccount: (id: string) => {
			return request({
				url: '/api/Account/' + id,
				method: 'delete',
				data: {},
			});
		},
	};
}

export interface CustomerQueryParam extends IListQueryParam {
	name?: string;
	customerId?: string;
}

export interface CreateAccountInput {
    userName: string;
    email: string;
    password: string;
    phoneNumber?: string;
    customerId?: string;
}
