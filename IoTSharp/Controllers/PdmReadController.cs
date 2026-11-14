using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Controllers;

public sealed record PdmFeatureStatusDto(
    bool Enabled, bool Configured, string State, string Message,
    bool ReadOnly, bool RequiresVerifiedDeviceData);

public sealed record PdmDeviceHealthDto(
    Guid ProfileId, Guid DeviceId, Guid? AssetId, Guid? ProductId, int ProfileVersion,
    bool ProfileEnabled, bool PointMappingsVerified, bool RunStateVerified,
    string DataQuality, string RiskLevel, double? HealthIndex,
    DateTime? LastEvaluatedUtc, int FailedPointCount);

public sealed record PdmOverviewDto(
    int TotalDevices, int ActiveRisks, int Page, int PageSize,
    IReadOnlyList<PdmDeviceHealthDto> Rows);

public sealed record PdmRiskEventDto(
    Guid Id, Guid DeviceId, int ProfileVersion, string RiskType, string RiskLevel,
    string Status, DateTime FirstObservedUtc, DateTime LastObservedUtc,
    DateTime? ClearedAtUtc, int OccurrenceCount, int RecoveryStreak, string EvidenceJson);

public sealed record PdmRiskPageDto(int Total, int Page, int PageSize, IReadOnlyList<PdmRiskEventDto> Rows);

public sealed record PdmTrendItemDto(
    Guid Id, DateTime WindowStartUtc, DateTime WindowEndUtc,
    double? HealthIndex, double CoverageRatio,
    string RiskLevel, string DataQuality, int FailedPointCount,
    string ExplanationJson);

public sealed record PdmProfileDetailsDto(
    Guid ProfileId, Guid DeviceId, int Version, bool Enabled,
    bool PointMappingsVerified, bool RunStateVerified, int WindowMinutes,
    double MinimumCoverageRatio, IReadOnlyList<PdmPointPolicyDto> Points);

public sealed record PdmPointPolicyDto(
    string TelemetryKey, string Unit, bool Enabled, bool Required,
    int ExpectedIntervalSeconds, double MinValidValue, double MaxValidValue,
    double WarningHighValue, double CriticalHighValue, double? RisingTrendPerMinute);

/// <summary>
/// PdM P1-06 read-only management API. Every DB query is scoped by trusted JWT
/// tenant/customer claims; client-supplied scope identifiers are never accepted.
/// No DB is resolved while the feature rollout is disabled.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm")]
public sealed class PdmReadController : ControllerBase
{
    private readonly IServiceProvider _services;
    private readonly IConfiguration _configuration;

    public PdmReadController(IServiceProvider services, IConfiguration configuration)
    {
        _services = services;
        _configuration = configuration;
    }

