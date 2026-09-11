using System;
using System.Collections.Generic;

namespace IoTSharp.Data;

/// <summary>一次基于不可变发布流程版本创建的运行实例。</summary>
public sealed class TwinActionFlowRun : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public Guid SceneVersionId { get; set; }
    public DigitalTwinSceneVersion SceneVersion { get; set; }
    public Guid ActionFlowId { get; set; }
    public TwinActionFlow ActionFlow { get; set; }
    public string IdempotencyKey { get; set; }
    public TwinActionFlowRunStatus Status { get; set; } = TwinActionFlowRunStatus.Created;
    public string InputPayload { get; set; } = "{}";
    public string RuntimePayload { get; set; } = "{}";
    public long CurrentSequence { get; set; }
    public long ConcurrencyVersion { get; set; } = 1;
    public string GraphHash { get; set; }
    public string CompiledPlanHash { get; set; }
    public string FaultCode { get; set; }
    public string FaultMessage { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
    public ICollection<TwinActionFlowRunStep> Steps { get; set; } = new List<TwinActionFlowRunStep>();
    public ICollection<TwinActionFlowEvent> Events { get; set; } = new List<TwinActionFlowEvent>();
}
