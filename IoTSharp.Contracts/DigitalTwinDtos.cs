using System.Text.Json;
using System.Text.Json.Serialization;

namespace IoTSharp.Contracts;

/// <summary>
/// 数字孪生跨端合同版本。
/// </summary>
public static class DigitalTwinContractVersions
{
    /// <summary>
    /// IoTSharp 数字孪生场景清单 v1。
    /// </summary>
    public const string SceneV1 = "iotsharp-twin-scene/v1";
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DigitalTwinSceneStatus
{
    Draft,
    Published,
    Archived,
    Orphaned
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TwinModelSourceType
{
    ManufacturerCad,
    Blender,
    ModelLibrary,
    Img2ThreeJs,
    Upload,
    Generated
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TwinModelProcessingStatus
{
    Uploaded,
    Scanning,
    Processing,
    Ready,
    Rejected,
    Failed
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TwinModelGenerationStatus
{
    WaitingForWorker,
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TwinBindingSourceKind
{
    Resource,
    Telemetry,
    Attribute,
    Alarm,
    Connectivity,
    CommandFeedback,
    Constant,
    Simulation
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TwinBindingTargetKind
{
    Object,
    Visible,
    Color,
    Emissive,
    Opacity,
    Text,
    Number,
    Position,
    Rotation,
    Scale,
    Animation,
    RouteProgress,
    RouteDistance,
    CustomProperty
}

/// <summary>
/// 场景清单校验诊断。
/// </summary>
public sealed class TwinValidationDiagnosticDto
{
    public string Severity { get; set; } = "error";
    public string Code { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string? Path { get; set; }
}

/// <summary>
/// 场景清单校验结果。
/// </summary>
public sealed class TwinValidationResultDto
{
    public bool Valid => Diagnostics.All(item => !string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase));
    public List<TwinValidationDiagnosticDto> Diagnostics { get; set; } = [];
}

/// <summary>
/// 数字孪生编辑器数据绑定可选择的设备。
/// </summary>
public sealed class TwinBindingDeviceOptionDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public bool AssetRelated { get; set; }
}

/// <summary>
/// 数字孪生场景摘要。
/// </summary>
public class DigitalTwinSceneDto
{
    public Guid Id { get; set; }
    public string SceneKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public Guid RootAssetId { get; set; }
    public string RootAssetName { get; set; } = string.Empty;
    public DigitalTwinSceneStatus Status { get; set; }
    public Guid? PublishedVersionId { get; set; }
    public int? PublishedVersion { get; set; }
    public long? PublishedSourceRevision { get; set; }
    public long Revision { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public string UpdatedBy { get; set; } = string.Empty;
}

/// <summary>
/// 场景详情及当前草稿。
/// </summary>
public sealed class DigitalTwinSceneDetailDto : DigitalTwinSceneDto
{
    public JsonElement DraftPayload { get; set; }
    public List<TwinObjectBindingDto> Bindings { get; set; } = [];
    public List<TwinRouteDto> Routes { get; set; } = [];
}

public sealed class DigitalTwinSceneCreateDto
{
    public string? SceneKey { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid RootAssetId { get; set; }
    public JsonElement? DraftPayload { get; set; }
}

public sealed class DigitalTwinSceneUpdateDto
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public Guid RootAssetId { get; set; }
}

public sealed class DigitalTwinDraftSaveDto
{
    public long Revision { get; set; }
    public string? Name { get; set; }
    public string? Description { get; set; }
    public Guid? RootAssetId { get; set; }
    public JsonElement Payload { get; set; }
}

public sealed class DigitalTwinPublishDto
{
    public long Revision { get; set; }
    public string? ChangeSummary { get; set; }
}

public sealed class DigitalTwinSceneVersionDto
{
    public Guid Id { get; set; }
    public Guid SceneId { get; set; }
    public int Version { get; set; }
    public long SourceDraftRevision { get; set; }
    public string SchemaVersion { get; set; } = DigitalTwinContractVersions.SceneV1;
    public string ManifestHash { get; set; } = string.Empty;
    public string ChangeSummary { get; set; } = string.Empty;
    public JsonElement ValidationReport { get; set; }
    public JsonElement? Manifest { get; set; }
    public DateTime CreatedAt { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public bool IsCurrent { get; set; }
}

/// <summary>
/// 场景对象到模型、Asset、Device 和点位的数据库绑定。
/// </summary>
public sealed class TwinObjectBindingDto
{
    public Guid Id { get; set; }
    public Guid SceneId { get; set; }
    public Guid? SceneVersionId { get; set; }
    public string BindingKey { get; set; } = string.Empty;
    public string ObjectId { get; set; } = string.Empty;
    public string? NodePath { get; set; }
    public Guid? ModelResourceId { get; set; }
    public Guid? AssetId { get; set; }
    public Guid? DeviceId { get; set; }
    public string? SemanticId { get; set; }
    public TwinBindingSourceKind SourceKind { get; set; }
    public string? SourceKey { get; set; }
    public TwinBindingTargetKind TargetKind { get; set; }
    public string? TargetPath { get; set; }
    public string TransformKind { get; set; } = "identity";
    public JsonElement TransformConfig { get; set; }
    public int Priority { get; set; }
    public int StaleAfterMs { get; set; } = 10000;
    public bool Enabled { get; set; } = true;
}

public sealed class TwinRouteDto
{
    public Guid Id { get; set; }
    public Guid SceneId { get; set; }
    public Guid? SceneVersionId { get; set; }
    public string RouteKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string RouteType { get; set; } = "conveyor";
    public JsonElement GraphPayload { get; set; }
    public long Revision { get; set; }
    public bool Enabled { get; set; }
}

public sealed class TwinModelLicenseDto
{
    public string LicenseType { get; set; } = "Proprietary";
    public string? LicenseTextUrl { get; set; }
    public string? SourceUrl { get; set; }
    public string? Author { get; set; }
    public bool CommercialUseAllowed { get; set; }
}

public sealed class TwinModelResourceDto
{
    public Guid Id { get; set; }
    public string ResourceKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public TwinModelSourceType SourceType { get; set; }
    public string RuntimeFormat { get; set; } = "model/gltf-binary";
    public string OriginalFileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string ContentHash { get; set; } = string.Empty;
    public JsonElement NodeIndex { get; set; }
    public JsonElement ModelMetadata { get; set; }
    public TwinModelProcessingStatus ProcessingStatus { get; set; }
    public TwinModelLicenseDto License { get; set; } = new();
    public Guid? ProductId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
}

public sealed class TwinModelGenerationCapabilitiesDto
{
    public string Provider { get; set; } = "Img2ThreeJs";
    public bool Configured { get; set; }
    public bool AcceptsReferenceImage { get; set; } = true;
    public bool AcceptsTextOnly { get; set; }
    public string OutputFormat { get; set; } = "GLB";
    public int MaxReferenceImageMb { get; set; } = 15;
    public string Message { get; set; } = string.Empty;
}

public sealed class TwinModelGenerationJobDto
{
    public Guid Id { get; set; }
    public string JobKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Provider { get; set; } = "Img2ThreeJs";
    public string Prompt { get; set; } = string.Empty;
    public string QualityProfile { get; set; } = "Production";
    public bool AnimationReady { get; set; }
    public string ReferenceImageName { get; set; } = string.Empty;
    public long ReferenceImageSize { get; set; }
    public TwinModelGenerationStatus Status { get; set; }
    public int Progress { get; set; }
    public string Stage { get; set; } = string.Empty;
    public string ErrorMessage { get; set; } = string.Empty;
    public int AttemptCount { get; set; }
    public Guid? ResultModelResourceId { get; set; }
    public TwinModelResourceDto? ResultModelResource { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
}

public sealed class TwinRuntimeSnapshotRequestDto
{
    public Guid SceneId { get; set; }
    public int? Version { get; set; }
}

public sealed class TwinRuntimeSnapshotDto
{
    public Guid SceneId { get; set; }
    public DateTime ServerTimestamp { get; set; }
    public List<TwinDataUpdateDto> Updates { get; set; } = [];
}

public sealed class TwinDataUpdateDto
{
    public Guid BindingId { get; set; }
    public string BindingKey { get; set; } = string.Empty;
    public string ObjectId { get; set; } = string.Empty;
    public Guid? DeviceId { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public object? Value { get; set; }
    public DateTime SourceTimestamp { get; set; }
    public string Quality { get; set; } = "good";
    public bool Stale { get; set; }
}