    private bool Configured =>
        _configuration.GetValue<bool>("PredictiveMaintenance:Enabled") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:SchemaReady") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:SingleInstanceAcknowledged") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:PointMappingsApproved") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:HistoryQueryPlanApproved") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:HistoryUtcContractApproved");

    private bool Scope(out Guid tenant, out Guid customer)
    {
        tenant = default;
        customer = default;
        return User?.Identity?.IsAuthenticated == true
            && Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out tenant)
            && tenant != Guid.Empty
            && Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out customer)
            && customer != Guid.Empty;
    }

    private IActionResult Unavailable() =>
        StatusCode(StatusCodes.Status503ServiceUnavailable,
            new ApiResult<object>(ApiCode.InValidData, "PdM 元数据尚未通过发布门禁", new { }));

    private IActionResult ScopeDenied() =>
        StatusCode(StatusCodes.Status403Forbidden,
            new ApiResult<object>(ApiCode.InValidData, "当前身份缺少有效租户/客户范围", new { }));

    private PdmDbContext? Database => Configured ? _services.GetService<PdmDbContext>() : null;

    [HttpGet("status")]
    public ActionResult<ApiResult<PdmFeatureStatusDto>> GetStatus()
    {
        var enabled = _configuration.GetValue<bool>("PredictiveMaintenance:Enabled");
        var configured = Configured;
        var state = !enabled ? "Disabled" : !configured ? "PendingApproval" : "Configured";
        var message = !enabled
            ? "预测性维护尚未启用；本页仅展示功能框架，不生成虚拟数据"
            : !configured
                ? "预测性维护发布条件尚未全部确认"
                : "发布配置已确认；仍需以真实数据库和点位验收为准";
        return new ApiResult<PdmFeatureStatusDto>(ApiCode.Success, "OK",
            new(enabled, configured, state, message, true, true));
    }

    [HttpGet("overview")]
    public async Task<IActionResult> GetOverview(
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        CancellationToken cancellationToken = default)
    {
        if (!Configured) return Unavailable();
        if (!Scope(out var tenant, out var customer)) return ScopeDenied();
        if (page is < 1 or > 1000 || pageSize is < 1 or > 50) return BadRequest("分页参数无效");
        var db = Database;
        if (db is null) return Unavailable();

        var profileQuery = db.DeviceProfiles.AsNoTracking()
            .Where(p => p.TenantId == tenant && p.CustomerId == customer);
        var total = await profileQuery.CountAsync(cancellationToken);
        var profiles = await profileQuery.OrderBy(p => p.DeviceId)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .Select(p => new
            {
                p.Id, p.DeviceId, p.AssetId, p.ProductId, p.Version,
                p.Enabled, p.PointMappingsVerified, p.RunStateVerified
            }).ToListAsync(cancellationToken);
        var ids = profiles.Select(x => x.Id).ToArray();
        var latest = await db.HealthSnapshots.AsNoTracking()
            .Where(s => s.TenantId == tenant && s.CustomerId == customer &&
                        ids.Contains(s.ProfileId))
            .GroupBy(s => s.ProfileId)
            .Select(g => g.OrderByDescending(x => x.WindowEndUtc).First())
            .ToListAsync(cancellationToken);
        var latestByProfile = latest.ToDictionary(x => x.ProfileId);
        var riskCount = await db.RiskEvents.AsNoTracking()
            .CountAsync(r => r.TenantId == tenant && r.CustomerId == customer &&
                             r.Status == "Open", cancellationToken);

        var rows = profiles.Select(p =>
        {
            latestByProfile.TryGetValue(p.Id, out var snap);
            // A new rule version must never display an older version score as current health.
            if (snap?.ProfileVersion != p.Version) snap = null;
            return new PdmDeviceHealthDto(p.Id, p.DeviceId, p.AssetId, p.ProductId,
                p.Version, p.Enabled, p.PointMappingsVerified, p.RunStateVerified,
                snap?.DataQuality ?? "Unknown", snap?.RiskLevel ?? "Unknown",
                snap?.HealthIndex, snap?.WindowEndUtc, snap?.FailedPointCount ?? 0);
        }).ToArray();
        return Ok(new ApiResult<PdmOverviewDto>(ApiCode.Success, "OK",
            new(total, riskCount, page, pageSize, rows)));
    }

    [HttpGet("risks")]
    public async Task<IActionResult> GetRisks(
        [FromQuery] string status = "Open", [FromQuery] Guid? deviceId = null,
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        CancellationToken cancellationToken = default)
    {
        if (!Configured) return Unavailable();
        if (!Scope(out var tenant, out var customer)) return ScopeDenied();
        if (status is not ("Open" or "Cleared" or "All") ||
            page is < 1 or > 1000 || pageSize is < 1 or > 50)
            return BadRequest("风险筛选参数无效");
        var db = Database;
        if (db is null) return Unavailable();

        var query = db.RiskEvents.AsNoTracking()
            .Where(r => r.TenantId == tenant && r.CustomerId == customer);
        if (status != "All") query = query.Where(r => r.Status == status);
        if (deviceId.HasValue && deviceId.Value != Guid.Empty)
            query = query.Where(r => r.DeviceId == deviceId.Value);
        var total = await query.CountAsync(cancellationToken);
        var rows = await query.OrderByDescending(x => x.LastObservedUtc).ThenBy(x => x.Id)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new PdmRiskEventDto(
                x.Id, x.DeviceId, x.ProfileVersion, x.RiskType, x.RiskLevel,
                x.Status, x.FirstObservedUtc, x.LastObservedUtc, x.ClearedAtUtc,
                x.OccurrenceCount, x.RecoveryStreak, x.EvidenceJson))
            .ToListAsync(cancellationToken);
        return Ok(new ApiResult<PdmRiskPageDto>(ApiCode.Success, "OK",
            new(total, page, pageSize, rows)));
    }

    [HttpGet("trend")]
    public async Task<IActionResult> GetTrend(
        [FromQuery] Guid deviceId, [FromQuery] int days = 7,
        CancellationToken cancellationToken = default)
    {
        if (!Configured) return Unavailable();
        if (!Scope(out var tenant, out var customer)) return ScopeDenied();
        if (deviceId == Guid.Empty || days is < 1 or > 30)
            return BadRequest("设备和日期参数无效");
        var db = Database;
        if (db is null) return Unavailable();
        var profile = await db.DeviceProfiles.AsNoTracking()
            .Where(p => p.TenantId == tenant && p.CustomerId == customer &&
                        p.DeviceId == deviceId)
            .Select(p => new { p.Id, p.Version }).SingleOrDefaultAsync(cancellationToken);
        if (profile is null) return NotFound();
        var from = DateTime.UtcNow.AddDays(-days);
        var snapshots = await db.HealthSnapshots.AsNoTracking()
            .Where(s => s.TenantId == tenant && s.CustomerId == customer &&
                        s.ProfileId == profile.Id && s.ProfileVersion == profile.Version && s.WindowEndUtc >= from)
            .OrderByDescending(s => s.WindowEndUtc)
            .Take(200)
            .Select(s => new PdmTrendItemDto(s.Id, s.WindowStartUtc, s.WindowEndUtc,
                s.HealthIndex, s.CoverageRatio, s.RiskLevel, s.DataQuality,
                s.FailedPointCount, s.ExplanationJson))
            .ToListAsync(cancellationToken);
        snapshots.Reverse();
        return Ok(new ApiResult<IReadOnlyList<PdmTrendItemDto>>(
            ApiCode.Success, "OK", snapshots));
    }

    [HttpGet("profile")]
    public async Task<IActionResult> GetProfile(
        [FromQuery] Guid deviceId, CancellationToken cancellationToken = default)
    {
        if (!Configured) return Unavailable();
        if (!Scope(out var tenant, out var customer)) return ScopeDenied();
        if (deviceId == Guid.Empty) return BadRequest("设备 ID 无效");
        var db = Database;
        if (db is null) return Unavailable();
        var profile = await db.DeviceProfiles.AsNoTracking()
            .SingleOrDefaultAsync(p => p.TenantId == tenant &&
                                       p.CustomerId == customer && p.DeviceId == deviceId,
                cancellationToken);
        if (profile == null) return NotFound();
        var points = await db.PointPolicies.AsNoTracking()
            .Where(p => p.ProfileId == profile.Id)
            .OrderBy(p => p.TelemetryKey).Take(32)
            .Select(p => new PdmPointPolicyDto(p.TelemetryKey, p.Unit, p.Enabled,
                p.Required, p.ExpectedIntervalSeconds, p.MinValidValue,
                p.MaxValidValue, p.WarningHighValue, p.CriticalHighValue,
                p.RisingTrendPerMinute))
            .ToListAsync(cancellationToken);
        return Ok(new ApiResult<PdmProfileDetailsDto>(ApiCode.Success, "OK",
            new(profile.Id, profile.DeviceId, profile.Version, profile.Enabled,
                profile.PointMappingsVerified, profile.RunStateVerified,
                profile.WindowMinutes, profile.MinimumCoverageRatio, points)));
    }
}

