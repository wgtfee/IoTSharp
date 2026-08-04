using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Industrial.Security.Abstractions;
using IoTSharp.Contracts;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;

namespace IoTSharp.IndustrialSecurity;

public sealed class IoTSharpCurrentUser(IHttpContextAccessor httpContextAccessor) : ICurrentUser
{
    private ClaimsPrincipal Principal => httpContextAccessor.HttpContext?.User ?? new ClaimsPrincipal();

    public string? UserId => Principal.FindFirstValue("local_user_id")
        ?? Principal.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? Principal.FindFirstValue("sub")
        ?? Principal.Identity?.Name;
    public string? UserName => Principal.FindFirstValue(ClaimTypes.Name)
        ?? Principal.Identity?.Name
        ?? UserId;
    public string? LocalUserId => Principal.FindFirstValue("local_user_id") ?? (Source == IdentitySource.Local ? UserId : null);
    public string? TenantId => Principal.FindFirstValue(IoTSharpClaimTypes.Tenant)
        ?? Principal.FindFirstValue("tenant_id")
        ?? Principal.FindFirstValue("tenant");
    public IdentitySource Source => Enum.TryParse<IdentitySource>(Principal.FindFirstValue("identity_source"), true, out var source) ? source : IdentitySource.Local;
    public string? GlobalUserId => Principal.FindFirstValue("global_user_id") ?? (Source == IdentitySource.Platform ? Principal.FindFirstValue("sub") : null);
    public IReadOnlyCollection<string> Roles => Principal.Claims
        .Where(c => c.Type == ClaimTypes.Role || string.Equals(c.Type, "role", StringComparison.OrdinalIgnoreCase))
        .Select(c => c.Value)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();
    public long PermissionVersion => long.TryParse(Principal.FindFirstValue("permission_version"), out var version) ? version : 0;
    public bool IsAuthenticated => Principal.Identity?.IsAuthenticated == true;
}

public sealed class IoTSharpIdentityProvider(IoTSharpCurrentUser currentUser) : IIdentityProvider
{
    public CurrentIdentity GetCurrentIdentity() => new(currentUser.UserId, currentUser.UserName, currentUser.TenantId, currentUser.Source, currentUser.GlobalUserId, currentUser.Roles, currentUser.PermissionVersion, currentUser.IsAuthenticated, currentUser.LocalUserId);
}

