using System;

namespace IoTSharp.Data;

public enum TwinActionFlowRunStatus { Created, Ready, Running, WaitingSignal, WaitingResource, Paused, Recovering, Completed, Faulted, Cancelled }
public enum TwinActionFlowStepStatus { Pending, Ready, Running, Waiting, Succeeded, Failed, Compensating, Compensated, Skipped }
public enum TwinDeviceCommandStatus { Pending, Sent, Acknowledged, Busy, Completed, Faulted, Cancelled }
public enum TwinReservationStatus { Active, Released, Expired, Cancelled }
public enum TwinMaterialRuntimeStatus { Reserved, InTransit, Placed, Blocked, Unknown }

/// <summary>Action Flow V2 草稿/发布定义投影。完整定义仍原子保存在场景 Manifest。</summary>
public sealed class TwinActionFlow : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid SceneId { get; set; }
    public DigitalTwinScene Scene { get; set; }
    public Guid? SceneVersionId { get; set; }
    public DigitalTwinSceneVersion SceneVersion { get; set; }
    public string FlowKey { get; set; }
    public string Name { get; set; }
    public string ContractVersion { get; set; } = "2.0";
    public string ActorScope { get; set; } = "[]";
    public string GraphPayload { get; set; }
    public string GraphHash { get; set; }
    public string CompiledPayload { get; set; }
    public string CompiledPlanHash { get; set; }
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
