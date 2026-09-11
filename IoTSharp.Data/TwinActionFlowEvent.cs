using System;

namespace IoTSharp.Data;

/// <summary>不可变、仅追加的 Action Flow 运行事件。</summary>
public sealed class TwinActionFlowEvent : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RunId { get; set; }
    public TwinActionFlowRun Run { get; set; }
    public long Sequence { get; set; }
    public string EventType { get; set; }
    public string NodeId { get; set; }
    public string StepInstanceId { get; set; }
    public string CorrelationId { get; set; }
    public string Source { get; set; }
    public string Payload { get; set; } = "{}";
    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool Deleted { get; set; }
    public Guid? TenantId { get; set; }
    public Tenant Tenant { get; set; }
    public Guid? CustomerId { get; set; }
    public Customer Customer { get; set; }
}
