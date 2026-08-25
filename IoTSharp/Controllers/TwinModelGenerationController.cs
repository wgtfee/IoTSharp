#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Extensions;
using IoTSharp.Services.DigitalTwin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// img2threejs 图片生成模型任务 API。
/// </summary>
[Route("api/digital-twin/model-generation")]
[Authorize]
[ApiController]
public sealed class TwinModelGenerationController : ControllerBase
{
    private const string AllUserRoles = "NormalUser,CustomerAdmin,TenantAdmin,SystemAdmin";
    private const string AdminRoles = "CustomerAdmin,TenantAdmin,SystemAdmin";
    private readonly TwinModelGenerationService _service;

    public TwinModelGenerationController(TwinModelGenerationService service) => _service = service;

    [HttpGet("capabilities")]
    [Authorize(Roles = AllUserRoles)]
    public ApiResult<TwinModelGenerationCapabilitiesDto> Capabilities() =>
        new(ApiCode.Success, "OK", _service.GetCapabilities());

    [HttpGet("jobs")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<TwinModelGenerationJobDto>>> List(CancellationToken cancellationToken) =>
        new(ApiCode.Success, "OK", await _service.ListAsync(this.GetUserProfile(), cancellationToken));

    [HttpGet("jobs/{id:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinModelGenerationJobDto>> Get(Guid id, CancellationToken cancellationToken)
    {
        var job = await _service.GetAsync(id, this.GetUserProfile(), cancellationToken);
        return job == null
            ? new ApiResult<TwinModelGenerationJobDto>(ApiCode.CantFindObject, "生成任务不存在。", default!)
            : new ApiResult<TwinModelGenerationJobDto>(ApiCode.Success, "OK", job);
    }

    [HttpPost("jobs")]
    [Consumes("multipart/form-data")]
    [Authorize(Roles = AdminRoles)]
    [RequestSizeLimit(20_971_520)]
    public async Task<ApiResult<TwinModelGenerationJobDto>> Create(
        [FromForm] TwinModelGenerationCreateRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var job = await _service.CreateAsync(request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<TwinModelGenerationJobDto>(ApiCode.Success, "OK", job);
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinModelGenerationJobDto>(exception.Code, exception.Message, default!);
        }
    }

    [HttpGet("jobs/{id:guid}/reference")]
    [Authorize(Roles = AllUserRoles)]
    [ProducesResponseType(typeof(FileStreamResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Reference(Guid id, CancellationToken cancellationToken)
    {
        var reference = await _service.OpenReferenceAsync(id, this.GetUserProfile(), cancellationToken);
        if (reference == null) return NotFound(new ApiResult(ApiCode.NotFile, "参考图片不存在。"));
        return new FileStreamResult(reference.Stream, reference.ContentType)
        {
            FileDownloadName = reference.FileName,
            EnableRangeProcessing = true
        };
    }

    [HttpPost("jobs/{id:guid}/cancel")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<TwinModelGenerationJobDto>> Cancel(Guid id, CancellationToken cancellationToken)
    {
        try
        {
            return new ApiResult<TwinModelGenerationJobDto>(ApiCode.Success, "OK", await _service.CancelAsync(id, this.GetUserProfile(), cancellationToken));
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinModelGenerationJobDto>(exception.Code, exception.Message, default!);
        }
    }

    [HttpPost("jobs/{id:guid}/retry")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<TwinModelGenerationJobDto>> Retry(Guid id, CancellationToken cancellationToken)
    {
        try
        {
            return new ApiResult<TwinModelGenerationJobDto>(ApiCode.Success, "OK", await _service.RetryAsync(id, this.GetUserProfile(), cancellationToken));
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinModelGenerationJobDto>(exception.Code, exception.Message, default!);
        }
    }
}
