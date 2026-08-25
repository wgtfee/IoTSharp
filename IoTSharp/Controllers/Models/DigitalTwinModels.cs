using IoTSharp.Contracts;
using Microsoft.AspNetCore.Http;
using System;

namespace IoTSharp.Controllers.Models;

/// <summary>
/// GLB 模型资源上传表单。
/// </summary>
public sealed class TwinModelResourceUploadRequest
{
    public IFormFile File { get; set; }
    public string ResourceKey { get; set; }
    public string Name { get; set; }
    public TwinModelSourceType SourceType { get; set; } = TwinModelSourceType.Upload;
    public Guid? ProductId { get; set; }
    public string LicenseType { get; set; } = "Proprietary";
    public string LicenseTextUrl { get; set; }
    public string SourceUrl { get; set; }
    public string Author { get; set; }
    public bool CommercialUseAllowed { get; set; }
}

/// <summary>
/// 模型来源和授权信息更新请求。
/// </summary>
public sealed class TwinModelLicenseUpdateRequest
{
    public string LicenseType { get; set; } = "Proprietary";
    public string LicenseTextUrl { get; set; }
    public string SourceUrl { get; set; }
    public string Author { get; set; }
    public bool CommercialUseAllowed { get; set; }
}

/// <summary>
/// img2threejs 图片生成任务表单。任务先入库，再由受控 Worker 异步生成 GLB。
/// </summary>
public sealed class TwinModelGenerationCreateRequest
{
    public IFormFile ReferenceImage { get; set; }
    public string Name { get; set; }
    public string Prompt { get; set; }
    public string QualityProfile { get; set; } = "Production";
    public bool AnimationReady { get; set; } = true;
    public string LicenseType { get; set; } = "Proprietary-Generated";
    public bool CommercialUseAllowed { get; set; }
    public bool ReferenceRightsConfirmed { get; set; }
}
