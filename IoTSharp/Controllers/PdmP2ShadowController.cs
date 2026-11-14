using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Controllers;

public sealed record PdmP2TrendDto(
    string Direction, int ValidWindows, double? SlopePointsPerHour,
    double? ChangePoints, DateTime? WindowEndUtc, string Reason);

public sealed record PdmP2AlertDto(
    string Kind, string Reason, string? IdempotencyKey,
    bool IsProposalOnly, bool IsDelivered);

public sealed record PdmP2MaintenanceDto(
    string State, Guid? LinkedRiskEventId, string Title, string Explanation,
    IReadOnlyList<string> SuggestedChecks, bool RequiresHumanApproval,
    bool IsWorkOrderIssued, double? FailureProbability, double? RemainingUsefulLifeHours);

public sealed record PdmP2ShadowDto(
    Guid DeviceId, Guid ProfileId, int ProfileVersion, string State,
    DateTime? LatestWindowUtc, PdmP2TrendDto Trend, PdmP2AlertDto Alert,
    PdmP2MaintenanceDto Maintenance, bool ReadOnly, string Message);

/// <summary>
/// P2 shadow diagnostics API: only trusted P1 stored history and active episode.
/// No client-supplied scope, verified point category or notification history.
/// The separate P2 gate defaults false and NEVER activates a P1 worker.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm/p2")]
public sealed class PdmP2ShadowController : ControllerBase
{
    private readonly IServiceProvider _services;
    private readonly IConfiguration _configuration;

    public PdmP2ShadowController(IServiceProvider services, IConfiguration configuration)
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
        _configuration.GetValue<bool>("PredictiveMaintenance:HistoryUtcContractApproved") &&
        _configuration.GetValue<bool>("PredictiveMaintenance:P2:ReadOnlyEnabled");

