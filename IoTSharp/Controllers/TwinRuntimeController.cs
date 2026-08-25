#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Extensions;
using IoTSharp.Services.DigitalTwin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// 数字孪生运行态数据 API。
/// </summary>
[Route("api/digital-twin/runtime")]
[Authorize]
[ApiController]
public sealed class TwinRuntimeController : ControllerBase
{
    private const string AllUserRoles = "NormalUser,CustomerAdmin,TenantAdmin,SystemAdmin";
    private readonly TwinRuntimeSnapshotService _snapshotService;

    public TwinRuntimeController(TwinRuntimeSnapshotService snapshotService) => _snapshotService = snapshotService;

    /// <summary>
    /// 批量读取已发布版本所需的最新 Device 数据。
    /// </summary>
    [HttpPost("snapshot")]
    [Authorize(Roles = AllUserRoles)]
    public async Task<ApiResult<TwinRuntimeSnapshotDto>> Snapshot([FromBody] TwinRuntimeSnapshotRequestDto request, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _snapshotService.SnapshotAsync(request, this.GetUserProfile(), cancellationToken);
            return new ApiResult<TwinRuntimeSnapshotDto>(ApiCode.Success, "OK", data);
        }
        catch (TwinOperationException exception)
        {
            return new ApiResult<TwinRuntimeSnapshotDto>(exception.Code, exception.Message, default!);
        }
    }
}
