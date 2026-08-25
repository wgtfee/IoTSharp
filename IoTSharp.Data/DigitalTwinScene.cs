using IoTSharp.Contracts;
using System;
using System.Collections.Generic;

namespace IoTSharp.Data;

/// <summary>
/// 归属于根 Asset 的数字孪生场景，草稿与发布版本严格分离。
/// </summary>
public class DigitalTwinScene : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string SceneKey { get; set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public Guid RootAssetId { get; set; }
    public Asset RootAsset { get; set; }
    public DigitalTwinSceneStatus Status { get; set; } = DigitalTwinSceneStatus.Draft;
    public string DraftPayload { get; set; }
    public Guid? PublishedVersionId { get; set; }
    public DigitalTwinSceneVersion PublishedVersion { get; set; }
    public long Revision { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
    public ICollection<DigitalTwinSceneVersion> Versions { get; set; } = new List<DigitalTwinSceneVersion>();
    public ICollection<TwinObjectBinding> Bindings { get; set; } = new List<TwinObjectBinding>();
    public ICollection<TwinRoute> Routes { get; set; } = new List<TwinRoute>();
}
