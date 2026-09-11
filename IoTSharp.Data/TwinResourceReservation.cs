using System;

namespace IoTSharp.Data;

/// <summary>Actor、Slot、RouteSection、Material 四类生产资源的带租约预留。</summary>
public sealed class TwinResourceReservation : IJustMy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ReservationId { get; set; }
    public string ResourceType { get; set; }
    public string ResourceId { get; set; }
    public Guid OwnerRunId { get; set; }
    public TwinActionFlowRun OwnerRun { get; set; }
    public Guid? OwnerStepId { get; set; }
    public TwinActionFlowRunStep OwnerStep { get; set; }
    public TwinReservationStatus Status { get; set; } = TwinReservationStatus.Active;
    public DateTime LeaseUntil { get; set; }
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
}
