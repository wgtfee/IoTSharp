using IoTSharp.Contracts;
using System;
using System.Collections.Generic;

namespace IoTSharp.Data;

/// <summary>
/// 可复用的 GLB 运行时模型资源及其来源、授权与检查信息。
/// </summary>
public class TwinModelResource : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ResourceKey { get; set; }
    public string Name { get; set; }
    public TwinModelSourceType SourceType { get; set; } = TwinModelSourceType.Upload;
    public string RuntimeFormat { get; set; } = "model/gltf-binary";
    public string OriginalFileName { get; set; }
    public string StoragePath { get; set; }
    public long FileSize { get; set; }
    public string ContentHash { get; set; }
    public string NodeIndex { get; set; }
    public string ModelMetadata { get; set; }
    public TwinModelProcessingStatus ProcessingStatus { get; set; } = TwinModelProcessingStatus.Uploaded;
    public string LicenseMetadata { get; set; }
    public Guid? ProductId { get; set; }
    public Product Product { get; set; }
    public string PreviewResourcePath { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
    public ICollection<TwinObjectBinding> Bindings { get; set; } = new List<TwinObjectBinding>();
}
