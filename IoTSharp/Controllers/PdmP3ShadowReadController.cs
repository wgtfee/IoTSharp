using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Controllers;

/// <summary>
/// Adapter to a previously independently verified and immutable offline
/// snapshot store. No production implementation is registered in Startup.
/// </summary>
public interface IPdmP3VerifiedShadowReadStore
{
    Task<PdmP3StoredShadowEvidence?> FetchAsync(
        Guid tenantId, Guid customerId, Guid deviceId,
        Guid profileId, int profileVersion, CancellationToken ct);
}

public sealed record PdmP3StoredShadowEvidence(
    Guid TenantId, Guid CustomerId, Guid DeviceId,
    Guid ProfileId, int ProfileVersion,
    DateTimeOffset WindowEndUtc, DateTimeOffset CreatedAtUtc,
    bool P2WindowVerified, bool DatasetProvenanceVerified,
    string ExperimentSha256, PdmP3ShadowReport Report);

public sealed record PdmP3ShadowReadDto(
    Guid DeviceId, Guid ProfileId, int ProfileVersion,
    string State, DateTimeOffset? WindowEndUtc,
    string Explanation, string? PointKey, string? Unit,
    string? OperatingMode, double? RobustDeviationScore,
    double? BaselineMedian, double? BaselineMad,
    string? ExperimentSha256, bool ReadOnly,
    bool IsAlertDelivered = false, bool IsWorkOrderCreated = false,
    double? FailureProbability = null, double? RemainingUsefulLifeHours = null);

