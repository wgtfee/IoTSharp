using System;
using System.Collections.Generic;

namespace IoTSharp.Data;

/// <summary>
/// 数字孪生场景不可变发布版本。
/// </summary>
public class DigitalTwinSceneVersion : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public int Version { get; set; }
    public string SchemaVersion { get; set; }
    public string Manifest { get; set; }
    public string ManifestHash { get; set; }
    public string ValidationReport { get; set; }
    public string ChangeSummary { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
    public ICollection<TwinObjectBinding> Bindings { get; set; } = new List<TwinObjectBinding>();
    public ICollection<TwinRoute> Routes { get; set; } = new List<TwinRoute>();
}
