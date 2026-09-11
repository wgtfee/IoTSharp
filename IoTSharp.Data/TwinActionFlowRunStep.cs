using System;

namespace IoTSharp.Data;

public sealed class TwinActionFlowRunStep : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RunId { get; set; }
    public TwinActionFlowRun Run { get; set; }
    public string StepInstanceId { get; set; }
    public string NodeId { get; set; }
    public int Attempt { get; set; } = 1;
    public TwinActionFlowStepStatus Status { get; set; } = TwinActionFlowStepStatus.Pending;
    public string InputPayload { get; set; } = "{}";
    public string OutputPayload { get; set; } = "{}";
    public string ErrorCode { get; set; }
    public string ErrorMessage { get; set; }
    public DateTime? DeadlineAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long LastSequence { get; set; }
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
