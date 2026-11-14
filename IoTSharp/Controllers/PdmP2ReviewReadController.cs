using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Controllers;

public sealed record PdmP2ReviewRowDto(
    Guid Id, Guid DeviceId, Guid ProfileId, int ProfileVersion,
    Guid RiskEventId, string Fingerprint, string Title, string State,
    int Revision, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record PdmP2AuditRowDto(
    Guid Id, Guid ReviewId, Guid ActorId,
    string Action, string Reason, DateTime AtUtc);

public sealed record PdmP2ReviewPageDto(
    int Total, int Page, int PageSize,
    IReadOnlyList<PdmP2ReviewRowDto> Rows,
    IReadOnlyList<PdmP2AuditRowDto> Audits);

/// <summary>
/// Read-only review trail API: no POST/PUT/DELETE route. Default gate is false,
/// and the isolated P2 review DB is NOT registered in production startup.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm/p2")]
public sealed class PdmP2ReviewReadController(
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
        configuration.GetValue<bool>("PredictiveMaintenance:P2:ReviewReadEnabled");

    [HttpGet("reviews")]
    public async Task<IActionResult> GetReviews(
        [FromQuery] Guid deviceId, [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20, CancellationToken cancellationToken = default)
    {
        // Fail closed before DB resolution when P2 review metadata is not deployed.
        if (!Enabled)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData,
                    "P2 审核台账尚未部署或通过上线门禁", new { }));

        if (User?.Identity?.IsAuthenticated != true ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out var tenant) ||
            tenant == Guid.Empty ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out var customer) ||
            customer == Guid.Empty)
            return StatusCode(StatusCodes.Status403Forbidden,
                new ApiResult<object>(ApiCode.InValidData, "缺少租户/客户作用域", new { }));
        if (deviceId == Guid.Empty || page is < 1 or > 1000 ||
            pageSize is < 1 or > 50)
            return BadRequest("设备或分页参数不合法");

        var db = services.GetService<PdmP2ReviewDbContext>();
        if (db is null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData,
                    "P2 审核独立数据库尚未注册", new { }));

        var query = db.Reviews.AsNoTracking()
            .Where(r => r.TenantId == tenant &&
                        r.CustomerId == customer && r.DeviceId == deviceId);
        var total = await query.CountAsync(cancellationToken);
        var rows = await query.OrderByDescending(r => r.CreatedAtUtc).ThenBy(r => r.Id)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .Select(r => new PdmP2ReviewRowDto(
                r.Id, r.DeviceId, r.ProfileId, r.ProfileVersion, r.RiskEventId,
                r.Fingerprint, r.Title, r.State, r.Revision,
                r.CreatedAtUtc, r.UpdatedAtUtc))
            .ToListAsync(cancellationToken);

        var ids = rows.Select(r => r.Id).ToArray();
        var audits = await db.Audits.AsNoTracking()
            .Where(a => a.TenantId == tenant &&
                        a.CustomerId == customer && ids.Contains(a.ReviewId))
            .OrderByDescending(a => a.AtUtc).ThenBy(a => a.Id)
            .Take(200)
            .Select(a => new PdmP2AuditRowDto(
                a.Id, a.ReviewId, a.ActorId, a.Action, a.Reason, a.AtUtc))
            .ToListAsync(cancellationToken);

        return Ok(new ApiResult<PdmP2ReviewPageDto>(ApiCode.Success, "OK",
            new(total, page, pageSize, rows, audits)));
    }
}