    private bool GetScope(out Guid tenant, out Guid customer)
    {
        tenant = default;
        customer = default;
        return User?.Identity?.IsAuthenticated == true &&
            Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out tenant) &&
            Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out customer) &&
            tenant != Guid.Empty && customer != Guid.Empty;
    }

    private static PdmP2TrendDto Trend(PdmTrendFinding trend) =>
        new(trend.Direction.ToString(), trend.ValidWindows, trend.SlopePointsPerHour,
            trend.ChangePoints, trend.WindowEndUtc, trend.Reason);

    private static PdmP2AlertDto Alert(PdmAlertDecision alert) =>
        new(alert.Kind.ToString(), alert.Reason, alert.IdempotencyKey, true, false);

    private static PdmP2MaintenanceDto Maintenance(PdmMaintenanceDraft draft) =>
        new(draft.State.ToString(), draft.LinkedRiskEventId,
            draft.Title, draft.Explanation, draft.SuggestedChecks,
            draft.RequiresHumanApproval, false, null, null);

    private static PdmP2ShadowDto Unknown(PdmDeviceProfile profile,
        string message, DateTime? latest = null) =>
        new(profile.DeviceId, profile.Id, profile.Version, "Unknown", latest,
            new("Unknown", 0, null, null, latest, message),
            new("Held", message, null, true, false),
            new("NeedsDataVerification", null, "待核验", message,
                new[] { "复核已核验设备监测点与连续健康评估记录" },
                true, false, null, null), true, message);

    [HttpGet("shadow")]
    public async Task<IActionResult> GetShadow(
        [FromQuery] Guid deviceId, CancellationToken cancellationToken = default)
    {
        // All disabled cases must stop before resolving any DB service.
        if (!Configured)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData, "P2 只读影子评估或 P1 发布门禁尚未批准", new { }));
        if (!GetScope(out var tenant, out var customer))
            return StatusCode(StatusCodes.Status403Forbidden,
                new ApiResult<object>(ApiCode.InValidData, "租户或客户身份无效", new { }));
        if (deviceId == Guid.Empty) return BadRequest("设备 ID 不合法");

        var db = _services.GetService<PdmDbContext>();
        if (db == null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData, "PdM 元数据服务尚未部署", new { }));

        var profile = await db.DeviceProfiles.AsNoTracking().SingleOrDefaultAsync(
            p => p.TenantId == tenant && p.CustomerId == customer && p.DeviceId == deviceId,
            cancellationToken);
        if (profile == null) return NotFound();

        // Select only compact P1 summary fields; avoid materializing unbounded JSON evidence
        // from every history row, and never read another tenant's snapshots.
        var recent = await db.HealthSnapshots.AsNoTracking()
            .Where(s => s.TenantId == tenant && s.CustomerId == customer &&
                s.DeviceId == deviceId && s.ProfileId == profile.Id &&
                s.ProfileVersion == profile.Version)
            .OrderByDescending(s => s.WindowEndUtc).Take(32)
            .Select(s => new PdmHealthSnapshot
            {
                TenantId = s.TenantId, CustomerId = s.CustomerId, DeviceId = s.DeviceId,
                ProfileId = s.ProfileId, ProfileVersion = s.ProfileVersion,
                WindowStartUtc = s.WindowStartUtc, WindowEndUtc = s.WindowEndUtc,
                DataQuality = s.DataQuality, RiskLevel = s.RiskLevel,
                HealthIndex = s.HealthIndex, CoverageRatio = s.CoverageRatio
            }).ToListAsync(cancellationToken);
        recent.Reverse();
        if (recent.Count == 0)
            return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                Unknown(profile, "设备尚无可信健康评估历史")));

        // P1 HistoryUtcContractApproved confirms persisted UTC semantics.
        // SQL datetime may be returned as Unspecified; do not use local timezone conversion.
        foreach (var row in recent)
        {
            if (row.WindowStartUtc.Kind == DateTimeKind.Local ||
                row.WindowEndUtc.Kind == DateTimeKind.Local)
                return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                    Unknown(profile, "历史时间字段包含本地时区标记，拒绝分析")));
            row.WindowStartUtc = DateTime.SpecifyKind(row.WindowStartUtc, DateTimeKind.Utc);
            row.WindowEndUtc = DateTime.SpecifyKind(row.WindowEndUtc, DateTimeKind.Utc);
        }

        var newest = recent[^1];
        // Prevent stale or future snapshots from generating actionable P2 proposals.
        var nowUtc = DateTime.UtcNow;
        if (newest.WindowEndUtc > nowUtc.AddMinutes(1) ||
            newest.WindowEndUtc < nowUtc.AddMinutes(-Math.Clamp(profile.WindowMinutes * 2 + 5, 5, 1440)))
            return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                Unknown(profile, "最近健康评估已过期或位于未来，禁止使用旧风险产生维护建议", newest.WindowEndUtc)));

        var trend = PdmTrendDetector.Analyze(profile, recent);
        var openEpisodes = await db.RiskEvents.AsNoTracking()
            .Where(r => r.TenantId == tenant && r.CustomerId == customer &&
                r.DeviceId == deviceId && r.ProfileId == profile.Id &&
                r.ProfileVersion == profile.Version &&
                r.RiskType == PdmRiskEventTransitions.HealthRiskType && r.Status == "Open")
            .OrderByDescending(r => r.LastEvaluatedWindowEndUtc).ThenBy(r => r.Id)
            .Take(2).ToListAsync(cancellationToken);
        if (openEpisodes.Count > 1)
            return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                Unknown(profile, "检测到同设备同规则版本多个未解除风险事件，禁止随意选择风险片段", newest.WindowEndUtc)));
        var episode = openEpisodes.FirstOrDefault();

        if (episode == null)
            return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                new(profile.DeviceId, profile.Id, profile.Version, "NoOpenRisk",
                    newest.WindowEndUtc, Trend(trend),
                    new("Held", "没有当前版本的未解除风险事件", null, true, false),
                    new("NotApplicable", null, "暂无维护提案",
                        "没有当前版本的未解除风险事件",
                        Array.Empty<string>(), true, false, null, null),
                    true, "只读趋势分析：当前没有可关联的风险片段")));

        if (!Enum.TryParse<PdmRiskLevel>(newest.RiskLevel, true, out var level) ||
            level is PdmRiskLevel.Unknown or PdmRiskLevel.Normal ||
            newest.HealthIndex is null)
            return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
                Unknown(profile, "最新快照不是可信风险，禁止生成 P2 提案", newest.WindowEndUtc)));

        var evaluation = new PdmHealthEvaluation(
            tenant, customer, deviceId,
            new DateTimeOffset(newest.WindowStartUtc),
            new DateTimeOffset(newest.WindowEndUtc),
            newest.DataQuality, newest.HealthIndex, level, newest.CoverageRatio,
            Array.Empty<PdmPointAssessment>(), Array.Empty<string>());

        // P2 does not have verified category or notification delivery audit persistence.
        // Never guess a maintenance category from a key name/unit; never deliver alerts.
        var advice = PdmP2ShadowOrchestrator.Evaluate(
            profile, recent, episode, evaluation, new PdmAlertPolicy(),
            PdmMeasurementCategory.Unclassified, false);
        var state = advice.Trend.Direction == PdmTrendDirection.Unknown ? "Unverified" : "ProposalOnly";
        return Ok(new ApiResult<PdmP2ShadowDto>(ApiCode.Success, "OK",
            new(deviceId, profile.Id, profile.Version, state, newest.WindowEndUtc,
                Trend(advice.Trend), Alert(advice.Alert), Maintenance(advice.Maintenance),
                true, "规则分析结果仅用于人工审核；通知历史、测点类别与审批未核验，不发送告警或工单")));
    }
}

