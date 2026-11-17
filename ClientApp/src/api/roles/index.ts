import request from '/@/utils/request';

export interface SystemRole {
  id: string;
  name: string;
  displayName: string;
  description: string;
  memberCount: number;
  builtIn: boolean;
}
export interface SystemRoleList { total: number; rows: SystemRole[] }
export interface RoleMember { id: string; name: string; email: string }
export interface RoleMemberList {
  total: number;
  page: number;
  pageSize: number;
  rows: RoleMember[];
}
export interface RoleWriteInput { name: string; displayName: string; description: string }
export interface RolePermissionOption { code: string; displayName: string }
export interface RolePermissionsView {
  roleId: string;
  editable: boolean;
  permissions: string[];
}
interface ApiResult<T> { code: number; info: string; data: T }

export const getSystemRoles = (): Promise<ApiResult<SystemRoleList>> =>
  request.get('/api/role-management/roles') as unknown as Promise<ApiResult<SystemRoleList>>;

export const getSystemRoleMembers = (roleId: string, page = 1, pageSize = 20):
  Promise<ApiResult<RoleMemberList>> =>
  request.get(`/api/role-management/roles/${encodeURIComponent(roleId)}/members`, {
    params: { page, pageSize },
  }) as unknown as Promise<ApiResult<RoleMemberList>>;

export const createSystemRole = (input: RoleWriteInput) =>
  request.post('/api/role-management/roles', input);
/** Explicitly create the three protected PdM duty roles, without assigning members. */
export const ensurePdmDutyRoles = () =>
  request.post('/api/role-management/ensure-pdm-roles', {
    confirmation: '确认初始化预测性维护职责角色',
  });
export const getRolePermissionCatalog = (): Promise<ApiResult<RolePermissionOption[]>> =>
  request.get('/api/role-management/permission-catalog') as unknown as
    Promise<ApiResult<RolePermissionOption[]>>;
export const getRolePermissions = (roleId: string): Promise<ApiResult<RolePermissionsView>> =>
  request.get(`/api/role-management/roles/${encodeURIComponent(roleId)}/permissions`) as unknown as
    Promise<ApiResult<RolePermissionsView>>;
export const setRolePermissions = (roleId: string, permissions: string[]) =>
  request.put(`/api/role-management/roles/${encodeURIComponent(roleId)}/permissions`, {
    permissions,
  });
export const updateSystemRole = (id: string, input: RoleWriteInput) =>
  request.put(`/api/role-management/roles/${encodeURIComponent(id)}`, input);
export const deleteSystemRole = (id: string) =>
  request.delete(`/api/role-management/roles/${encodeURIComponent(id)}`);
export const getEligibleRoleUsers = (search = '', page = 1, pageSize = 100):
  Promise<ApiResult<RoleMemberList>> =>
  request.get('/api/role-management/eligible-users', {
    params: { search, page, pageSize },
  }) as unknown as Promise<ApiResult<RoleMemberList>>;
export const addSystemRoleMember = (roleId: string, userId: string) =>
  request.post(`/api/role-management/roles/${encodeURIComponent(roleId)}/members`, { userId });
export const removeSystemRoleMember = (roleId: string, userId: string) =>
  request.delete(`/api/role-management/roles/${encodeURIComponent(roleId)}/members/${encodeURIComponent(userId)}`);
