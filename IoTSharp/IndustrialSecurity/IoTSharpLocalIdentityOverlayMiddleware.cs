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
/// current request. This keeps existing [Authorize(Roles=...)] and data-scope checks
/// authoritative during Shadow migration without copying IoT business scope into IAM.
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
            new("iot_local_identity_overlay", "true")
        };

        // Do not copy global_user_id/identity_source back from the local store; those
        // remain owned by IAM. Customer/Tenant and any existing local permission claims
        // are intentionally preserved because they are IoTSharp business scope.
        overlayClaims.AddRange(localClaims.Where(c =>
            !string.Equals(c.Type, IndustrialClaimTypes.GlobalUserId, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(c.Type, IndustrialClaimTypes.IdentitySource, StringComparison.OrdinalIgnoreCase)));
        overlayClaims.AddRange(localRoles.Select(role => new Claim(ClaimTypes.Role, role)));

        context.User.AddIdentity(new ClaimsIdentity(
            overlayClaims,
            "IoTSharp.LocalIdentityOverlay",
            ClaimTypes.Name,
            ClaimTypes.Role));

        await next(context);
    }
}
