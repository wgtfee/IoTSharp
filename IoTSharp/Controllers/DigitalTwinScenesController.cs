#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Extensions;
using IoTSharp.Services.DigitalTwin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// 数字孪生场景草稿、发布版本和运行清单 API。
/// </summary>
[Route("api/digital-twin/scenes")]
[Authorize]
[ApiController]
public sealed class DigitalTwinScenesController : ControllerBase
{
    private const string AllUserRoles = "NormalUser,CustomerAdmin,TenantAdmin,SystemAdmin";
    private const string AdminRoles = "CustomerAdmin,TenantAdmin,SystemAdmin";
    private readonly DigitalTwinSceneService _service;

    public DigitalTwinScenesController(DigitalTwinSceneService service) => _service = service;

    [HttpGet]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<DigitalTwinSceneDto>>> List(
        [FromQuery] Guid? rootAssetId,
        [FromQuery] string? name,
        [FromQuery] DigitalTwinSceneStatus? status,
        CancellationToken cancellationToken)
    {
        var data = await _service.ListAsync(this.GetUserProfile(), rootAssetId, name, status, cancellationToken);
        return new ApiResult<List<DigitalTwinSceneDto>>(ApiCode.Success, "OK", data);
    }

    [HttpGet("binding-devices")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<TwinBindingDeviceOptionDto>>> BindingDevices(
        [FromQuery] Guid rootAssetId,
        CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.ListBindingDevicesAsync(rootAssetId, this.GetUserProfile(), cancellationToken);
            return new ApiResult<List<TwinBindingDeviceOptionDto>>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception)
        {
            return Failed<List<TwinBindingDeviceOptionDto>>(exception);
        }
    }

    [HttpGet("{id:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<DigitalTwinSceneDetailDto>> Get(Guid id, CancellationToken cancellationToken)
    {
        var data = await _service.GetAsync(id, this.GetUserProfile(), cancellationToken);
        return data == null
            ? new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.CantFindObject, "场景不存在。", default!)
            : new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.Success, "OK", data);
    }

    [HttpPost]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<DigitalTwinSceneDetailDto>> Create([FromBody] DigitalTwinSceneCreateDto request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.CreateAsync(request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinValidationException exception) { return Invalid<DigitalTwinSceneDetailDto>(exception); }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneDetailDto>(exception); }
    }

    [HttpPut("{id:guid}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<DigitalTwinSceneDetailDto>> Update(Guid id, [FromBody] DigitalTwinSceneUpdateDto request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.UpdateAsync(id, request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinValidationException exception) { return Invalid<DigitalTwinSceneDetailDto>(exception); }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneDetailDto>(exception); }
    }

    [HttpPut("{id:guid}/draft")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<DigitalTwinSceneDetailDto>> SaveDraft(Guid id, [FromBody] DigitalTwinDraftSaveDto request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.SaveDraftAsync(id, request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinValidationException exception) { return Invalid<DigitalTwinSceneDetailDto>(exception); }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneDetailDto>(exception); }
    }

    [HttpPost("{id:guid}/validate")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinValidationResultDto>> Validate(Guid id, [FromQuery] bool forPublish, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.ValidateAsync(id, this.GetUserProfile(), forPublish, cancellationToken);
            return new ApiResult<TwinValidationResultDto>(ApiCode.Success, data.Valid ? "OK" : "场景校验未通过。", data);
        }
        catch (TwinOperationException exception) { return Failed<TwinValidationResultDto>(exception); }
    }

    [HttpPost("{id:guid}/publish")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<DigitalTwinSceneVersionDto>> Publish(Guid id, [FromBody] DigitalTwinPublishDto request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.PublishAsync(id, request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneVersionDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinValidationException exception) { return Invalid<DigitalTwinSceneVersionDto>(exception); }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneVersionDto>(exception); }
    }

    [HttpGet("{id:guid}/versions")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<List<DigitalTwinSceneVersionDto>>> Versions(Guid id, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.ListVersionsAsync(id, this.GetUserProfile(), cancellationToken);
            return new ApiResult<List<DigitalTwinSceneVersionDto>>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception) { return Failed<List<DigitalTwinSceneVersionDto>>(exception); }
    }

    [HttpGet("{id:guid}/versions/{version:int}")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<DigitalTwinSceneVersionDto>> Version(Guid id, int version, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.GetVersionAsync(id, version, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneVersionDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneVersionDto>(exception); }
    }

    [HttpPost("{id:guid}/rollback/{version:int}")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<DigitalTwinSceneDetailDto>> Rollback(Guid id, int version, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _service.RollbackAsync(id, version, this.GetUserProfile(), cancellationToken);
            return new ApiResult<DigitalTwinSceneDetailDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinValidationException exception) { return Invalid<DigitalTwinSceneDetailDto>(exception); }
        catch (TwinOperationException exception) { return Failed<DigitalTwinSceneDetailDto>(exception); }
    }

    [HttpGet("{id:guid}/runtime-manifest")]
    [Authorize(Roles = AllUserRoles)]
    [Produces("application/json")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    public async Task<IActionResult> RuntimeManifest(Guid id, CancellationToken cancellationToken)
    {
        var manifest = await _service.GetRuntimeManifestAsync(id, this.GetUserProfile(), cancellationToken);
        if (manifest == null) return NotFound(new ApiResult(ApiCode.CantFindObject, "场景尚未发布。"));
        var etag = $"\"{manifest.Hash}\"";
        if (Request.Headers.IfNoneMatch == etag) return StatusCode(StatusCodes.Status304NotModified);
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "private, max-age=0, must-revalidate";
        Response.Headers["X-IoTSharp-Twin-Version"] = manifest.Version.ToString();
        return Content(manifest.Payload, "application/json");
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
        catch (TwinOperationException exception) { return new ApiResult(exception.Code, exception.Message); }
    }

    private static ApiResult<T> Failed<T>(TwinOperationException exception) => new(exception.Code, exception.Message, default!);

    private static ApiResult<T> Invalid<T>(TwinValidationException exception)
    {
        var message = exception.Validation.Diagnostics.Count == 0
            ? exception.Message
            : string.Join("；", exception.Validation.Diagnostics.ConvertAll(item =>
                string.IsNullOrWhiteSpace(item.Path) ? item.Message : $"{item.Path}: {item.Message}"));
        return new ApiResult<T>(ApiCode.InValidData, message, default!);
    }
}
