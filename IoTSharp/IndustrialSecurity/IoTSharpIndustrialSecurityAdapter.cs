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
using Microsoft.Extensions.Configuration;

namespace IoTSharp.IndustrialSecurity;

public sealed class IoTSharpCurrentUser(IHttpContextAccessor httpContextAccessor, IConfiguration configuration) : ICurrentUser
{
    private ClaimsPrincipal Principal => httpContextAccessor.HttpContext?.User ?? new ClaimsPrincipal();
    private bool CentralizedAuthentication => string.Equals(
        configuration["Security:Authentication:Mode"],
        "Centralized",
        StringComparison.OrdinalIgnoreCase);

    public IdentitySource Source
    {
        get
        {
            if (Enum.TryParse<IdentitySource>(Principal.FindFirstValue(IndustrialClaimTypes.IdentitySource), true, out var source))
                return source;

            // IAM first versions may only expose standard OIDC claims. In centralized mode,
            // an authenticated JwtBearer principal is therefore treated as a platform identity.
            return CentralizedAuthentication ? IdentitySource.Platform : IdentitySource.Local;
        }
    }

    public string? LocalUserId => Principal.FindFirstValue(IndustrialClaimTypes.LocalUserId)
        ?? (Source == IdentitySource.Local
            ? Principal.FindFirstValue(ClaimTypes.NameIdentifier) ?? Principal.Identity?.Name
            : null);

    public string? GlobalUserId => Principal.FindFirstValue(IndustrialClaimTypes.GlobalUserId)
        ?? (Source == IdentitySource.Platform
            ? Principal.FindFirstValue("sub") ?? Principal.FindFirstValue(ClaimTypes.NameIdentifier)
            : null);

    public string? UserId => LocalUserId ?? GlobalUserId;

    public string? UserName => Principal.FindFirstValue("preferred_username")
        ?? Principal.FindFirstValue("username")
        ?? Principal.FindFirstValue(ClaimTypes.Name)
        ?? Principal.FindFirstValue("name")
        ?? Principal.Identity?.Name
        ?? UserId;

    public string? TenantId => Principal.FindFirstValue(IoTSharpClaimTypes.Tenant)
        ?? Principal.FindFirstValue(IndustrialClaimTypes.TenantId)
        ?? Principal.FindFirstValue(IndustrialClaimTypes.LegacyTenant);

    public IReadOnlyCollection<string> Roles => Principal.Claims
        .Where(c => c.Type == ClaimTypes.Role
            || string.Equals(c.Type, "role", StringComparison.OrdinalIgnoreCase)
            || string.Equals(c.Type, "roles", StringComparison.OrdinalIgnoreCase))
        .Select(c => c.Value)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    public long PermissionVersion => long.TryParse(
        Principal.FindFirstValue(IndustrialClaimTypes.PermissionVersion) ?? Principal.FindFirstValue("PermissionVersion"),
        out var version) ? version : 0;

    public bool IsAuthenticated
    {
        get
        {
            if (Principal.Identity?.IsAuthenticated != true) return false;
            return Source == IdentitySource.Platform
                ? !string.IsNullOrWhiteSpace(GlobalUserId)
                : !string.IsNullOrWhiteSpace(LocalUserId);
        }
    }
}

public sealed class IoTSharpIdentityProvider(IoTSharpCurrentUser currentUser) : IIdentityProvider
{
    public CurrentIdentity GetCurrentIdentity() => new(currentUser.UserId, currentUser.UserName, currentUser.TenantId, currentUser.Source, currentUser.GlobalUserId, currentUser.Roles, currentUser.PermissionVersion, currentUser.IsAuthenticated, currentUser.LocalUserId);
}