/// <summary>
/// Explicit opt-in read API. Never exposes unverified points as reliable ML
/// output or infers operating state/units from arbitrary P1 metadata.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm/p3")]
public sealed class PdmP3ShadowReadController(
    IServiceProvider services, IConfiguration configuration) : ControllerBase
{
    private bool Enabled =>
        configuration.GetValue<bool>("PredictiveMaintenance:Enabled") &&
        configuration.GetValue<bool>("PredictiveMaintenance:SchemaReady") &&
        configuration.GetValue<bool>("PredictiveMaintenance:SingleInstanceAcknowledged") &&
        configuration.GetValue<bool>("PredictiveMaintenance:PointMappingsApproved") &&
        configuration.GetValue<bool>("PredictiveMaintenance:HistoryQueryPlanApproved") &&
        configuration.GetValue<bool>("PredictiveMaintenance:HistoryUtcContractApproved") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P2:ReadOnlyEnabled") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P3:ReadOnlyEnabled") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P3:OfflineEvidenceSourceApproved");

    private static PdmP3ShadowReadDto Unknown(PdmDeviceProfile profile,string why) =>
        new(profile.DeviceId,profile.Id,profile.Version,"Unverified",null,
            why,null,null,null,null,null,null,null,true);

    [HttpGet("shadow")]
    public async Task<IActionResult> GetShadow(
        [FromQuery] Guid deviceId,CancellationToken cancellationToken=default)
    {
        // Gate first, before any database/source resolution.
        if(!Enabled)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData,
                    "P3 离线只读结果尚未获准发布；生产推理未启用",new{}));
        if(User?.Identity?.IsAuthenticated!=true ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value,out var tenant) ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value,out var customer) ||
            tenant==Guid.Empty || customer==Guid.Empty)
            return StatusCode(StatusCodes.Status403Forbidden,
                new ApiResult<object>(ApiCode.InValidData,"缺少可信租户/客户身份",new{}));
        if(deviceId==Guid.Empty) return BadRequest("设备 ID 无效");

        var db=services.GetService<PdmDbContext>();
        var source=services.GetService<IPdmP3VerifiedShadowReadStore>();
        if(db is null || source is null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData,
                    "可信 P3 只读证据存储未接入，拒绝返回模拟统计结果",new{}));
        var profile=await db.DeviceProfiles.AsNoTracking()
            .SingleOrDefaultAsync(p=>p.TenantId==tenant && p.CustomerId==customer &&
                p.DeviceId==deviceId,cancellationToken);
        if(profile is null) return NotFound();
        if(!profile.Enabled || !profile.PointMappingsVerified ||
            !profile.RunStateVerified)
            return Ok(new ApiResult<PdmP3ShadowReadDto>(ApiCode.Success,"OK",
                Unknown(profile,"设备点位/运行状态尚未完成现场核验")));

        var snapshot=await source.FetchAsync(tenant,customer,deviceId,
            profile.Id,profile.Version,cancellationToken);
        if(snapshot is null)
            return Ok(new ApiResult<PdmP3ShadowReadDto>(ApiCode.Success,"OK",
                Unknown(profile,"没有经过审计的 P3 离线 Shadow 证据")));
        var finding=snapshot.Report?.Finding;
        var scope=finding?.Scope;
        var now=DateTimeOffset.UtcNow;
        if(snapshot.TenantId!=tenant || snapshot.CustomerId!=customer ||
           snapshot.DeviceId!=deviceId || snapshot.ProfileId!=profile.Id ||
           snapshot.ProfileVersion!=profile.Version ||
           !snapshot.P2WindowVerified || !snapshot.DatasetProvenanceVerified ||
           snapshot.WindowEndUtc.Offset!=TimeSpan.Zero ||
           snapshot.CreatedAtUtc.Offset!=TimeSpan.Zero ||
           snapshot.CreatedAtUtc>now.AddMinutes(2) ||
           snapshot.WindowEndUtc>now.AddMinutes(2) ||
           snapshot.WindowEndUtc>snapshot.CreatedAtUtc ||
           snapshot.ExperimentSha256 is not {Length:64} ||
           !snapshot.ExperimentSha256.All(char.IsAsciiHexDigit) ||
           snapshot.Report is null ||
           snapshot.Report.State!=PdmP3ShadowState.ExplainableBaseline ||
           !snapshot.Report.IsReadOnly || snapshot.Report.IsAlertDelivered ||
           snapshot.Report.IsWorkOrderCreated ||
           snapshot.Report.FailureProbability.HasValue ||
           snapshot.Report.RemainingUsefulLife.HasValue ||
           finding is null || finding.State==PdmP3AnomalyState.Unknown ||
           finding.FailureProbability.HasValue || finding.RemainingUsefulLife.HasValue ||
           finding.AtUtc!=snapshot.WindowEndUtc ||
           finding.RobustDeviationScore is not double score ||
           !double.IsFinite(score) || score<0 ||
           scope is null || scope.TenantId!=tenant ||
           scope.CustomerId!=customer || scope.DeviceId!=deviceId ||
           scope.ProfileId!=profile.Id ||
           scope.ProfileVersion!=profile.Version ||
           !scope.MappingVerified || !scope.UnitVerified ||
           !scope.OperatingModeVerified ||
           string.IsNullOrWhiteSpace(scope.PointKey) ||
           string.IsNullOrWhiteSpace(scope.EngineeringUnit) ||
           string.IsNullOrWhiteSpace(scope.OperatingMode))
            return Ok(new ApiResult<PdmP3ShadowReadDto>(ApiCode.Success,"OK",
                Unknown(profile,"离线证据不完整、超范围或包含不允许的预测性声明")));

        var stale=now-snapshot.WindowEndUtc>TimeSpan.FromHours(24);
        var dto=new PdmP3ShadowReadDto(deviceId,profile.Id,profile.Version,
            stale?"HistoricalStatisticsOnly":"StatisticsOnly",
            snapshot.WindowEndUtc,
            stale?"仅为历史离线统计结果，已超过 24 小时，不代表当前设备状态":
                "经独立核验的只读统计偏离结果，不代表故障概率或剩余寿命",
            scope.PointKey,scope.EngineeringUnit,scope.OperatingMode,
            finding.RobustDeviationScore,finding.BaselineMedian,
            finding.BaselineMad,snapshot.ExperimentSha256,true);
        return Ok(new ApiResult<PdmP3ShadowReadDto>(ApiCode.Success,"OK",dto));
    }
}

