using IoTSharp.Contracts;
using IoTSharp.Data;

namespace IoTSharp.EventBus;

/// <summary>
/// Provider-neutral durable boundary for telemetry History batches.
/// The queue owns durability and recovery only; provider persistence is handled by a dispatcher.
/// </summary>
public interface IDurableTelemetryHistoryQueue
{
    Task<TelemetryHistorySpoolEnqueueResult> EnqueueAsync(
        IReadOnlyCollection<PlayloadData> messages,
        CancellationToken cancellationToken = default);

    Task<DurableTelemetryHistoryQueueItem?> PeekOldestAsync(CancellationToken cancellationToken = default);

    Task AckAsync(DurableTelemetryHistoryQueueItem item, CancellationToken cancellationToken = default);

    Task NackAsync(DurableTelemetryHistoryQueueItem item, CancellationToken cancellationToken = default);

    DurableTelemetryHistoryBacklogSnapshot GetBacklogSnapshot();

    Task RecoverAsync(CancellationToken cancellationToken = default);

    Task WaitForDataAsync(TimeSpan timeout, CancellationToken cancellationToken = default);
}

public sealed record DurableTelemetryHistoryQueueItem(
    string Token,
    int MessageCount,
    DateTime OldestServerIngestedAtUtc,
    IReadOnlyList<TelemetryData> Rows);

public sealed record DurableTelemetryHistoryBacklogSnapshot(
    int PendingBatches,
    long PendingRows,
    DateTime? OldestServerIngestedAtUtc);