/// <summary>
/// Identity in IoTSharp is role-based. Explicit permission claims are honored first;
/// role aliases provide a stable local contract without changing existing [Authorize] behavior.
/// </summary>
public sealed class IoTSharpLocalPermissionSource(IHttpContextAccessor httpContextAccessor) : ILocalPermissionSource
{
    public Task<bool> HasPermissionAsync(string userId, string permissionCode, CancellationToken cancellationToken = default)
    {
        var principal = httpContextAccessor.HttpContext?.User;
        if (principal?.Identity?.IsAuthenticated != true)
            return Task.FromResult(false);

        var actualUserId = principal.FindFirstValue("local_user_id")
            ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? principal.FindFirstValue("sub")
            ?? principal.Identity?.Name;
        if (!string.IsNullOrWhiteSpace(userId) && !string.IsNullOrWhiteSpace(actualUserId) &&
            !string.Equals(userId, actualUserId, StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(false);

        if (permissionCode == "*")
            return Task.FromResult(principal.IsInRole(nameof(UserRole.SystemAdmin)));

        var claims = principal.Claims
            .Where(c => string.Equals(c.Type, "permission", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(c.Type, "permissions", StringComparison.OrdinalIgnoreCase))
            .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries));
        if (claims.Any(p => p == "*" || string.Equals(p, permissionCode, StringComparison.OrdinalIgnoreCase)))
            return Task.FromResult(true);

        foreach (var role in Enum.GetNames<UserRole>())
        {
            if (principal.IsInRole(role) &&
                (string.Equals(permissionCode, $"role:{role}", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(permissionCode, $"iotsharp.role.{role}", StringComparison.OrdinalIgnoreCase)))
                return Task.FromResult(true);
        }

        return Task.FromResult(false);
    }
}

public sealed class IoTSharpPermissionCodeMapper : IPermissionCodeMapper
{
    private static readonly HashSet<string> KnownCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "IoT.Device", "IoT.Device.Page", "IoT.Device.View", "IoT.Device.Command",
        "IoT.Customer.Admin", "IoT.Tenant.Admin",
        "role:Anonymous", "role:NormalUser", "role:CustomerAdmin", "role:TenantAdmin", "role:SystemAdmin"
    };

    public PermissionMappingResult Map(string permissionCode)
    {
        var normalized = permissionCode?.Trim() ?? string.Empty;
        if (normalized.StartsWith("iotsharp.role.", StringComparison.OrdinalIgnoreCase)) normalized = "role:" + normalized[14..];
        var known = normalized == "*" || KnownCodes.Contains(normalized);
        return new(permissionCode, known, known && normalized.Length > 0 ? new[] { normalized } : Array.Empty<string>(), known ? "IoT Role/Claim/Policy" : "Unknown permission");
    }
}

public sealed class IoTSharpLocalPermissionProvider(IHttpContextAccessor httpContextAccessor) : IUserPermissionProvider
{
    public Task<UserPermissionSnapshot> GetPermissionsAsync(string userId, CancellationToken cancellationToken = default)
    {
        var principal = httpContextAccessor.HttpContext?.User;
        var permissions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (principal?.Identity?.IsAuthenticated == true)
        {
            permissions.UnionWith(principal.Claims
                .Where(c => string.Equals(c.Type, "permission", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(c.Type, "permissions", StringComparison.OrdinalIgnoreCase))
                .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries)));

            foreach (var role in Enum.GetNames<UserRole>())
            {
                if (principal.IsInRole(role))
                    permissions.Add($"role:{role}");
            }

            if (principal.IsInRole(nameof(UserRole.SystemAdmin)))
                permissions.Add("*");
        }

        return Task.FromResult(new UserPermissionSnapshot(userId, 0, permissions));
    }
}

/// <summary>将平台身份映射为无密码的 ASP.NET Identity Shadow User。</summary>
public sealed class IoTSharpShadowUserResolver(UserManager<IdentityUser> users) : IShadowUserResolver
{
    private const string SystemCode = "IoT";
    public async Task<ShadowUserSnapshot?> ResolveAsync(string iamUserId, CancellationToken cancellationToken = default)
    {
        var user = await users.FindByNameAsync($"platform_{iamUserId}");
        return user is null ? null : ToSnapshot(user);
    }
    public async Task<ShadowUserSnapshot?> EnsureAsync(string iamUserId, string? userName, string? displayName, CancellationToken cancellationToken = default)
    {
        var user = await users.FindByNameAsync($"platform_{iamUserId}");
        if (user is null)
        {
            user = new IdentityUser { UserName = $"platform_{iamUserId}", Email = null, EmailConfirmed = true, SecurityStamp = Guid.NewGuid().ToString("N") };
            var result = await users.CreateAsync(user);
            if (!result.Succeeded) throw new InvalidOperationException(string.Join("; ", result.Errors.Select(x => x.Description)));
            await users.AddClaimsAsync(user, new[]
            {
                new Claim("global_user_id", iamUserId),
                new Claim("identity_source", "Platform")
            });
        }
        return ToSnapshot(user, userName, displayName);
    }
    private static ShadowUserSnapshot ToSnapshot(IdentityUser user, string? userName = null, string? displayName = null)
        => new(user.Id, SystemCode, user.Id, user.Id, userName ?? user.UserName, displayName ?? user.UserName, user.Email, user.PhoneNumber, IdentitySource.Platform, user.LockoutEnd.HasValue && user.LockoutEnd > DateTimeOffset.UtcNow ? "Locked" : "Active", user.Id is not null ? DateTime.UtcNow : DateTime.UtcNow, DateTime.UtcNow);
}
