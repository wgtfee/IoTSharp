using System;

namespace IoTSharp.Data;

/// <summary>
/// Durable idempotency receipt for a reliable event received from a gateway.
/// </summary>
public sealed class ReliableEventReceipt
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid GatewayId { get; set; }
    public string EventId { get; set; } = string.Empty;
    public string EventType { get; set; } = string.Empty;
    public Guid DeviceId { get; set; }
    public DateTime OccurredAt { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
    public string PayloadHash { get; set; } = string.Empty;
    public string Payload { get; set; } = string.Empty;
    public string Status { get; set; } = ReliableEventReceiptStatuses.Processing;
    public DateTime? ProcessedAt { get; set; }
    public string LastError { get; set; }
}

public static class ReliableEventReceiptStatuses
{
    public const string Processing = "Processing";
    public const string Completed = "Completed";
    public const string Failed = "Failed";
}
