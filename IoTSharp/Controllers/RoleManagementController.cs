using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.IndustrialSecurity;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace IoTSharp.Controllers;

public sealed record RoleListRow(
    string Id, string Name, string DisplayName, string Description,
    int MemberCount, bool BuiltIn);
public sealed record RoleListPage(int Total, IReadOnlyList<RoleListRow> Rows);
public sealed record RoleMemberRow(string Id, string Name, string Email);
public sealed record RoleMemberPage(
    int Total, int Page, int PageSize, IReadOnlyList<RoleMemberRow> Rows);
public sealed record RoleWriteRequest(string Name, string DisplayName, string Description);
public sealed record RoleMemberWriteRequest(string UserId);
public sealed record PdmRoleProvisionRequest(string Confirmation);
public sealed record RolePermissionWriteRequest(List<string> Permissions);

/// <summary>
/// CRUD view of the real ASP.NET Identity role catalog. Role membership
/// counts and member details are restricted to the requester's authorized
/// tenant/customer scope; this never manufactures roles from menu strings.
/// </summary>
[ApiController]
[Authorize(Roles = "SystemAdmin,TenantAdmin,CustomerAdmin")]
[Route("api/role-management")]
public sealed class RoleManagementController(
    ApplicationDbContext db,
    RoleManager<IdentityRole> roleManager,
    UserManager<IdentityUser> userManager,
    IServiceProvider services,
    ILogger<RoleManagementController> logger) : ControllerBase
{
    private const string LabelClaim = "iotsharp.role.label";
    private const string DescriptionClaim = "iotsharp.role.description";
    private static readonly HashSet<string> ProtectedRoles = new(StringComparer.OrdinalIgnoreCase)
    { "Anonymous", "NormalUser", "CustomerAdmin", "TenantAdmin", "SystemAdmin",
      "PdmReviewApprover", "PdmWorkOrderManager", "PdmTechnician" };
    private void AddSecurityAudit(string action, string roleId, string roleName,
        object details, Guid? tenantId = null, Guid? customerId = null)
    {
        db.AuditLog.Add(new AuditLog
        {
            TenantId = tenantId, CustomerId = customerId,
            UserId = User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "",
            UserName = User.Identity?.Name ?? "SystemAdmin",
            ObjectID = Guid.TryParse(roleId, out var parsed) ? parsed : Guid.Empty,
            ObjectName = roleName, ObjectType = ObjectType.Unknow,
            ActionName = action, ActionData = JsonSerializer.Serialize(details),
            ActionResult = "Success", ActiveDateTime = DateTime.UtcNow
        });
    }
    private static readonly Regex RoleNamePattern = new(
        "^[A-Za-z][A-Za-z0-9_-]{1,63}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static (string Display, string Description, bool BuiltIn) Describe(string name)
        => name switch
        {
            "Anonymous" => ("匿名访问", "系统预置的匿名访问角色。", true),
            "NormalUser" => ("普通用户", "设备、告警和业务页面的基础访问角色。", true),
            "CustomerAdmin" => ("客户管理员", "管理当前客户范围内的用户和业务。", true),
            "TenantAdmin" => ("租户管理员", "管理当前租户的客户及业务资源。", true),
            "SystemAdmin" => ("系统管理员", "系统级管理与维护权限。", true),
            "PdmReviewApprover" => ("预测性维护审批员", "独立的P2审核职责，需经授权，不因系统管理员身份自动拥有。", true),
            "PdmWorkOrderManager" => ("维修工单管理员", "维修工单分派和关闭等管理职责。", true),
            "PdmTechnician" => ("维修技术员", "维修过程执行职责。", true),
            _ => (name, "自定义系统角色。", false)
        };

    private bool TryScope(out bool all, out Guid tenant, out Guid customer)
    {
        all = User.IsInRole("SystemAdmin");
        tenant = customer = Guid.Empty;
        if (all) return true;
        if (!Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out tenant) ||
            tenant == Guid.Empty) return false;
        if (User.IsInRole("TenantAdmin")) return true;
        return Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out customer) &&
            customer != Guid.Empty;
    }

    /// <summary>Composable SQL query avoids materializing every eligible user ID.</summary>
    private IQueryable<IdentityUser>? AllowedUsersQuery()
    {
        if (!TryScope(out var all, out var tenant, out var customer)) return null;
        var users = db.Users.AsNoTracking();
        if (all) return users;
        var tenantValue = tenant.ToString("D");
        users = users.Where(user => db.UserClaims.Any(claim =>
            claim.UserId == user.Id &&
            claim.ClaimType == IoTSharpClaimTypes.Tenant &&
            claim.ClaimValue == tenantValue));
        if (User.IsInRole("TenantAdmin")) return users;
        var customerValue = customer.ToString("D");
        return users.Where(user => db.UserClaims.Any(claim =>
            claim.UserId == user.Id &&
            claim.ClaimType == IoTSharpClaimTypes.Customer &&
            claim.ClaimValue == customerValue));
    }

    [HttpGet("roles")]
    public async Task<IActionResult> Roles(CancellationToken ct = default)
    {
        var allowed = AllowedUsersQuery();
        if (allowed is null) return Forbid();
        var allowedIds = allowed.Select(user => user.Id);
        var roles = await db.Roles.AsNoTracking()
            .OrderBy(x => x.Name).Select(x => new { x.Id, x.Name })
            .ToListAsync(ct);
        var roleIds = roles.Select(x => x.Id).ToArray();
        var metadata = await db.RoleClaims.AsNoTracking()
            .Where(x => roleIds.Contains(x.RoleId) &&
                (x.ClaimType == LabelClaim || x.ClaimType == DescriptionClaim))
            .Select(x => new { x.RoleId, x.ClaimType, x.ClaimValue })
            .ToListAsync(ct);
        var membership = await db.UserRoles.AsNoTracking()
            .Where(x => allowedIds.Contains(x.UserId))
            .GroupBy(x => x.RoleId)
            .Select(x => new { RoleId = x.Key, Count = x.Count() })
            .ToListAsync(ct);
        var counts = membership.ToDictionary(x => x.RoleId, x => x.Count);
        var rows = roles.Select(r =>
        {
            var name = r.Name ?? "";
            var (display, description, builtIn) = Describe(name);
            var label = metadata.FirstOrDefault(x => x.RoleId == r.Id &&
                x.ClaimType == LabelClaim)?.ClaimValue;
            var details = metadata.FirstOrDefault(x => x.RoleId == r.Id &&
                x.ClaimType == DescriptionClaim)?.ClaimValue;
            return new RoleListRow(r.Id, name,
                string.IsNullOrWhiteSpace(label) ? display : label,
                string.IsNullOrWhiteSpace(details) ? description : details,
                counts.GetValueOrDefault(r.Id), builtIn);
        }).ToArray();
        return Ok(new ApiResult<RoleListPage>(ApiCode.Success, "OK",
            new(rows.Length, rows)));
    }

    [HttpGet("roles/{roleId}/members")]
    public async Task<IActionResult> Members(string roleId,
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(roleId) || roleId.Length > 450 ||
            page is < 1 or > 10000 || pageSize is < 1 or > 100)
            return BadRequest("角色或分页参数无效");
        var allowed = AllowedUsersQuery();
        if (allowed is null) return Forbid();
        var allowedIds = allowed.Select(user => user.Id);
        if (!await db.Roles.AnyAsync(x => x.Id == roleId, ct)) return NotFound();

        var membership = db.UserRoles.AsNoTracking()
            .Where(x => x.RoleId == roleId && allowedIds.Contains(x.UserId));
        var total = await membership.CountAsync(ct);
        var memberIds = await membership
            .OrderBy(x => x.UserId).Skip((page - 1) * pageSize)
            .Take(pageSize).Select(x => x.UserId).ToArrayAsync(ct);
        var users = await db.Users.AsNoTracking()
            .Where(x => memberIds.Contains(x.Id))
            .Select(x => new RoleMemberRow(x.Id, x.UserName ?? "", x.Email ?? ""))
            .ToListAsync(ct);
        var byId = users.ToDictionary(x => x.Id);
        var rows = memberIds.Where(byId.ContainsKey).Select(x => byId[x]).ToArray();
        return Ok(new ApiResult<RoleMemberPage>(ApiCode.Success, "OK",
            new(total, page, pageSize, rows)));
    }

    [HttpGet("eligible-users")]
    public async Task<IActionResult> EligibleUsers(
        [FromQuery] string? search = null, [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30, CancellationToken ct = default)
    {
        if (page is < 1 or > 10000 || pageSize is < 1 or > 100 ||
            search is { Length: > 100 })
            return BadRequest("查询参数无效");
        var allowed = AllowedUsersQuery();
        if (allowed is null) return Forbid();
        var query = allowed;
        if (!string.IsNullOrWhiteSpace(search))
        {
            var keyword = search.Trim();
            query = query.Where(x =>
                (x.UserName != null && x.UserName.Contains(keyword)) ||
                (x.Email != null && x.Email.Contains(keyword)));
        }
        var total = await query.CountAsync(ct);
        var rows = await query.OrderBy(x => x.UserName).ThenBy(x => x.Id)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new RoleMemberRow(x.Id, x.UserName ?? "", x.Email ?? ""))
            .ToListAsync(ct);
        return Ok(new ApiResult<RoleMemberPage>(ApiCode.Success, "OK",
            new(total, page, pageSize, rows)));
    }

    [HttpGet("permission-catalog")]
    public IActionResult PermissionCatalog() =>
        Ok(new ApiResult<object>(ApiCode.Success, "OK",
            IotRolePermissionCatalog.Descriptions.Select(x =>
                new { code = x.Key, displayName = x.Value }).ToArray()));

    [HttpGet("roles/{roleId}/permissions")]
    public async Task<IActionResult> RolePermissions(string roleId, CancellationToken ct = default)
    {
        var role = await roleManager.FindByIdAsync(roleId);
        if (role is null) return NotFound();
        var values = await db.RoleClaims.AsNoTracking()
            .Where(c => c.RoleId == role.Id &&
                c.ClaimType == IotRolePermissionCatalog.ClaimType)
            .Select(c => c.ClaimValue).ToArrayAsync(ct);
        var assigned = values.Where(value => value is not null &&
            IotRolePermissionCatalog.Descriptions.ContainsKey(value))
            .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToArray();
        return Ok(new ApiResult<object>(ApiCode.Success, "OK",
            new { roleId = role.Id, editable = !ProtectedRoles.Contains(role.Name ?? ""),
                permissions = assigned }));
    }

    [HttpPut("roles/{roleId}/permissions")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> UpdateRolePermissions(string roleId,
        [FromBody] RolePermissionWriteRequest request, CancellationToken ct = default)
    {
        if (request?.Permissions is null || request.Permissions.Count > 32 ||
            request.Permissions.Any(p => string.IsNullOrWhiteSpace(p) ||
                !IotRolePermissionCatalog.Descriptions.ContainsKey(p.Trim())))
            return BadRequest("权限码必须来自平台支持的权限目录");
        var role = await roleManager.FindByIdAsync(roleId);
        if (role is null) return NotFound();
        if (ProtectedRoles.Contains(role.Name ?? ""))
            return Conflict("内置及预测性维护专用职责角色不可通过通用权限配置提权");
        var desired = request.Permissions.Select(x =>
            IotRolePermissionCatalog.Descriptions.Keys.First(code =>
                string.Equals(code, x.Trim(), StringComparison.OrdinalIgnoreCase)))
            .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToArray();

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        var roleClaims = (await roleManager.GetClaimsAsync(role))
            .Where(x => x.Type == IotRolePermissionCatalog.ClaimType).ToArray();
        var before = roleClaims.Select(x => x.Value).Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x).ToArray();
        foreach (var claim in roleClaims.Where(x => !desired.Contains(x.Value,
                     StringComparer.OrdinalIgnoreCase)))
        {
            var removed = await roleManager.RemoveClaimAsync(role, claim);
            if (!removed.Succeeded)
                return Conflict("无法移除旧角色权限，请刷新角色后重试");
        }
        foreach (var name in desired.Except(before, StringComparer.OrdinalIgnoreCase))
        {
            var added = await roleManager.AddClaimAsync(role,
                new Claim(IotRolePermissionCatalog.ClaimType, name));
            if (!added.Succeeded)
                return Conflict("角色权限写入失败，请刷新重试");
        }
        AddSecurityAudit("ROLE_PERMISSIONS_UPDATED", role.Id, role.Name ?? "",
            new { before, after = desired });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        logger.LogInformation("ROLE_PERMISSIONS_UPDATED actor={Actor} role={Role}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), role.Id);
        return Ok(new ApiResult<object>(ApiCode.Success,
            "角色权限已保存；现有角色授权变更后相关用户需重新登录", new { roleId, permissions = desired }));
    }
    /// <summary>
    /// Install the three separately assignable PdM duty roles in an existing
    /// database. Does not grant the review-approval privilege to anyone.
    /// </summary>
    [HttpPost("ensure-pdm-roles")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> EnsurePdmRoles(
        [FromBody] PdmRoleProvisionRequest request, CancellationToken ct = default)
    {
        if (request?.Confirmation != "确认初始化预测性维护职责角色")
            return BadRequest("必须明确确认初始化职责角色；不会自动授权任何成员");
        string[] names = { "PdmReviewApprover", "PdmWorkOrderManager", "PdmTechnician" };
        var created = new List<string>();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        foreach (var name in names)
        {
            if (await roleManager.RoleExistsAsync(name)) continue;
            var role = new IdentityRole(name);
            var result = await roleManager.CreateAsync(role);
            if (!result.Succeeded)
                return Conflict("初始化角色失败：" +
                    string.Join("; ", result.Errors.Select(x => x.Description)));
            AddSecurityAudit("PDM_ROLE_PROVISIONED", role.Id, role.Name ?? name,
                new { name, assignedMembers = 0, approvalGrant = false });
            created.Add(name);
        }
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        logger.LogInformation("PDM_ROLES_PROVISIONED actor={Actor} added={Roles}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), string.Join(",", created));
        return Ok(new ApiResult<object>(ApiCode.Success,
            "职责角色已就绪；审批权限仍需独立分配", new { created }));
    }
    [HttpPost("roles")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> CreateRole([FromBody] RoleWriteRequest input)
    {
        if (!ValidInput(input) || ProtectedRoles.Contains(input.Name.Trim()))
            return BadRequest("角色标识、名称或说明不符合要求");
        var role = new IdentityRole(input.Name.Trim());
        await using var transaction = await db.Database.BeginTransactionAsync();
        var result = await roleManager.CreateAsync(role);
        if (!result.Succeeded) return Conflict(string.Join("；", result.Errors.Select(x => x.Description)));
        var saved = await SaveMetadataAsync(role, input);
        if (saved is not null) return saved;
        AddSecurityAudit("ROLE_CREATED", role.Id, role.Name ?? "",
            new { after = new { role.Name, input.DisplayName, input.Description } });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        logger.LogInformation("ROLE_CREATED actor={Actor} role={Role} name={Name}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), role.Id, role.Name);
        return Ok(new ApiResult<object>(ApiCode.Success, "角色已创建", new { role.Id, role.Name }));
    }

    [HttpPut("roles/{roleId}")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> UpdateRole(string roleId, [FromBody] RoleWriteRequest input)
    {
        if (!ValidInput(input)) return BadRequest("角色名称或说明不符合要求");
        var role = await roleManager.FindByIdAsync(roleId);
        if (role is null) return NotFound();
        var oldRoleName = role.Name;
        var oldMetadata = await roleManager.GetClaimsAsync(role);
        var desired = input.Name.Trim();
        if (ProtectedRoles.Contains(role.Name ?? "") &&
            !string.Equals(role.Name, desired, StringComparison.Ordinal))
            return Conflict("系统内置角色只允许修改显示名称和说明，不允许更改角色标识");
        await using var transaction = await db.Database.BeginTransactionAsync();
        if (!string.Equals(role.Name, desired, StringComparison.Ordinal))
        {
            if (ProtectedRoles.Contains(desired))
                return Conflict("不能使用保留的系统角色标识");
            role.Name = desired;
            var updated = await roleManager.UpdateAsync(role);
            if (!updated.Succeeded)
                return Conflict(string.Join("；", updated.Errors.Select(x => x.Description)));
        }
        var saved = await SaveMetadataAsync(role, input);
        if (saved is not null) return saved;
        AddSecurityAudit("ROLE_UPDATED", role.Id, role.Name ?? "", new
        {
            before = new
            {
                name = oldRoleName,
                label = oldMetadata.FirstOrDefault(c => c.Type == LabelClaim)?.Value,
                description = oldMetadata.FirstOrDefault(c => c.Type == DescriptionClaim)?.Value
            },
            after = new { role.Name, input.DisplayName, input.Description }
        });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        logger.LogInformation("ROLE_UPDATED actor={Actor} role={Role} name={Name}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), role.Id, role.Name);
        return Ok(new ApiResult<object>(ApiCode.Success,
            "角色已更新，变更角色标识后原成员需重新登录", new { role.Id, role.Name }));
    }

    [HttpDelete("roles/{roleId}")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> DeleteRole(string roleId, CancellationToken ct = default)
    {
        var role = await roleManager.FindByIdAsync(roleId);
        if (role is null) return NotFound();
        if (ProtectedRoles.Contains(role.Name ?? ""))
            return Conflict("系统内置角色不允许删除");
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        if (await db.UserRoles.AnyAsync(x => x.RoleId == roleId, ct))
            return Conflict("角色仍有成员，请先移除成员后再删除");
        var orders = services.GetService<PdmInternalWorkOrderDbContext>();
        if (orders is not null &&
            await orders.WorkOrders.AsNoTracking()
                .AnyAsync(x => x.AssignedRoleId == roleId, ct))
            return Conflict("角色仍被历史维修工单引用，不能删除；请保留历史审计关联");
        var result = await roleManager.DeleteAsync(role);
        if (!result.Succeeded)
            return Conflict(string.Join("；", result.Errors.Select(x => x.Description)));
        AddSecurityAudit("ROLE_DELETED", roleId, role.Name ?? "",
            new { before = new { role.Name, role.Id }, after = (string?)null });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        logger.LogInformation("ROLE_DELETED actor={Actor} role={Role} name={Name}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), roleId, role.Name);
        return Ok(new ApiResult<object>(ApiCode.Success, "角色已删除", new { roleId }));
    }

    [HttpPost("roles/{roleId}/members")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> AddMember(string roleId,
        [FromBody] RoleMemberWriteRequest input)
        => await ChangeMemberAsync(roleId, input, true);

    [HttpDelete("roles/{roleId}/members/{userId}")]
    [Authorize(Roles = "SystemAdmin")]
    public async Task<IActionResult> RemoveMember(string roleId, string userId)
        => await ChangeMemberAsync(roleId, new RoleMemberWriteRequest(userId), false);

    private async Task<IActionResult> ChangeMemberAsync(
        string roleId, RoleMemberWriteRequest input, bool add)
    {
        if (input is null || string.IsNullOrWhiteSpace(input.UserId))
            return BadRequest("请选择用户");
        var role = await roleManager.FindByIdAsync(roleId);
        var user = await userManager.FindByIdAsync(input.UserId);
        if (role is null || user is null) return NotFound();
        var roleName = role.Name ?? "";
        if (string.Equals(roleName, "SystemAdmin", StringComparison.OrdinalIgnoreCase) &&
            !add && User.FindFirstValue(ClaimTypes.NameIdentifier) == user.Id)
            return Conflict("不能撤销当前登录的超级管理员身份");
        // Protect the last admin against concurrent removal with a serializable
        // transaction over the membership count and Identity manager update.
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable);
        if (!add && string.Equals(roleName, "SystemAdmin", StringComparison.OrdinalIgnoreCase) &&
            await db.UserRoles.CountAsync(x => x.RoleId == roleId) <= 1)
            return Conflict("不能移除最后一个超级管理员");
        var isMember = await userManager.IsInRoleAsync(user, roleName);
        if (isMember == add) return Conflict(add ? "该用户已有此角色" : "用户没有此角色");
        var result = add
            ? await userManager.AddToRoleAsync(user, roleName)
            : await userManager.RemoveFromRoleAsync(user, roleName);
        if (!result.Succeeded)
            return Conflict(string.Join("；", result.Errors.Select(x => x.Description)));
        var scopedClaims = await userManager.GetClaimsAsync(user);
        var tenantId = Guid.TryParse(scopedClaims.FirstOrDefault(c =>
            c.Type == IoTSharpClaimTypes.Tenant)?.Value, out var parsedTenant)
            ? parsedTenant : (Guid?)null;
        var customerId = Guid.TryParse(scopedClaims.FirstOrDefault(c =>
            c.Type == IoTSharpClaimTypes.Customer)?.Value, out var parsedCustomer)
            ? parsedCustomer : (Guid?)null;
        AddSecurityAudit("ROLE_MEMBER_CHANGED", role.Id, roleName,
            new { targetUserId = user.Id, before = isMember, after = add },
            tenantId, customerId);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        logger.LogInformation("ROLE_MEMBER_CHANGED actor={Actor} role={Role} target={Target} added={Added}",
            User.FindFirstValue(ClaimTypes.NameIdentifier), role.Id, user.Id, add);
        return Ok(new ApiResult<object>(ApiCode.Success,
            add ? "已加入角色，用户重新登录后生效" : "已移除角色，用户重新登录后生效",
            new { roleId = role.Id, userId = user.Id, added = add }));
    }

    private static bool ValidInput(RoleWriteRequest? input) =>
        input is not null &&
        RoleNamePattern.IsMatch(input.Name?.Trim() ?? "") &&
        !string.IsNullOrWhiteSpace(input.DisplayName) &&
        input.DisplayName.Trim().Length <= 100 &&
        (input.Description?.Trim().Length ?? 0) <= 500;

    private async Task<IActionResult?> SaveMetadataAsync(IdentityRole role, RoleWriteRequest input)
    {
        var existing = await roleManager.GetClaimsAsync(role);
        foreach (var claim in existing.Where(c =>
                     c.Type is LabelClaim or DescriptionClaim))
        {
            var removed = await roleManager.RemoveClaimAsync(role, claim);
            if (!removed.Succeeded)
                return Conflict("角色资料保存失败，请刷新重试");
        }
        foreach (var (type, value) in new[] {
            (LabelClaim, input.DisplayName.Trim()),
            (DescriptionClaim, input.Description?.Trim() ?? "") })
        {
            if (value.Length == 0) continue;
            var added = await roleManager.AddClaimAsync(role, new Claim(type, value));
            if (!added.Succeeded)
                return Conflict("角色资料保存失败，请刷新重试");
        }
        return null;
    }
}
