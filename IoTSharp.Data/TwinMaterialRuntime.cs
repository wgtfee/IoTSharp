using System;

namespace IoTSharp.Data;

/// <summary>实时模式中的物料/运输单元权威所有权状态。</summary>
public sealed class TwinMaterialRuntime : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public string MaterialInstanceId { get; set; }
    public string TransportUnitId { get; set; }
    public string MaterialType { get; set; }
    public string OwnerType { get; set; }
    public string OwnerId { get; set; }
    public string PoseSource { get; set; }
    public TwinMaterialRuntimeStatus Status { get; set; } = TwinMaterialRuntimeStatus.Unknown;
    public long Revision { get; set; } = 1;
    public long LastEventSequence { get; set; }
    public string Metadata { get; set; } = "{}";
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
