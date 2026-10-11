using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Industrial.Security.Abstractions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace IoTSharp.IndustrialSecurity;

/// <summary>
/// After Industrial.Security resolves local_user_id for a centralized IAM principal,
/// re-hydrate the bound IoTSharp IdentityUser roles and Customer/Tenant claims into the
/// current request. The local overlay is made the first identity so legacy
/// UserManager.GetUserAsync(User) resolves the existing IoTSharp user id, while the
/// IAM 身份保留全局用户、会话和令牌信息；原生角色检查只使用绑定的本地角色。
/// </summary>
public sealed class IoTSharpLocalIdentityOverlayMiddleware(RequestDelegate next)
{
    /// <summary>加载明确绑定账号的本地角色和数据范围，保留 IAM 身份及会话信息。</summary>
    public async Task InvokeAsync(
        HttpContext context,
        IConfiguration configuration,
        UserManager<IdentityUser> users,
        ILogger<IoTSharpLocalIdentityOverlayMiddleware> logger)
    {
        if (!string.Equals(
                configuration["Security:Authentication:Mode"],
                "Centralized",
                StringComparison.OrdinalIgnoreCase)
            || context.User.Identity?.IsAuthenticated != true)
        {
            await next(context);
            return;
        }

        var globalUserId = context.User.FindFirstValue(IndustrialClaimTypes.GlobalUserId)
            ?? context.User.FindFirstValue("sub");
        var localUserId = context.User.FindFirstValue(IndustrialClaimTypes.LocalUserId);
        if (string.IsNullOrWhiteSpace(globalUserId) || string.IsNullOrWhiteSpace(localUserId))
        {
            await next(context);
            return;
        }

        var localUser = await users.FindByIdAsync(localUserId);
        if (localUser is null
            || localUser.LockoutEnabled && localUser.LockoutEnd.HasValue && localUser.LockoutEnd > DateTimeOffset.UtcNow)
        {
            logger.LogWarning(
                "Bound IoTSharp local user is unavailable. GlobalUserId={GlobalUserId}; LocalUserId={LocalUserId}",
                globalUserId,
                localUserId);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        var localClaims = await users.GetClaimsAsync(localUser);
        var localRoles = await users.GetRolesAsync(localUser);
        var overlayClaims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, localUser.Id),
            new(ClaimTypes.Name, localUser.UserName ?? localUser.Id),
            new(IndustrialClaimTypes.LocalUserId, localUser.Id),
            new("iot_local_identity_overlay", "true")
        };

        overlayClaims.AddRange(localClaims.Where(c =>
            !string.Equals(c.Type, IndustrialClaimTypes.GlobalUserId, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(c.Type, IndustrialClaimTypes.IdentitySource, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(c.Type, ClaimTypes.NameIdentifier, StringComparison.OrdinalIgnoreCase)));
        overlayClaims.AddRange(localRoles.Select(role => new Claim(ClaimTypes.Role, role)));

        var overlayIdentity = new ClaimsIdentity(
            overlayClaims,
            "IoTSharp.LocalIdentityOverlay",
            ClaimTypes.Name,
            ClaimTypes.Role);

        var identities = new List<ClaimsIdentity> { overlayIdentity };
        // ClaimsPrincipal.IsInRole 会遍历所有身份，不能让 IAM 的同名角色越过本地授权。
        foreach (var identity in context.User.Identities)
        {
            var platformIdentity = identity.Clone();
            foreach (var claim in platformIdentity.Claims.Where(c =>
                string.Equals(c.Type, platformIdentity.RoleClaimType, StringComparison.OrdinalIgnoreCase)
                || string.Equals(c.Type, ClaimTypes.Role, StringComparison.OrdinalIgnoreCase)
                || string.Equals(c.Type, "role", StringComparison.OrdinalIgnoreCase)
                || string.Equals(c.Type, "roles", StringComparison.OrdinalIgnoreCase)).ToArray())
                platformIdentity.RemoveClaim(claim);
            identities.Add(platformIdentity);
        }
        context.User = new ClaimsPrincipal(identities);

        await next(context);
    }
}
