using System;

namespace IoTSharp.Data;

/// <summary>
/// 可独立校验、查询和复用的场景运动路线。
/// </summary>
public class TwinRoute : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public Guid? SceneVersionId { get; set; }
    public DigitalTwinSceneVersion SceneVersion { get; set; }
    public string RouteKey { get; set; }
    public string Name { get; set; }
    public string RouteType { get; set; }
    public string GraphPayload { get; set; }
    public long Revision { get; set; } = 1;
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
