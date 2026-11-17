<template>
  <div class="role-management">
    <div class="role-head">
      <div>
        <div class="role-eyebrow">系统管理 / 授权角色</div>
        <h2>角色管理</h2>
        <p>展示系统真实角色和当前账号权限范围内的角色成员，不使用演示数据。</p>
      </div>
      <div class="role-header-actions">
        <el-button v-if="isSystemAdmin" :loading="provisioning" @click="provisionPdmRoles">
          初始化 PdM 职责角色
        </el-button>
        <el-button v-if="isSystemAdmin" type="primary" @click="openCreate">新增角色</el-button>
        <el-button :loading="loading" @click="loadRoles">刷新角色</el-button>
      </div>
    </div>
    <div class="role-metrics">
      <div><span>系统角色</span><strong>{{ data?.total ?? 0 }}</strong></div>
      <div><span>已分配成员关系</span><strong>{{ membershipTotal }}</strong></div>
      <div><span>内置角色</span><strong>{{ data?.rows.filter(x => x.builtIn).length ?? 0 }}</strong></div>
    </div>
    <div class="role-card">
      <div class="role-toolbar">
        <h3>角色列表</h3>
        <el-input v-model="keyword" clearable placeholder="搜索角色名称或说明" style="max-width: 300px" />
      </div>
      <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon class="role-alert" />
      <el-table :data="filtered" v-loading="loading" row-key="id" stripe empty-text="暂无可访问的角色数据">
        <el-table-column prop="displayName" label="角色名称" min-width="180">
          <template #default="{ row }"><strong>{{ row.displayName }}</strong></template>
        </el-table-column>
        <el-table-column prop="name" label="角色标识" min-width="180" />
        <el-table-column prop="description" label="角色说明" min-width="270" show-overflow-tooltip />
        <el-table-column prop="memberCount" label="成员数量" width="130" />
        <el-table-column label="角色类型" width="130">
          <template #default="{ row }">
            <el-tag :type="row.builtIn ? 'info' : 'success'" size="small">
              {{ row.builtIn ? '系统内置' : '自定义' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="308" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="openMembers(row)">查看成员</el-button>
            <el-button v-if="isSystemAdmin" type="primary" link :disabled="row.builtIn"
              @click="openRolePermissions(row)">权限</el-button>
            <el-button v-if="isSystemAdmin" type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button v-if="isSystemAdmin" type="danger" link :disabled="row.builtIn" @click="removeRole(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="role-note">可新增、编辑、删除自定义角色并管理角色成员；内置角色支持修改显示名称及说明，不能删除或修改角色标识。只有系统管理员可以提交修改，角色授权变更后相关用户需重新登录。</p>
    </div>

    <el-drawer v-model="membersOpen" :title="`${selectedRole?.displayName ?? ''} · 角色成员`" size="min(690px,94vw)">
      <div v-if="isSystemAdmin" class="role-member-actions">
        <el-select v-model="candidateId" filterable remote clearable
          :remote-method="searchUsers" :loading="candidatesLoading"
          placeholder="搜索要加入角色的用户名或邮箱" style="min-width: 260px; flex: 1">
          <el-option v-for="user in candidates" :key="user.id"
            :label="`${user.name}（${user.email || user.id}）`" :value="user.id" />
        </el-select>
        <el-button type="primary" :loading="membershipBusy"
          :disabled="!candidateId" @click="addMember">添加成员</el-button>
      </div>
      <el-alert v-if="membersError" :title="membersError" type="error" :closable="false" show-icon class="role-alert" />
      <el-table v-loading="membersLoading" :data="members?.rows ?? []" stripe row-key="id"
        empty-text="当前授权范围内没有该角色成员">
        <el-table-column label="用户名称" prop="name" min-width="175" show-overflow-tooltip />
        <el-table-column label="邮箱" prop="email" min-width="220" show-overflow-tooltip />
        <el-table-column v-if="isSystemAdmin" label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" :disabled="membershipBusy" @click="removeMember(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="memberPage" background layout="total,prev,pager,next"
        :page-size="20" :total="members?.total ?? 0" @current-change="loadMembers" class="role-pagination" />
    </el-drawer>

    <el-dialog v-model="permissionsOpen" :title="`${permissionsRole?.displayName ?? ''} · 权限分配`"
      width="min(610px,94vw)" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon
        title="仅配置平台已实现的权限码；已有 API 的角色限制和租户/客户范围仍然生效"
        description="自定义角色的授权保存在 Identity 角色声明中，不会自动创建菜单、绕过业务审批或获得系统管理员权限。" />
      <div v-loading="permissionsLoading" style="min-height: 135px; padding-top: 18px;">
        <el-checkbox-group v-model="selectedPermissions" style="display: grid; gap: 12px;">
          <el-checkbox v-for="permission in permissionCatalog" :key="permission.code"
            :label="permission.code">
            {{ permission.displayName }}（{{ permission.code }}）
          </el-checkbox>
        </el-checkbox-group>
      </div>
      <template #footer>
        <el-button @click="permissionsOpen = false">取消</el-button>
        <el-button type="primary" :loading="permissionsSaving" :disabled="permissionsLoading"
          @click="saveRolePermissions">保存权限</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="formOpen" :title="formMode === 'create' ? '新增角色' : '编辑角色'"
      width="min(530px,94vw)" destroy-on-close>
      <el-alert v-if="formMode === 'edit' && editingRole?.builtIn"
        title="内置角色的权限标识受到保护，只能调整显示名称和说明"
        type="info" :closable="false" show-icon class="role-alert" />
      <el-form label-position="top" :model="roleForm">
        <el-form-item label="角色标识（英文、数字、下划线或连字符）" required>
          <el-input v-model="roleForm.name" maxlength="64" show-word-limit
            :disabled="formMode === 'edit' && editingRole?.builtIn === true"
            placeholder="例如 MaintenanceOperator" />
        </el-form-item>
        <el-form-item label="角色显示名称" required>
          <el-input v-model="roleForm.displayName" maxlength="100" show-word-limit
            placeholder="例如 维修操作员" />
        </el-form-item>
        <el-form-item label="角色说明">
          <el-input v-model="roleForm.description" type="textarea" :rows="3"
            maxlength="500" show-word-limit placeholder="描述角色的职责和使用场景" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formOpen = false">取消</el-button>
        <el-button type="primary" :loading="formSaving" :disabled="!validForm"
          @click="saveRole">保存角色</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useUserInfo } from '/@/stores/userInfo';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getSystemRoles, getSystemRoleMembers, getEligibleRoleUsers,
  createSystemRole, updateSystemRole, deleteSystemRole, ensurePdmDutyRoles,
  getRolePermissionCatalog, getRolePermissions, setRolePermissions,
  addSystemRoleMember, removeSystemRoleMember } from '/@/api/roles';
import type { SystemRole, SystemRoleList, RoleMemberList, RoleMember, RoleWriteInput,
  RolePermissionOption } from '/@/api/roles';

const { userInfos } = storeToRefs(useUserInfo());
const isSystemAdmin = computed(() =>
  String(userInfos.value.roles ?? '').toLowerCase().includes('systemadmin'));
const provisioning = ref(false);
const permissionsOpen = ref(false);
const permissionsRole = ref<SystemRole | null>(null);
const permissionCatalog = ref<RolePermissionOption[]>([]);
const selectedPermissions = ref<string[]>([]);
const permissionsLoading = ref(false);
const permissionsSaving = ref(false);
async function openRolePermissions(value: unknown) {
  const role = value as SystemRole;
  if (role.builtIn || !isSystemAdmin.value) return;
  permissionsRole.value = role;
  selectedPermissions.value = [];
  permissionsOpen.value = true;
  permissionsLoading.value = true;
  try {
    const [catalog, assigned] = await Promise.all([
      getRolePermissionCatalog(), getRolePermissions(role.id),
    ]);
    permissionCatalog.value = catalog.data ?? [];
    selectedPermissions.value = assigned.data?.permissions ?? [];
  } catch {
    ElMessage.error('权限读取失败，请检查角色权限或后台服务');
    permissionsOpen.value = false;
  } finally { permissionsLoading.value = false; }
}
async function saveRolePermissions() {
  const role = permissionsRole.value;
  if (!role || permissionsSaving.value || !isSystemAdmin.value) return;
  try {
    await ElMessageBox.confirm(
      `确认更新「${role.displayName}」的权限？将影响使用该角色的全部用户，请核对授权范围。`,
      '确认权限变更', { type: 'warning' });
  } catch { return; }
  permissionsSaving.value = true;
  try {
    await setRolePermissions(role.id, selectedPermissions.value);
    ElMessage.success('角色权限已保存，用户重新登录后生效');
    permissionsOpen.value = false;
  } catch { ElMessage.error('保存角色权限失败，权限码无效或角色已发生变化'); }
  finally { permissionsSaving.value = false; }
}
async function provisionPdmRoles() {
  if (!isSystemAdmin.value || provisioning.value) return;
  try {
    await ElMessageBox.confirm(
      '创建工单管理员、维修技术员、独立审批员三个角色；不会自动给任何用户授予审批权限。继续？',
      '初始化预测性维护职责角色', {
        type: 'warning', confirmButtonText: '确认初始化', cancelButtonText: '取消',
      });
  } catch { return; }
  provisioning.value = true;
  try {
    await ensurePdmDutyRoles();
    ElMessage.success('预测性维护职责角色已就绪，请在用户管理分配对应职责');
    await loadRoles();
  } catch { ElMessage.error('初始化角色失败，请检查系统管理员权限或后台审计'); }
  finally { provisioning.value = false; }
}

const loading = ref(false);
const error = ref('');
const data = ref<SystemRoleList | null>(null);
const keyword = ref('');
const filtered = computed(() => (data.value?.rows ?? []).filter(r => {
  const q = keyword.value.trim().toLowerCase();
  return !q || [r.name, r.displayName, r.description]
    .some(v => v.toLowerCase().includes(q));
}));
const membershipTotal = computed(() => (data.value?.rows ?? [])
  .reduce((sum, role) => sum + role.memberCount, 0));
const membersOpen = ref(false);
const selectedRole = ref<SystemRole | null>(null);
const memberPage = ref(1);
const membersLoading = ref(false);
const membersError = ref('');
const members = ref<RoleMemberList | null>(null);
const formOpen = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const editingRole = ref<SystemRole | null>(null);
const roleForm = ref<RoleWriteInput>({ name: '', displayName: '', description: '' });
const formSaving = ref(false);
const membershipBusy = ref(false);
const candidateId = ref('');
const candidates = ref<RoleMember[]>([]);
const candidatesLoading = ref(false);
const validForm = computed(() =>
  /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(roleForm.value.name.trim()) &&
  roleForm.value.displayName.trim().length > 0 &&
  roleForm.value.displayName.trim().length <= 100);
let memberRequest = 0;

async function loadRoles() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const response = await getSystemRoles();
    data.value = response.data;
  } catch {
    data.value = null;
    error.value = '角色获取失败，请检查账号权限、后端服务或数据库。';
  } finally {
    loading.value = false;
  }
}
async function loadMembers() {
  const role = selectedRole.value;
  if (!role) return;
  const seq = ++memberRequest;
  membersLoading.value = true;
  membersError.value = '';
  try {
    const response = await getSystemRoleMembers(role.id, memberPage.value);
    if (seq === memberRequest) members.value = response.data;
  } catch {
    if (seq === memberRequest) {
      members.value = null;
      membersError.value = '角色成员读取失败，请检查当前账号的权限。';
    }
  } finally {
    if (seq === memberRequest) membersLoading.value = false;
  }
}
function openMembers(value: unknown) {
  const role = value as SystemRole;
  selectedRole.value = role;
  memberPage.value = 1;
  members.value = null;
  membersOpen.value = true;
  void loadMembers();
  if (isSystemAdmin.value) void searchUsers('');
}
function openCreate() {
  if (!isSystemAdmin.value) return;
  formMode.value = 'create';
  editingRole.value = null;
  roleForm.value = { name: '', displayName: '', description: '' };
  formOpen.value = true;
}
function openEdit(value: unknown) {
  if (!isSystemAdmin.value) return;
  const role = value as SystemRole;
  formMode.value = 'edit';
  editingRole.value = role;
  roleForm.value = {
    name: role.name, displayName: role.displayName, description: role.description,
  };
  formOpen.value = true;
}
async function saveRole() {
  if (!isSystemAdmin.value || !validForm.value || formSaving.value) return;
  formSaving.value = true;
  try {
    const input = {
      name: roleForm.value.name.trim(), displayName: roleForm.value.displayName.trim(),
      description: roleForm.value.description.trim(),
    };
    if (formMode.value === 'create') await createSystemRole(input);
    else if (editingRole.value) await updateSystemRole(editingRole.value.id, input);
    ElMessage.success('角色已保存');
    formOpen.value = false;
    await loadRoles();
  } catch { ElMessage.error('角色保存失败，请确认名称未重复且拥有管理权限'); }
  finally { formSaving.value = false; }
}
async function removeRole(value: unknown) {
  if (!isSystemAdmin.value) return;
  const role = value as SystemRole;
  if (role.builtIn) return;
  try {
    await ElMessageBox.confirm(
      `确定删除自定义角色「${role.displayName}」？必须先移除所有成员，此操作不可恢复。`,
      '删除角色', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' });
  } catch { return; }
  try {
    await deleteSystemRole(role.id);
    ElMessage.success('角色已删除');
    await loadRoles();
  } catch { ElMessage.error('删除失败：可能仍有成员、角色受保护或权限不足'); }
}
let candidateRequest = 0;
async function searchUsers(search: string) {
  const seq = ++candidateRequest;
  candidatesLoading.value = true;
  try {
    const res = await getEligibleRoleUsers(search);
    if (seq === candidateRequest) candidates.value = res.data?.rows ?? [];
  } catch {
    if (seq === candidateRequest) candidates.value = [];
  } finally { if (seq === candidateRequest) candidatesLoading.value = false; }
}
async function addMember() {
  if (!isSystemAdmin.value || !selectedRole.value || !candidateId.value || membershipBusy.value) return;
  membershipBusy.value = true;
  try {
    await addSystemRoleMember(selectedRole.value.id, candidateId.value);
    candidateId.value = '';
    ElMessage.success('成员添加成功，成员需重新登录后权限才会更新');
    await Promise.all([loadMembers(), loadRoles()]);
  } catch { ElMessage.error('添加成员失败，可能已加入该角色或无授权'); }
  finally { membershipBusy.value = false; }
}
async function removeMember(value: unknown) {
  if (!isSystemAdmin.value) return;
  const member = value as RoleMember;
  if (!selectedRole.value || membershipBusy.value) return;
  try {
    await ElMessageBox.confirm(`确定将「${member.name}」移出当前角色？`,
      '移除角色成员', { type: 'warning' });
  } catch { return; }
  membershipBusy.value = true;
  try {
    await removeSystemRoleMember(selectedRole.value.id, member.id);
    ElMessage.success('成员已移除，权限变更在重新登录后生效');
    await Promise.all([loadMembers(), loadRoles()]);
  } catch { ElMessage.error('移除失败，系统不允许移除最后一个超级管理员或当前超级管理员自己'); }
  finally { membershipBusy.value = false; }
}
onMounted(() => { void loadRoles(); });
</script>

<style scoped lang="scss">
.role-management { display: grid; gap: 18px; padding: 20px; }
.role-head { display: flex; justify-content: space-between; align-items: center; gap: 18px; }
.role-head h2 { margin: 7px 0; font-size: 25px; }
.role-head p { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.role-eyebrow { font-size: 12px; color: var(--el-color-primary); font-weight: 700; }
.role-metrics { display: grid; gap: 12px; grid-template-columns: repeat(3,minmax(0,1fr)); }
.role-metrics>div,.role-card { padding: 18px; background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 12px; }
.role-metrics span { display: block; font-size: 12px; color: var(--el-text-color-secondary); }
.role-metrics strong { display: block; margin-top: 8px; font-size: 26px; }
.role-toolbar { display: flex; gap: 16px; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.role-header-actions,.role-member-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.role-member-actions { margin: 0 0 16px; }
.role-toolbar h3 { margin: 0; font-size: 17px; }
.role-alert { margin: 10px 0; }
.role-note { margin: 14px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.role-pagination { margin-top: 16px; justify-content: flex-end; }
@media(max-width:700px) { .role-head,.role-toolbar { flex-direction: column; align-items: flex-start; } .role-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); } }
</style>
