using System;
using System.Security.Claims;
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

public sealed record PdmP2ReviewDecisionRequest(
    int ExpectedRevision, bool ApproveForPlanning, string Reason);

public sealed record PdmP2ReviewDecisionDto(
    Guid Id, int Revision, string State, DateTime UpdatedAtUtc,
    bool IsWorkOrderCreated = false, bool IsAlertDelivered = false);

/// <summary>
/// Explicit opt-in reviewed-decision endpoint. This cannot create proposals,
/// send alerts, create work orders or bypass production P1 gates.
/// Role mapping must be audited before anyone is assigned PdmReviewApprover.
/// </summary>
[ApiController]
[Authorize]
[Route("api/pdm/p2/reviews")]
public sealed class PdmP2ReviewDecisionController(
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
        configuration.GetValue<bool>("PredictiveMaintenance:P2:ReviewReadEnabled") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P2:ReviewWriteEnabled") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P2:ReviewSchemaReady") &&
        configuration.GetValue<bool>("PredictiveMaintenance:P2:IamMappingApproved");

    [HttpPost("{id:guid}/decision")]
    [Authorize(Roles = "PdmReviewApprover")]
    public async Task<IActionResult> Decide(Guid id,
        [FromBody] PdmP2ReviewDecisionRequest request, CancellationToken cancellationToken = default)
    {
        // Reject before DI resolves the separate review DB.
        if (!Enabled)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData,
                    "P2 审批写入及其 IAM/Schema 门禁未批准", new { }));
        if (User.Identity?.IsAuthenticated != true ||
            !User.IsInRole("PdmReviewApprover") ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Tenant)?.Value, out var tenant) ||
            !Guid.TryParse(User.FindFirst(IoTSharpClaimTypes.Customer)?.Value, out var customer) ||
            !Guid.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var userId) ||
            tenant == Guid.Empty || customer == Guid.Empty || userId == Guid.Empty)
            return Forbid();
        if (id == Guid.Empty || request is null || request.ExpectedRevision < 1 ||
            string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Length > 512)
            return BadRequest("审批必须带预期版本及有效理由");

        var db = services.GetService<PdmP2ReviewDbContext>();
        if (db is null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new ApiResult<object>(ApiCode.InValidData, "独立审批库未部署", new { }));
        var actor = new PdmP2TrustedActor(tenant, customer, userId,
            IsAuthenticated: true, CanSubmitDraft: false, CanReview: true);
        try
        {
            var decided = await new PdmP2ReviewLedger(db).DecideAsync(
                id, request.ExpectedRevision, request.ApproveForPlanning,
                request.Reason, actor, cancellationToken);
            return Ok(new ApiResult<PdmP2ReviewDecisionDto>(
                ApiCode.Success, "仅完成内部审核，不代表创建工单或发送通知",
                new(decided.Id, decided.Revision, decided.State, decided.UpdatedAtUtc)));
        }
        catch (UnauthorizedAccessException)
        {
            return NotFound(); // No cross-tenant existence leakage
        }
        catch (DbUpdateConcurrencyException)
        {
            return Conflict("审批版本已变化，请重新加载");
        }
    }
}

