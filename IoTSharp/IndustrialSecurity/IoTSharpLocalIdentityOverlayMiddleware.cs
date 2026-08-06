using System.Security.Claims;
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
/// original IAM identity remains attached and continues to own global_user_id.
/// </summary>
public sealed class IoTSharpLocalIdentityOverlayMiddleware(RequestDelegate next)
{
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

        // ClaimsPrincipal.FindFirst scans identities in order. Put the local overlay
        // first so existing Identity code keeps receiving the local IdentityUser.Id.
        var identities = new List<ClaimsIdentity> { overlayIdentity };
        identities.AddRange(context.User.Identities);
        context.User = new ClaimsPrincipal(identities);

        await next(context);
    }
}
