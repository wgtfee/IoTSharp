#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Extensions;
using IoTSharp.Services.DigitalTwin;
using IoTSharp.Services.DigitalTwin.ActionFlow;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace IoTSharp.Controllers;

/// <summary>Action Flow V2 定义校验、发布定义读取和生产 Run 控制 API。</summary>
[ApiController]
[Authorize]
[Route("api/digital-twin/action-flows")]
public sealed class DigitalTwinActionFlowsController : ControllerBase
{
    private const string AllUserRoles = "NormalUser,CustomerAdmin,TenantAdmin,SystemAdmin";
    private const string AdminRoles = "CustomerAdmin,TenantAdmin,SystemAdmin";
    private readonly TwinActionFlowRuntimeService _runtime;

    public DigitalTwinActionFlowsController(TwinActionFlowRuntimeService runtime) => _runtime = runtime;

    [HttpPost("validate")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinValidationResultDto>> Validate([FromBody] TwinActionFlowCompileRequestDto request, CancellationToken cancellationToken)
    {
        try
        {
            var result = await _runtime.CompileAsync(request.SceneId, request.Flow, this.GetUserProfile(), cancellationToken);
            return new(ApiCode.Success, result.Valid ? "OK" : "流程校验未通过。", new TwinValidationResultDto { Diagnostics = result.Diagnostics });
        }
        catch (TwinOperationException exception) { return Failed<TwinValidationResultDto>(exception); }
    }

    [HttpPost("compile")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowCompileResultDto>> Compile([FromBody] TwinActionFlowCompileRequestDto request, CancellationToken cancellationToken)
    {
        try
        {
            var result = await _runtime.CompileAsync(request.SceneId, request.Flow, this.GetUserProfile(), cancellationToken);
            return new(ApiCode.Success, result.Valid ? "OK" : "流程编译未通过。", result);
        }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowCompileResultDto>(exception); }
    }

    [HttpGet("{flowId:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowDto>> Get(Guid flowId, CancellationToken cancellationToken)
    {
        var flow = await _runtime.GetFlowAsync(flowId, this.GetUserProfile(), cancellationToken);
        return flow == null ? new(ApiCode.CantFindObject, "流程不存在。", default!) : new(ApiCode.Success, "OK", flow);
    }

    [HttpPost("{flowId:guid}/runs")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Start(Guid flowId, [FromBody] TwinActionFlowRunCreateDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.StartRunAsync(flowId, request, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpGet("runs/{runId:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Run(Guid runId, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.GetRunAsync(runId, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpGet("runs/{runId:guid}/events")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<TwinActionFlowEventDto>>> Events(Guid runId, [FromQuery] long afterSequence = 0, [FromQuery] int take = 500, CancellationToken cancellationToken = default)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.GetEventsAsync(runId, afterSequence, take, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<List<TwinActionFlowEventDto>>(exception); }
    }

    [HttpPost("runs/{runId:guid}/pause")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Pause(Guid runId, [FromBody] TwinActionFlowRunControlDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.PauseAsync(runId, request.Reason, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpPost("runs/{runId:guid}/resume")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Resume(Guid runId, [FromBody] TwinActionFlowRunControlDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.ResumeAsync(runId, request.Reason, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpPost("runs/{runId:guid}/cancel")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Cancel(Guid runId, [FromBody] TwinActionFlowRunControlDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.CancelAsync(runId, request.Reason ?? string.Empty, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpPost("runs/{runId:guid}/steps/{stepInstanceId}/retry")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Retry(Guid runId, string stepInstanceId, [FromBody] TwinActionFlowRunControlDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.RetryStepAsync(runId, stepInstanceId, request.Reason, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    [HttpPost("runs/{runId:guid}/manual-confirm")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> ManualConfirm(Guid runId, [FromBody] TwinActionFlowManualConfirmDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.ManualConfirmAsync(runId, request, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    /// <summary>供受控设备适配器/运维联调注入具有 commandId/cycleId 的反馈。</summary>
    [HttpPost("runs/{runId:guid}/command-feedback")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> CommandFeedback(Guid runId, [FromBody] TwinActionFlowCommandFeedbackDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.ApplyCommandFeedbackAsync(runId, request, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    /// <summary>供遥测桥接层输入 WaitSignal 所需绑定信号；前端实时模式不直接调用 PLC。</summary>
    [HttpPost("runs/{runId:guid}/signals")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinActionFlowRunDto>> Signal(Guid runId, [FromBody] TwinActionFlowSignalDto request, CancellationToken cancellationToken)
    {
        try { return new(ApiCode.Success, "OK", await _runtime.ApplySignalAsync(runId, request, this.GetUserProfile(), cancellationToken)); }
        catch (TwinOperationException exception) { return Failed<TwinActionFlowRunDto>(exception); }
    }

    private static ApiResult<T> Failed<T>(TwinOperationException exception) => new(exception.Code, exception.Message, default!);
}
