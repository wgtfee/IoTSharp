using IoTSharp.Data;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Threading;

namespace IoTSharp.EventBus;

/// <summary>
/// Snapshot of telemetry persistence pressure measured with IoTSharp server-ingest time.
/// </summary>
public sealed record TelemetryPersistenceSnapshot(
    double LagSeconds,
    double LastBatchDurationMilliseconds,
    int InFlightBatches,
    long CompletedBatches,
    long FailedBatches,
    int DurablePendingBatches,
    long DurablePendingRows,
    long RetriedBatches,
    long SpooledRows,
    long DrainedRows);

/// <summary>
/// Tracks EventBus-to-storage lag without changing CAP consumer concurrency or per-device ordering.
/// </summary>
public sealed class TelemetryPersistenceMonitor
{
    private static readonly TimeSpan CompletedLagHold = TimeSpan.FromSeconds(10);
    private static readonly Meter Meter = new("IoTSharp.Telemetry", "1.0.0");
    private static readonly Counter<long> CompletedBatchCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.persistence.completed_batches",
        unit: "batches",
        description: "Telemetry persistence batches completed successfully.");
    private static readonly Counter<long> FailedBatchCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.persistence.failed_batches",
        unit: "batches",
        description: "Telemetry persistence batches that failed.");
    private static readonly Histogram<double> BatchDurationHistogram = Meter.CreateHistogram<double>(
        "iotsharp.telemetry.persistence.batch_duration",
        unit: "ms",
        description: "End-to-end telemetry persistence batch duration.");
    private static readonly Histogram<double> PersistenceLagHistogram = Meter.CreateHistogram<double>(
        "iotsharp.telemetry.persistence.lag",
        unit: "s",
        description: "Server-ingest to persistence lag.");
    private static readonly Counter<long> SpoolEnqueuedRowsCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.spool.enqueued_rows",
        unit: "rows",
        description: "Materialized telemetry History rows durably enqueued.");
    private static readonly Counter<long> SpoolDeduplicatedBatchCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.spool.deduplicated_batches",
        unit: "batches",
        description: "Durable History batches suppressed as duplicates.");
    private static readonly Counter<long> SpoolRetryCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.spool.retry_batches",
        unit: "batches",
        description: "Durable History batches retried after provider failure.");
    private static readonly Counter<long> SpoolDrainedRowsCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.spool.drained_rows",
        unit: "rows",
        description: "Durable History rows successfully drained to the active provider.");
    private static readonly Histogram<double> SpoolDrainDurationHistogram = Meter.CreateHistogram<double>(
        "iotsharp.telemetry.spool.drain_duration",
        unit: "ms",
        description: "Duration of one durable History provider drain.");
    private static readonly UpDownCounter<long> SpoolPendingBatchGauge = Meter.CreateUpDownCounter<long>(
        "iotsharp.telemetry.spool.pending_batches",
        unit: "batches",
        description: "Current durable History backlog batch count.");
    private static readonly UpDownCounter<long> SpoolPendingRowGauge = Meter.CreateUpDownCounter<long>(
        "iotsharp.telemetry.spool.pending_rows",
        unit: "rows",
        description: "Current durable History backlog row count.");
    private readonly ConcurrentDictionary<long, long> _inFlightOldestTicks = new();
    private long _nextBatchId;
    private long _lastCompletedAtTicks;
    private long _lastCompletedLagMilliseconds;
    private long _lastBatchDurationMilliseconds;
    private long _completedBatches;
    private long _failedBatches;
    private long _durableOldestTicks;
    private int _durablePendingBatches;
    private long _durablePendingRows;
    private long _retriedBatches;
    private long _spooledRows;
    private long _drainedRows;

    public void UpdateDurableBacklog(int pendingBatches, long pendingRows, DateTime? oldestPendingUtc)
    {
        var count = Math.Max(0, pendingBatches);
        var rows = Math.Max(0L, pendingRows);
        var previousBatches = Interlocked.Exchange(ref _durablePendingBatches, count);
        var previousRows = Interlocked.Exchange(ref _durablePendingRows, rows);
        SpoolPendingBatchGauge.Add(count - previousBatches);
        SpoolPendingRowGauge.Add(rows - previousRows);
        var ticks = count > 0 && oldestPendingUtc.HasValue
            ? (oldestPendingUtc.Value.Kind == DateTimeKind.Utc ? oldestPendingUtc.Value : oldestPendingUtc.Value.ToUniversalTime()).Ticks
            : 0L;
        Interlocked.Exchange(ref _durableOldestTicks, ticks);
    }

    public void RecordSpoolEnqueue(int rowCount, bool deduplicated)
    {
        if (deduplicated)
        {
            SpoolDeduplicatedBatchCounter.Add(1);
            return;
        }

        var rows = Math.Max(0, rowCount);
        Interlocked.Add(ref _spooledRows, rows);
        SpoolEnqueuedRowsCounter.Add(rows);
    }

    public void RecordDurableRetry(int rowCount)
    {
        Interlocked.Increment(ref _retriedBatches);
        SpoolRetryCounter.Add(1);
    }

    public void RecordDurableDrainSuccess(int rowCount, TimeSpan duration)
    {
        var rows = Math.Max(0, rowCount);
        Interlocked.Add(ref _drainedRows, rows);
        SpoolDrainedRowsCounter.Add(rows);
        SpoolDrainDurationHistogram.Record(Math.Max(0d, duration.TotalMilliseconds));
    }

    /// <summary>Starts tracking one storage batch.</summary>
    public TelemetryPersistenceLease BeginBatch(IReadOnlyCollection<PlayloadData> messages)
    {
        ArgumentNullException.ThrowIfNull(messages);
        var now = DateTime.UtcNow;
        var oldest = now;
        var foundServerTimestamp = false;
        foreach (var message in messages)
        {
            var timestamp = NormalizeServerIngestedAt(message.ServerIngestedAtUtc, now);
            if (!foundServerTimestamp || timestamp < oldest)
            {
                oldest = timestamp;
                foundServerTimestamp = true;
            }
        }

        var id = Interlocked.Increment(ref _nextBatchId);
        _inFlightOldestTicks[id] = oldest.Ticks;
        return new TelemetryPersistenceLease(this, id, oldest, Stopwatch.GetTimestamp());
    }

    /// <summary>Returns current persistence lag and recent batch metrics.</summary>
    public TelemetryPersistenceSnapshot GetSnapshot()
    {
        var now = DateTime.UtcNow;
        long oldestTicks = 0;
        foreach (var ticks in _inFlightOldestTicks.Values)
        {
            if (oldestTicks == 0 || ticks < oldestTicks)
                oldestTicks = ticks;
        }

        var inFlightLagMilliseconds = oldestTicks == 0
            ? 0L
            : Math.Max(0L, (long)(now - new DateTime(oldestTicks, DateTimeKind.Utc)).TotalMilliseconds);

        var completedAtTicks = Interlocked.Read(ref _lastCompletedAtTicks);
        var completedLagMilliseconds = completedAtTicks != 0
            && now - new DateTime(completedAtTicks, DateTimeKind.Utc) <= CompletedLagHold
                ? Math.Max(0L, Interlocked.Read(ref _lastCompletedLagMilliseconds))
                : 0L;

        var durableOldestTicks = Interlocked.Read(ref _durableOldestTicks);
        var durableLagMilliseconds = durableOldestTicks == 0
            ? 0L
            : Math.Max(0L, (long)(now - new DateTime(durableOldestTicks, DateTimeKind.Utc)).TotalMilliseconds);
        var durablePending = Math.Max(0, Volatile.Read(ref _durablePendingBatches));
        var trackedBatches = (long)_inFlightOldestTicks.Count + durablePending;

        return new TelemetryPersistenceSnapshot(
            Math.Max(Math.Max(inFlightLagMilliseconds, completedLagMilliseconds), durableLagMilliseconds) / 1000d,
            Math.Max(0L, Interlocked.Read(ref _lastBatchDurationMilliseconds)),
            trackedBatches > int.MaxValue ? int.MaxValue : (int)trackedBatches,
            Interlocked.Read(ref _completedBatches),
            Interlocked.Read(ref _failedBatches),
            durablePending,
            Math.Max(0L, Interlocked.Read(ref _durablePendingRows)),
            Interlocked.Read(ref _retriedBatches),
            Interlocked.Read(ref _spooledRows),
            Interlocked.Read(ref _drainedRows));
    }

    private static DateTime NormalizeServerIngestedAt(DateTime value, DateTime fallbackUtc)
    {
        if (value == default || value == DateTime.MinValue || value > fallbackUtc.AddMinutes(1))
            return fallbackUtc;
        return value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
    }

    private void Finish(long id, DateTime oldestServerIngestedAtUtc, long startedTimestamp, bool success)
    {
        _inFlightOldestTicks.TryRemove(id, out _);
        var now = DateTime.UtcNow;
        var lagMilliseconds = Math.Max(0L, (long)(now - oldestServerIngestedAtUtc).TotalMilliseconds);
        var durationMilliseconds = Math.Max(0L, (long)Stopwatch.GetElapsedTime(startedTimestamp).TotalMilliseconds);
        Interlocked.Exchange(ref _lastCompletedAtTicks, now.Ticks);
        Interlocked.Exchange(ref _lastCompletedLagMilliseconds, lagMilliseconds);
        Interlocked.Exchange(ref _lastBatchDurationMilliseconds, durationMilliseconds);
        BatchDurationHistogram.Record(durationMilliseconds);
        PersistenceLagHistogram.Record(lagMilliseconds / 1000d);
        if (success)
        {
            Interlocked.Increment(ref _completedBatches);
            CompletedBatchCounter.Add(1);
        }
        else
        {
            Interlocked.Increment(ref _failedBatches);
            FailedBatchCounter.Add(1);
        }
    }

    /// <summary>Lightweight lease representing one in-flight persistence batch.</summary>
    public sealed class TelemetryPersistenceLease
    {
        private readonly TelemetryPersistenceMonitor _owner;
        private readonly long _id;
        private readonly DateTime _oldestServerIngestedAtUtc;
        private readonly long _startedTimestamp;
        private int _completed;

        internal TelemetryPersistenceLease(
            TelemetryPersistenceMonitor owner,
            long id,
            DateTime oldestServerIngestedAtUtc,
            long startedTimestamp)
        {
            _owner = owner;
            _id = id;
            _oldestServerIngestedAtUtc = oldestServerIngestedAtUtc;
            _startedTimestamp = startedTimestamp;
        }

        public void Complete() => Finish(true);
        public void Fail() => Finish(false);

        private void Finish(bool success)
        {
            if (Interlocked.Exchange(ref _completed, 1) != 0)
                return;
            _owner.Finish(_id, _oldestServerIngestedAtUtc, _startedTimestamp, success);
        }
    }
}