/// <summary>
/// Identity in IoTSharp is role-based. Explicit permission claims are honored first;
/// canonical iot.* permissions are translated to legacy IoT.* codes during migration.
/// </summary>
public sealed class IoTSharpLocalPermissionSource(IHttpContextAccessor httpContextAccessor) : ILocalPermissionSource
{
    public Task<bool> HasPermissionAsync(string userId, string permissionCode, CancellationToken cancellationToken = default)
    {
        var principal = httpContextAccessor.HttpContext?.User;
        if (principal?.Identity?.IsAuthenticated != true)
            return Task.FromResult(false);

        var actualUserId = principal.FindFirstValue(IndustrialClaimTypes.LocalUserId)
            ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? principal.FindFirstValue("sub")
            ?? principal.Identity?.Name;
        if (!string.IsNullOrWhiteSpace(userId) && !string.IsNullOrWhiteSpace(actualUserId) &&
            !string.Equals(userId, actualUserId, StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(false);

        if (permissionCode == "*")
            return Task.FromResult(principal.IsInRole(nameof(UserRole.SystemAdmin)));

        var mapped = IoTSharpPermissionCodeMapper.ToLocalCode(permissionCode);
        var claims = principal.Claims
            .Where(c => string.Equals(c.Type, "permission", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(c.Type, "permissions", StringComparison.OrdinalIgnoreCase))
            .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries));
        if (claims.Any(p => p == "*"
            || string.Equals(p, permissionCode, StringComparison.OrdinalIgnoreCase)
            || string.Equals(p, mapped, StringComparison.OrdinalIgnoreCase)))
            return Task.FromResult(true);

        foreach (var role in Enum.GetNames<UserRole>())
        {
            if (principal.IsInRole(role) &&
                (string.Equals(mapped, $"role:{role}", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(mapped, $"iotsharp.role.{role}", StringComparison.OrdinalIgnoreCase)))
                return Task.FromResult(true);
        }

        return Task.FromResult(false);
    }
}

public sealed class IoTSharpPermissionCodeMapper : IPermissionCodeMapper
{
    private static readonly Dictionary<string, string> CanonicalToLocal = new(StringComparer.OrdinalIgnoreCase)
    {
        ["iot.device.view"] = "IoT.Device.View",
        ["iot.device.command"] = "IoT.Device.Command",
        ["iot.customer.admin"] = "IoT.Customer.Admin",
        ["iot.tenant.admin"] = "IoT.Tenant.Admin"
    };

    private static readonly HashSet<string> LegacyCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "IoT.Device", "IoT.Device.Page", "IoT.Device.View", "IoT.Device.Command",
        "IoT.Customer.Admin", "IoT.Tenant.Admin",
        "role:Anonymous", "role:NormalUser", "role:CustomerAdmin", "role:TenantAdmin", "role:SystemAdmin"
    };

    public PermissionMappingResult Map(string permissionCode)
    {
        var normalized = permissionCode?.Trim() ?? string.Empty;
        var local = ToLocalCode(normalized);
        var known = local == "*" || LegacyCodes.Contains(local);
        return new(permissionCode ?? string.Empty, known, known && local.Length > 0 ? new[] { local } : Array.Empty<string>(), known ? "IOT canonical -> legacy IoT Role/Claim/Policy" : "Unknown permission");
    }

    internal static string ToLocalCode(string permissionCode)
    {
        var normalized = permissionCode?.Trim() ?? string.Empty;
        if (CanonicalToLocal.TryGetValue(normalized, out var local)) return local;
        if (normalized.StartsWith("iotsharp.role.", StringComparison.OrdinalIgnoreCase)) return "role:" + normalized[14..];
        return normalized;
    }

    internal static string ToCanonicalCode(string permissionCode)
    {
        var normalized = permissionCode?.Trim() ?? string.Empty;
        foreach (var pair in CanonicalToLocal)
            if (string.Equals(pair.Value, normalized, StringComparison.OrdinalIgnoreCase)) return pair.Key;
        return normalized;
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
                .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries))
                .Select(IoTSharpPermissionCodeMapper.ToCanonicalCode));

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
    private const string SystemCode = IndustrialSystemCodes.Iot;
    public async Task<ShadowUserSnapshot?> ResolveAsync(string iamUserId, CancellationToken cancellationToken = default)
    {
        var user = await users.FindByNameAsync($"platform_{iamUserId}");
        return user is null ? null : ToSnapshot(user, iamUserId);
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
                new Claim(IndustrialClaimTypes.GlobalUserId, iamUserId),
                new Claim(IndustrialClaimTypes.IdentitySource, "Platform")
            });
        }
        return ToSnapshot(user, iamUserId, userName, displayName);
    }
    private static ShadowUserSnapshot ToSnapshot(IdentityUser user, string iamUserId, string? userName = null, string? displayName = null)
        => new(user.Id, SystemCode, user.Id, iamUserId, userName ?? user.UserName, displayName ?? user.UserName, user.Email, user.PhoneNumber, IdentitySource.Platform, user.LockoutEnd.HasValue && user.LockoutEnd > DateTimeOffset.UtcNow ? "Locked" : "Active", DateTime.UtcNow, DateTime.UtcNow);
}
