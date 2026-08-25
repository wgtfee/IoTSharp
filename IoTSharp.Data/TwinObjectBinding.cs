using IoTSharp.Contracts;
using System;

namespace IoTSharp.Data;

/// <summary>
/// 场景对象与模型资源、Asset、Device 及运行点位之间的持久化绑定。
/// </summary>
public class TwinObjectBinding : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public Guid? SceneVersionId { get; set; }
    public DigitalTwinSceneVersion SceneVersion { get; set; }
    public string BindingKey { get; set; }
    public string ObjectId { get; set; }
    public string NodePath { get; set; }
    public Guid? ModelResourceId { get; set; }
    public TwinModelResource ModelResource { get; set; }
    public Guid? AssetId { get; set; }
    public Asset Asset { get; set; }
    public Guid? DeviceId { get; set; }
    public Device Device { get; set; }
    public string SemanticId { get; set; }
    public TwinBindingSourceKind SourceKind { get; set; }
    public string SourceKey { get; set; }
    public TwinBindingTargetKind TargetKind { get; set; }
    public string TargetPath { get; set; }
    public string TransformKind { get; set; } = "identity";
    public string TransformConfig { get; set; }
    public int Priority { get; set; }
    public int StaleAfterMs { get; set; } = 10000;
    public bool Enabled { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
}
