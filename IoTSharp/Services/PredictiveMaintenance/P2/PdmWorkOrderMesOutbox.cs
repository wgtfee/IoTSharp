using System;
using System.Text.Json;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// One durable MES dispatch for each human-authorized work-order transition.
/// Committed in the same SQL transaction as order state and audit.
/// Never shares the alarm episode's ordered stream; the order has its own stream.
/// </summary>
public sealed class PdmWorkOrderMesOutbox
{
    public Guid EventId { get; set; } = Guid.NewGuid();
    public Guid WorkOrderId { get; set; }
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public string EventType { get; set; } = "";
    public int SourceSequence { get; set; }
    public string PayloadJson { get; set; } = "";
    public string DeliveryStatus { get; set; } = "Pending";
    public int AttemptCount { get; set; }
    public DateTime NextAttemptAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? DeliveredAtUtc { get; set; }
    public string? LastErrorCode { get; set; }
}

public static class PdmWorkOrderMesProjector
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>Invoke before SaveChanges in the existing work-order transaction.</summary>
    public static void Append(PdmInternalWorkOrderDbContext db,
        PdmInternalWorkOrder order, string action, Guid actor, DateTime atUtc)
    {
        if (action is not ("Complete" or "Close"))
            throw new ArgumentOutOfRangeException(nameof(action));
        if (order.TenantId == Guid.Empty || order.CustomerId == Guid.Empty ||
            order.DeviceId == Guid.Empty || order.ProfileId == Guid.Empty ||
            order.Id == Guid.Empty || actor == Guid.Empty ||
            order.RiskEventId == Guid.Empty ||
            string.IsNullOrWhiteSpace(order.RiskSourceEventKey) ||
            order.RiskSourceEventKey.Length > 128 ||
            order.ProfileVersion < 1 || order.WorkOrderNo.Length > 40 ||
            atUtc.Kind != DateTimeKind.Utc || string.IsNullOrWhiteSpace(order.Resolution) ||
            order.Resolution.Length > 2000)
            throw new InvalidOperationException("Cannot publish an invalid maintenance completion.");
        if (action == "Complete" &&
            (order.State != "Completed" || order.CompletedAtUtc is null))
            throw new InvalidOperationException("MES completion requires a genuine Completed transition.");
        if (action == "Close" &&
            (order.State != "Closed" || order.CompletedAtUtc is null || order.ClosedAtUtc is null))
            throw new InvalidOperationException("MES closure requires a completed maintenance order.");

        var type = action == "Complete" ? "WORKORDER_COMPLETED" : "WORKORDER_CLOSED";
        var sequence = action == "Complete" ? 1 : 2;
        var id = Guid.NewGuid();
        var summary = action == "Complete"
            ? "维修人员已完成工单 " + order.WorkOrderNo + " 的维修处理，需按工单流程确认"
            : "维修工单 " + order.WorkOrderNo + " 已由授权人员关闭";
        var synthetic = order.Description.StartsWith("[DEV联调模拟]",
            StringComparison.Ordinal);
        if (synthetic) summary = "[DEV联调模拟] " + summary;
        var payload = new
        {
            schemaVersion = "1.0",
            eventId = id, sourceSystem = "IoTSharp",
            sourceEventKey = "workorder:" + order.Id.ToString("N"),
            sourceSequence = sequence,
            tenantId = order.TenantId, customerId = order.CustomerId,
            deviceId = order.DeviceId, profileId = order.ProfileId,
            profileVersion = order.ProfileVersion,
            eventType = type, riskLevel = order.RiskLevel,
            occurredAtUtc = new DateTimeOffset(atUtc),
            windowEndUtc = new DateTimeOffset(atUtc),
            dataQuality = "Good", summary, isSynthetic = synthetic,
            correlationId = "pdm-wo:" + id.ToString("N"),
            evidenceRef = "/pdm/workorders/" + order.Id.ToString("N"),
            workOrderId = order.Id,
            workOrderNo = order.WorkOrderNo,
            workOrderState = order.State,
            workOrderRevision = order.Revision,
            riskSourceEventKey = order.RiskSourceEventKey,
            riskEventId = order.RiskEventId,
            resolution = order.Resolution,
            handledBy = actor,
            completedAtUtc = order.CompletedAtUtc,
            closedAtUtc = order.ClosedAtUtc
        };
        db.MesOutbox.Add(new PdmWorkOrderMesOutbox
        {
            EventId = id, WorkOrderId = order.Id,
            TenantId = order.TenantId, CustomerId = order.CustomerId,
            EventType = type, SourceSequence = sequence,
            PayloadJson = JsonSerializer.Serialize(payload),
            CreatedAtUtc = atUtc, NextAttemptAtUtc = atUtc
        });
    }
}
