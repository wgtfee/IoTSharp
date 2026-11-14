using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Controllers;

public sealed record PdmWorkOrderTransitionRequest(
    int ExpectedRevision, string Action, Guid? AssignedTo, string Reason);

public sealed record PdmInternalWorkOrderPageDto(
    int Total, int Page, int PageSize, IReadOnlyList<PdmInternalWorkOrder> Rows);

/// <summary>
/// IoTSharp's own maintenance work orders. Feishu is notification-only and has
/// NO authority to create, reassign, complete or close these orders.
/// All writes are IAM-scoped and disabled without reviewed SQL Server schema.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm/workorders")]
public sealed class PdmInternalWorkOrdersController(
    IServiceProvider services, IConfiguration config) : ControllerBase
{
    private bool Enabled =>
        config.GetValue<bool>("PredictiveMaintenance:Enabled") &&
        config.GetValue<bool>("PredictiveMaintenance:SchemaReady") &&
        config.GetValue<bool>("PredictiveMaintenance:WorkOrders:Enabled") &&
        config.GetValue<bool>("PredictiveMaintenance:WorkOrders:SchemaReady");

    private bool UserScope(out Guid tenant, out Guid customer, out Guid actor)
    {
        tenant = customer = actor = Guid.Empty;
        return User?.Identity?.IsAuthenticated == true &&
            Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out tenant) &&
            Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out customer) &&
            Guid.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out actor) &&
            tenant != Guid.Empty && customer != Guid.Empty && actor != Guid.Empty;
    }

    private IActionResult Unavailable() =>
        StatusCode(StatusCodes.Status503ServiceUnavailable,
            new ApiResult<object>(ApiCode.InValidData,
                "IoTSharp 内部维修工单数据库尚未部署或未启用", new { }));

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        [FromQuery] Guid? deviceId = null, [FromQuery] string? state = null,
        CancellationToken ct = default)
    {
        if (!Enabled) return Unavailable();
        if (!UserScope(out var tenant, out var customer, out _)) return Forbid();
        if (page is < 1 or > 1000 || pageSize is < 1 or > 100 ||
            (state is not null &&
             state is not ("Open" or "Assigned" or "InProgress" or "Completed" or "Closed")))
            return BadRequest("工单分页或状态参数无效");
        var db = services.GetService<PdmInternalWorkOrderDbContext>();
        if (db is null) return Unavailable();
        var query = db.WorkOrders.AsNoTracking()
            .Where(x => x.TenantId == tenant && x.CustomerId == customer);
        if (deviceId is { } d && d != Guid.Empty)
            query = query.Where(x => x.DeviceId == d);
        if (!string.IsNullOrEmpty(state))
            query = query.Where(x => x.State == state);
        var total = await query.CountAsync(ct);
        var rows = await query.OrderByDescending(x => x.CreatedAtUtc)
            .ThenByDescending(x => x.Id).Skip((page - 1) * pageSize)
            .Take(pageSize).ToListAsync(ct);
        return Ok(new ApiResult<PdmInternalWorkOrderPageDto>(ApiCode.Success,
            "OK", new(total, page, pageSize, rows)));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Detail(Guid id, CancellationToken ct = default)
    {
        if (!Enabled) return Unavailable();
        if (!UserScope(out var tenant, out var customer, out _)) return Forbid();
        var service = services.GetService<PdmInternalWorkOrderService>();
        if (service is null) return Unavailable();
        var record = await service.GetAsync(tenant, customer, id, ct);
        return record is null ? NotFound()
            : Ok(new ApiResult<PdmInternalWorkOrder>(ApiCode.Success, "OK", record));
    }

    /// <summary>
    /// A human may create only from a verified, persisted P1 risk event.
    /// No arbitrary client-created alarm/label/order payload is accepted.
    /// </summary>
    [HttpPost("from-risk/{riskEventId:guid}")]
    [Authorize(Roles = "PdmWorkOrderManager,SystemAdmin,TenantAdmin,CustomerAdmin")]
    public async Task<IActionResult> CreateFromRisk(Guid riskEventId,
        CancellationToken ct = default)
    {
        if (!Enabled || !config.GetValue<bool>(
                "PredictiveMaintenance:WorkOrders:ManualCreateEnabled"))
            return Unavailable();
        if (!UserScope(out var tenant, out var customer, out var actor)) return Forbid();
        var source = services.GetService<PdmDbContext>();
        var service = services.GetService<PdmInternalWorkOrderService>();
        if (source is null || service is null) return Unavailable();
        var episode = await source.RiskEvents.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == riskEventId &&
                 x.TenantId == tenant && x.CustomerId == customer, ct);
        if (episode is null) return NotFound();
        var profile = await source.DeviceProfiles.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == episode.ProfileId && x.TenantId == tenant &&
                 x.CustomerId == customer && x.DeviceId == episode.DeviceId, ct);
        var snapshot = await source.HealthSnapshots.AsNoTracking().SingleOrDefaultAsync(
            x => x.TenantId == tenant && x.CustomerId == customer &&
                 x.ProfileId == episode.ProfileId &&
                 x.DeviceId == episode.DeviceId &&
                 x.ProfileVersion == episode.ProfileVersion &&
                 x.WindowEndUtc == episode.LastEvaluatedWindowEndUtc, ct);
        if (profile is null || snapshot is null)
            return Conflict("风险事件缺少可信的设备与评估快照");
        // SQL Server materializes datetime2 as Unspecified; schema stores UTC.
        episode.LastEvaluatedWindowEndUtc =
            DateTime.SpecifyKind(episode.LastEvaluatedWindowEndUtc, DateTimeKind.Utc);
        episode.FirstObservedUtc = DateTime.SpecifyKind(episode.FirstObservedUtc, DateTimeKind.Utc);
        snapshot.WindowStartUtc = DateTime.SpecifyKind(snapshot.WindowStartUtc, DateTimeKind.Utc);
        snapshot.WindowEndUtc = DateTime.SpecifyKind(snapshot.WindowEndUtc, DateTimeKind.Utc);
        try
        {
            var order = await service.OpenFromVerifiedRiskAsync(
                profile, episode, snapshot, actor, ct);
            return Ok(new ApiResult<PdmInternalWorkOrder>(ApiCode.Success,
                "已生成 IoTSharp 内部维修工单；飞书通知独立排队，尚不代表已送达", order));
        }
        catch (InvalidOperationException)
        {
            return Conflict("风险事件不满足真实点位、数据质量或持续异常的建单要求");
        }
        catch (DbUpdateException)
        {
            return Conflict("工单并发创建冲突，请刷新查看同一事件已有工单");
        }
    }

    [HttpPost("{id:guid}/transition")]
    [Authorize(Roles = "PdmWorkOrderManager,PdmTechnician,SystemAdmin,TenantAdmin,CustomerAdmin,NormalUser")]
    public async Task<IActionResult> Transition(Guid id,
        [FromBody] PdmWorkOrderTransitionRequest request,
        CancellationToken ct = default)
    {
        if (!Enabled) return Unavailable();
        if (!UserScope(out var tenant, out var customer, out var actor)) return Forbid();
        if (request is null || request.Action is not
                ("Assign" or "Start" or "Complete" or "Close") ||
            request.ExpectedRevision < 1 ||
            string.IsNullOrWhiteSpace(request.Reason) ||
            request.Reason.Length > 512)
            return BadRequest("工单操作参数无效");
        if (request.Action is "Assign" or "Close" &&
            !(User.IsInRole("PdmWorkOrderManager") ||
              User.IsInRole("SystemAdmin") ||
              User.IsInRole("TenantAdmin") ||
              User.IsInRole("CustomerAdmin")))
            return Forbid();
        var service = services.GetService<PdmInternalWorkOrderService>();
        if (service is null) return Unavailable();
        try
        {
            var order = await service.TransitionAsync(
                tenant, customer, id, request.ExpectedRevision,
                request.Action, actor, request.AssignedTo, request.Reason, ct);
            return Ok(new ApiResult<PdmInternalWorkOrder>(ApiCode.Success, "OK", order));
        }
        catch (KeyNotFoundException) { return NotFound(); }
        catch (DbUpdateConcurrencyException) { return Conflict("工单版本变化，请刷新"); }
        catch (InvalidOperationException) { return Conflict("工单状态流转或维修人员身份无效"); }
        catch (ArgumentException) { return BadRequest("工单操作参数无效"); }
    }
}
