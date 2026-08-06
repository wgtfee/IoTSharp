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
/// Local IoTSharp authorization remains authoritative in Shadow mode. The decision is
/// calculated from the explicitly bound existing IdentityUser, not from IAM role names.
/// This preserves IoTSharp's Customer/Tenant boundaries during migration.
/// </summary>
public sealed class IoTSharpLocalPermissionSource(
    IHttpContextAccessor httpContextAccessor,
    UserManager<IdentityUser> users) : ILocalPermissionSource
{
    public async Task<bool> HasPermissionAsync(string userId, string permissionCode, CancellationToken cancellationToken = default)
    {
        var principal = httpContextAccessor.HttpContext?.User;
        if (principal?.Identity?.IsAuthenticated != true)
            return false;

        var localUserId = principal.FindFirstValue(IndustrialClaimTypes.LocalUserId);
        if (string.IsNullOrWhiteSpace(localUserId))
            localUserId = userId;
        if (string.IsNullOrWhiteSpace(localUserId))
            return false;

        var user = await users.FindByIdAsync(localUserId);
        if (user is null || user.LockoutEnd.HasValue && user.LockoutEnd > DateTimeOffset.UtcNow)
            return false;

        var roles = await users.GetRolesAsync(user);
        if (roles.Contains(nameof(UserRole.SystemAdmin), StringComparer.OrdinalIgnoreCase))
            return true;

        if (permissionCode == "*")
            return false;

        var mapped = IoTSharpPermissionCodeMapper.ToLocalCode(permissionCode);
        var claims = await users.GetClaimsAsync(user);
        var explicitPermissions = claims
            .Where(c => string.Equals(c.Type, "permission", StringComparison.OrdinalIgnoreCase)
                || string.Equals(c.Type, "permissions", StringComparison.OrdinalIgnoreCase))
            .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        if (explicitPermissions.Any(p => p == "*"
            || string.Equals(p, permissionCode, StringComparison.OrdinalIgnoreCase)
            || string.Equals(p, mapped, StringComparison.OrdinalIgnoreCase)))
            return true;

        return IoTSharpPermissionCodeMapper.RoleAllows(roles, permissionCode, mapped);
    }
}

public sealed class IoTSharpPermissionCodeMapper : IPermissionCodeMapper
{
    private static readonly Dictionary<string, string> CanonicalToLocal = new(StringComparer.OrdinalIgnoreCase)
    {
        ["iot.device.view"] = "IoT.Device.View",
        ["iot.device.manage"] = "IoT.Device.Manage",
        ["iot.device.command"] = "IoT.Device.Command",
        ["iot.telemetry.view"] = "IoT.Telemetry.View",
        ["iot.customer.admin"] = "IoT.Customer.Admin",
        ["iot.tenant.admin"] = "IoT.Tenant.Admin"
    };

