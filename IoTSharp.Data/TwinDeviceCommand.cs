using System;

namespace IoTSharp.Data;

/// <summary>服务端向 PLC/WCS/机器人适配器发出的幂等设备命令记录。</summary>
public sealed class TwinDeviceCommand : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RunId { get; set; }
    public TwinActionFlowRun Run { get; set; }
    public Guid? StepId { get; set; }
    public TwinActionFlowRunStep Step { get; set; }
    public string CommandId { get; set; }
    public string CorrelationId { get; set; }
    public string BindingKey { get; set; }
    public string Payload { get; set; } = "{}";
    public string PayloadHash { get; set; }
    public TwinDeviceCommandStatus Status { get; set; } = TwinDeviceCommandStatus.Pending;
    public string DeviceCycleId { get; set; }
    public string LastError { get; set; }
    public DateTime? SentAt { get; set; }
    public DateTime? AcknowledgedAt { get; set; }
    public DateTime? BusyAt { get; set; }
    public DateTime? CompletedAt { get; set; }
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
