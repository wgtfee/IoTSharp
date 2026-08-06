using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Industrial.Security.Abstractions;
using IoTSharp.Contracts;
using IoTSharp.IndustrialSecurity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace IoTSharp.Controllers;

public sealed record BindIotIamUserRequest(string LocalUserId, string IamUserId);
public sealed record UnbindIotIamUserRequest(string LocalUserId);

/// <summary>
/// Phase 5 migration endpoints. Binding is explicit: an IAM identity is attached to an
/// existing IoTSharp IdentityUser and never creates a default local user or role.
/// </summary>
[ApiController]
[Route("api/iam-migration/[action]")]
[Authorize(Roles = nameof(UserRole.SystemAdmin))]
public sealed class IamMigrationController(UserManager<IdentityUser> users, ILogger<IamMigrationController> logger) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Bind([FromBody] BindIotIamUserRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.LocalUserId) || string.IsNullOrWhiteSpace(request.IamUserId))
            return BadRequest(new { error = "LocalUserId 和 IamUserId 不能为空。" });

        var localUser = await users.FindByIdAsync(request.LocalUserId.Trim());
        if (localUser is null)
            return NotFound(new { error = "IoTSharp 本地用户不存在。" });

        var iamUserId = request.IamUserId.Trim();
        var alreadyBound = await users.GetUsersForClaimAsync(new Claim(IndustrialClaimTypes.GlobalUserId, iamUserId));
        if (alreadyBound.Any(x => !string.Equals(x.Id, localUser.Id, StringComparison.OrdinalIgnoreCase)))
            return Conflict(new { error = "该 IAM 用户已绑定到其他 IoTSharp 本地用户。" });

        var claims = await users.GetClaimsAsync(localUser);
        var existingBindings = claims
            .Where(x => string.Equals(x.Type, IndustrialClaimTypes.GlobalUserId, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        foreach (var existing in existingBindings)
        {
            if (!string.Equals(existing.Value, iamUserId, StringComparison.OrdinalIgnoreCase))
                await users.RemoveClaimAsync(localUser, existing);
        }

        if (!existingBindings.Any(x => string.Equals(x.Value, iamUserId, StringComparison.OrdinalIgnoreCase)))
        {
            var result = await users.AddClaimAsync(localUser, new Claim(IndustrialClaimTypes.GlobalUserId, iamUserId));
            if (!result.Succeeded)
                return Conflict(new { error = string.Join("; ", result.Errors.Select(x => x.Description)) });
        }

        var roles = await users.GetRolesAsync(localUser);
        logger.LogInformation(
            "IoTSharp IAM binding created. LocalUserId={LocalUserId}; IamUserId={IamUserId}",
            localUser.Id,
            iamUserId);
        return Ok(new
        {
            systemCode = IndustrialSystemCodes.Iot,
            localUserId = localUser.Id,
            localUser.UserName,
            iamUserId,
            roles,
            requireSystemAccess = true
        });
    }

    [HttpPost]
    public async Task<IActionResult> Unbind([FromBody] UnbindIotIamUserRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.LocalUserId))
            return BadRequest(new { error = "LocalUserId 不能为空。" });

        var localUser = await users.FindByIdAsync(request.LocalUserId.Trim());
        if (localUser is null)
            return NotFound(new { error = "IoTSharp 本地用户不存在。" });

        var claims = await users.GetClaimsAsync(localUser);
        var bindings = claims
            .Where(x => string.Equals(x.Type, IndustrialClaimTypes.GlobalUserId, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        foreach (var binding in bindings)
            await users.RemoveClaimAsync(localUser, binding);

        logger.LogInformation("IoTSharp IAM binding removed. LocalUserId={LocalUserId}", localUser.Id);
        return Ok(new { systemCode = IndustrialSystemCodes.Iot, localUserId = localUser.Id });
    }

    [HttpGet]
    public async Task<IActionResult> Bindings()
    {
        var result = new List<object>();
        foreach (var user in users.Users.OrderBy(x => x.UserName))
        {
            var claims = await users.GetClaimsAsync(user);
            var iamUserId = claims.FirstOrDefault(x =>
                string.Equals(x.Type, IndustrialClaimTypes.GlobalUserId, StringComparison.OrdinalIgnoreCase))?.Value;
            if (string.IsNullOrWhiteSpace(iamUserId)) continue;

            result.Add(new
            {
                localUserId = user.Id,
                user.UserName,
                user.Email,
                iamUserId,
                roles = await users.GetRolesAsync(user),
                user.LockoutEnd
            });
        }

        return Ok(result);
    }

    [HttpGet]
    public IActionResult RoleTemplates()
    {
        var roleNames = new[]
        {
            nameof(UserRole.NormalUser),
            nameof(UserRole.CustomerAdmin),
            nameof(UserRole.TenantAdmin),
            nameof(UserRole.SystemAdmin)
        };

        var templates = roleNames.Select(roleName =>
        {
            var permissions = IoTSharpPermissionCodeMapper.PermissionsForRoles(new[] { roleName })
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (permissions.Contains("iot.device.view")) permissions.Add("IoT.Device.View");
            if (permissions.Contains("iot.device.command")) permissions.Add("IoT.Device.Command");

            return new
            {
                localRole = roleName,
                suggestedIamRoleCode = $"IOT_ROLE_{roleName.ToUpperInvariant()}",
                permissionCodes = permissions.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray(),
                note = roleName == nameof(UserRole.SystemAdmin)
                    ? "SystemAdmin uses wildcard; keep assignment restricted."
                    : "Customer/Tenant/device data scope remains in IoTSharp and is not represented by these IAM permissions."
            };
        });

        return Ok(new
        {
            systemCode = IndustrialSystemCodes.Iot,
            shadowAliasesAreTemporary = true,
            templates
        });
    }
}
