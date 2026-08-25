using IoTSharp.Contracts;
using System;

namespace IoTSharp.Data;

/// <summary>
/// 图片到三维模型的持久化生成任务。输入、进度和最终模型资源均受租户隔离。
/// </summary>
public class TwinModelGenerationJob : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string JobKey { get; set; }
    public string Name { get; set; }
    public string Provider { get; set; } = "Img2ThreeJs";
    public string Prompt { get; set; }
    public string QualityProfile { get; set; } = "Production";
    public bool AnimationReady { get; set; } = true;
    public string LicenseType { get; set; } = "Proprietary-Generated";
    public bool CommercialUseAllowed { get; set; }
    public string ReferenceImagePath { get; set; }
    public string ReferenceImageName { get; set; }
    public string ReferenceImageContentType { get; set; }
    public long ReferenceImageSize { get; set; }
    public TwinModelGenerationStatus Status { get; set; } = TwinModelGenerationStatus.WaitingForWorker;
    public int Progress { get; set; }
    public string Stage { get; set; }
    public string ProviderJobId { get; set; }
    public string ProviderMetadata { get; set; }
    public string ErrorMessage { get; set; }
    public int AttemptCount { get; set; }
    public Guid? ResultModelResourceId { get; set; }
    public TwinModelResource ResultModelResource { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public Guid CreatedByUserId { get; set; }
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
}