    private static readonly HashSet<string> LegacyCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "IoT.Device", "IoT.Device.Page", "IoT.Device.View", "IoT.Device.Manage", "IoT.Device.Command",
        "IoT.Telemetry.View", "IoT.Customer.Admin", "IoT.Tenant.Admin",
        "role:Anonymous", "role:NormalUser", "role:CustomerAdmin", "role:TenantAdmin", "role:SystemAdmin"
    };

    public PermissionMappingResult Map(string permissionCode)
    {
        var normalized = permissionCode?.Trim() ?? string.Empty;
        var local = ToLocalCode(normalized);
        var known = local == "*" || LegacyCodes.Contains(local) || CanonicalToLocal.ContainsKey(normalized);
        return new(permissionCode ?? string.Empty, known, known && local.Length > 0 ? new[] { local } : Array.Empty<string>(), known ? "IOT canonical -> existing Identity role/claim authorization" : "Unknown permission");
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

    internal static bool RoleAllows(IEnumerable<string> roleValues, string permissionCode, string mappedCode)
    {
        var roles = new HashSet<string>(roleValues, StringComparer.OrdinalIgnoreCase);
        if (roles.Contains(nameof(UserRole.SystemAdmin))) return true;

        if (mappedCode.StartsWith("role:", StringComparison.OrdinalIgnoreCase))
            return roles.Contains(mappedCode[5..]);

        var canonical = ToCanonicalCode(mappedCode);
        if (string.Equals(canonical, mappedCode, StringComparison.OrdinalIgnoreCase))
            canonical = permissionCode;

        return canonical.ToLowerInvariant() switch
        {
            "iot.device.view" or "iot.telemetry.view" =>
                roles.Contains(nameof(UserRole.NormalUser))
                || roles.Contains(nameof(UserRole.CustomerAdmin))
                || roles.Contains(nameof(UserRole.TenantAdmin)),
            "iot.device.manage" or "iot.device.command" or "iot.customer.admin" =>
                roles.Contains(nameof(UserRole.CustomerAdmin))
                || roles.Contains(nameof(UserRole.TenantAdmin)),
            "iot.tenant.admin" => roles.Contains(nameof(UserRole.TenantAdmin)),
            _ => false
        };
    }

    internal static IReadOnlyCollection<string> PermissionsForRoles(IEnumerable<string> roleValues)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var roles = new HashSet<string>(roleValues, StringComparer.OrdinalIgnoreCase);
        if (roles.Contains(nameof(UserRole.SystemAdmin)))
        {
            result.Add("*");
            foreach (var code in CanonicalToLocal.Keys) result.Add(code);
            return result;
        }

        foreach (var code in CanonicalToLocal.Keys)
            if (RoleAllows(roles, code, ToLocalCode(code))) result.Add(code);
        return result;
    }
}

public sealed class IoTSharpLocalPermissionProvider(UserManager<IdentityUser> users) : IUserPermissionProvider
{
    public async Task<UserPermissionSnapshot> GetPermissionsAsync(string userId, CancellationToken cancellationToken = default)
    {
        var permissions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(userId))
            return new UserPermissionSnapshot(userId, 0, permissions);

        var user = await users.FindByIdAsync(userId);
        if (user is null)
            return new UserPermissionSnapshot(userId, 0, permissions);

        var roles = await users.GetRolesAsync(user);
        permissions.UnionWith(IoTSharpPermissionCodeMapper.PermissionsForRoles(roles));

        var claims = await users.GetClaimsAsync(user);
        permissions.UnionWith(claims
            .Where(c => string.Equals(c.Type, "permission", StringComparison.OrdinalIgnoreCase)
                || string.Equals(c.Type, "permissions", StringComparison.OrdinalIgnoreCase))
            .SelectMany(c => c.Value.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Select(IoTSharpPermissionCodeMapper.ToCanonicalCode));

        return new UserPermissionSnapshot(userId, 0, permissions);
    }
}

/// <summary>
/// Central IAM identities are explicitly bound to an existing IoTSharp IdentityUser by
/// storing global_user_id as an ASP.NET Identity claim. No synthetic platform user and
/// no default IoT role is ever created.
/// </summary>
public sealed class IoTSharpShadowUserResolver(UserManager<IdentityUser> users) : IShadowUserResolver
{
    private const string SystemCode = IndustrialSystemCodes.Iot;

    public async Task<ShadowUserSnapshot?> ResolveAsync(string iamUserId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(iamUserId)) return null;
        var matches = await users.GetUsersForClaimAsync(new Claim(IndustrialClaimTypes.GlobalUserId, iamUserId));
        var user = matches.SingleOrDefault();
        return user is null ? null : ToSnapshot(user, iamUserId);
    }

    public Task<ShadowUserSnapshot?> EnsureAsync(string iamUserId, string? userName, string? displayName, CancellationToken cancellationToken = default)
        => ResolveAsync(iamUserId, cancellationToken);

    private static ShadowUserSnapshot ToSnapshot(IdentityUser user, string iamUserId)
        => new(user.Id, SystemCode, user.Id, iamUserId, user.UserName, user.UserName, user.Email, user.PhoneNumber,
            IdentitySource.Platform,
            user.LockoutEnd.HasValue && user.LockoutEnd > DateTimeOffset.UtcNow ? "Locked" : "Active",
            DateTime.UtcNow, DateTime.UtcNow);
}
