using System;
using System.Security.Claims;
using System.Threading.Tasks;
using Industrial.Security.Abstractions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace IoTSharp.IndustrialSecurity;

/// <summary>
/// Applies the same local, Identity-backed permission decision to API actions
/// used by the enterprise menu. An active custom role grant is not sufficient
/// by itself to bypass customer/tenant data scoping inside the action.
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = true)]
public sealed class IotRequirePermissionAttribute : TypeFilterAttribute
{
    public IotRequirePermissionAttribute(string permission)
        : base(typeof(IotRequirePermissionFilter))
    {
        if (!IotRolePermissionCatalog.Descriptions.ContainsKey(permission))
            throw new ArgumentException("Unknown IoT permission code", nameof(permission));
        Arguments = new object[] { permission };
    }
}

public sealed class IotRequirePermissionFilter(
    string permission, ILocalPermissionSource localPermissions) : IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        var user = context.HttpContext.User;
        if (user.Identity?.IsAuthenticated != true)
        {
            context.Result = new UnauthorizedResult();
            return;
        }
        var id = user.FindFirstValue(IndustrialClaimTypes.LocalUserId)
            ?? user.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrWhiteSpace(id) ||
            !await localPermissions.HasPermissionAsync(
                id, permission, context.HttpContext.RequestAborted))
        {
            context.Result = new ForbidResult();
        }
    }
}
