#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Extensions;
using IoTSharp.Services.DigitalTwin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// 数字孪生 GLB 模型资源中心 API。
/// </summary>
[Route("api/digital-twin/model-resources")]
[Authorize]
[ApiController]
public sealed class TwinModelResourcesController : ControllerBase
{
    private const string AllUserRoles = "NormalUser,CustomerAdmin,TenantAdmin,SystemAdmin";
    private const string AdminRoles = "CustomerAdmin,TenantAdmin,SystemAdmin";
    private readonly TwinModelResourceService _service;

    public TwinModelResourcesController(TwinModelResourceService service) => _service = service;

    [HttpGet]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<TwinModelResourceDto>>> List(
        [FromQuery] string? name,
        [FromQuery] TwinModelProcessingStatus? status,
        CancellationToken cancellationToken)
    {
        var data = await _service.ListAsync(this.GetUserProfile(), name, status, cancellationToken);
        return new ApiResult<List<TwinModelResourceDto>>(ApiCode.Success, "OK", data);
    }

    [HttpGet("{id:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinModelResourceDto>> Get(Guid id, CancellationToken cancellationToken)
    {
        var data = await _service.GetAsync(id, this.GetUserProfile(), cancellationToken);
        return data == null
            ? new ApiResult<TwinModelResourceDto>(ApiCode.CantFindObject, "模型资源不存在。", default!)
            : new ApiResult<TwinModelResourceDto>(ApiCode.Success, "OK", data);
    }

    [HttpPost("upload")]
    [Consumes("multipart/form-data")]
    [Authorize(Roles = AdminRoles)]
    [RequestSizeLimit(104_857_600)]
    public async Task<ApiResult<TwinModelResourceDto>> Upload([FromForm] TwinModelResourceUploadRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.UploadAsync(request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<TwinModelResourceDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinModelResourceDto>(exception.Code, exception.Message, default!);
        }
    }

    [HttpGet("{id:guid}/content")]
    [Authorize(Roles = AllUserRoles)]
    [Produces("model/gltf-binary")]
    [ProducesResponseType(typeof(FileStreamResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Content(Guid id, CancellationToken cancellationToken)
    {
        var content = await _service.OpenContentAsync(id, this.GetUserProfile(), cancellationToken);
        if (content == null) return NotFound(new ApiResult(ApiCode.NotFile, "模型资源不存在或尚未 Ready。"));
        Response.Headers.CacheControl = "private, max-age=31536000, immutable";
        return new FileStreamResult(content.Stream, content.ContentType)
        {
            EnableRangeProcessing = true,
            EntityTag = new EntityTagHeaderValue($"\"{content.Hash}\""),
            FileDownloadName = content.FileName
        };
    }

    [HttpPut("{id:guid}/license")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<TwinModelResourceDto>> UpdateLicense(Guid id, [FromBody] TwinModelLicenseUpdateRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.UpdateLicenseAsync(id, request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<TwinModelResourceDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinModelResourceDto>(exception.Code, exception.Message, default!);
        }
    }

    [HttpDelete("{id:guid}")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult> Delete(Guid id, CancellationToken cancellationToken)
    {
        try
        {
            await _service.DeleteAsync(id, this.GetUserProfile(), cancellationToken);
            return new ApiResult(ApiCode.Success, "OK");
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult(exception.Code, exception.Message);
        }
    }
}
