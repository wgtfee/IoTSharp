using IoTSharp.Data;
using IoTSharp.EventBus;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace IoTSharp.Services.TelemetryIngest;

public sealed class TelemetryIngestOptions
{
    public const string SectionName = "TelemetryIngest";
    public int PartitionCount { get; set; } = Math.Clamp(Environment.ProcessorCount, 2, 16);
    public int CapacityPerPartition { get; set; } = 4096;
    public int BatchSize { get; set; } = 256;
    public int FlushIntervalMilliseconds { get; set; } = 50;
    public int RetryDelayMilliseconds { get; set; } = 250;
}

public sealed record TelemetryIngestSnapshot(
    long QueueDepth,
    long Capacity,
    long PendingWriters,
    long EnqueuedMessages,
    long PublishedMessages,
    long PublishedBatches,
    long PublishFailures,
    long BackpressureWaits);

/// <summary>
/// 有界遥测接入管道。相同 DeviceId 始终进入同一单读者分区，从而保持设备内顺序。
/// </summary>
public sealed class TelemetryIngestPipeline : BackgroundService
{
    private static readonly Meter Meter = new("IoTSharp.Telemetry", "1.0.0");
    private static readonly Counter<long> EnqueuedCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.ingest.enqueued_messages", "messages");
    private static readonly Counter<long> PublishedCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.ingest.published_messages", "messages");
    private static readonly Counter<long> PublishedBatchCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.ingest.published_batches", "batches");
    private static readonly Counter<long> PublishFailureCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.ingest.publish_failures", "batches");
    private static readonly Counter<long> BackpressureCounter = Meter.CreateCounter<long>(
        "iotsharp.telemetry.ingest.backpressure_waits", "waits");
    private static readonly Histogram<long> BatchSizeHistogram = Meter.CreateHistogram<long>(
        "iotsharp.telemetry.ingest.batch_size", "messages");
    private readonly IPublisher _publisher;
    private readonly ILogger<TelemetryIngestPipeline> _logger;
    private readonly TelemetryIngestOptions _options;
    private readonly Channel<PlayloadData>[] _partitions;
    private readonly long _totalCapacity;
    private readonly CancellationTokenSource _drainCancellationSource = new();
    private int _stopping;
    private long _pendingWriters;
    private long _enqueuedMessages;
    private long _publishedMessages;
    private long _publishedBatches;
    private long _publishFailures;
    private long _backpressureWaits;

    public TelemetryIngestPipeline(
        IPublisher publisher,
        IOptions<TelemetryIngestOptions> options,
        ILogger<TelemetryIngestPipeline> logger)
    {
        _publisher = publisher;
        _logger = logger;
        _options = Normalize(options.Value);
        _partitions = Enumerable.Range(0, _options.PartitionCount)
            .Select(_ => Channel.CreateBounded<PlayloadData>(new BoundedChannelOptions(_options.CapacityPerPartition)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = true,
                SingleWriter = false,
                AllowSynchronousContinuations = false
            }))
            .ToArray();
        _totalCapacity = (long)_options.PartitionCount * _options.CapacityPerPartition;
    }

    public async ValueTask EnqueueAsync(PlayloadData message, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);
        if (Volatile.Read(ref _stopping) != 0)
            return;

        // Measure platform-internal lag with server time so historical device timestamps do not trigger throttling.
        if (message.ServerIngestedAtUtc == default)
            message.ServerIngestedAtUtc = DateTime.UtcNow;

        var channel = _partitions[GetPartition(message.DeviceId)];
        if (!channel.Writer.TryWrite(message))
        {
            Interlocked.Increment(ref _backpressureWaits);
            BackpressureCounter.Add(1);
            Interlocked.Increment(ref _pendingWriters);
            try
            {
                await channel.Writer.WriteAsync(message, cancellationToken);
            }
            catch (ChannelClosedException) when (Volatile.Read(ref _stopping) != 0)
            {
                return;
            }
            finally
            {
                Interlocked.Decrement(ref _pendingWriters);
            }
        }

        Interlocked.Increment(ref _enqueuedMessages);
        EnqueuedCounter.Add(1);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref _stopping, 1);
        foreach (var partition in _partitions)
            partition.Writer.TryComplete();

        using var registration = cancellationToken.Register(static state =>
        {
            ((CancellationTokenSource)state!).Cancel();
        }, _drainCancellationSource);

        await base.StopAsync(cancellationToken);
    }

    public TelemetryIngestSnapshot GetSnapshot() => new(
        GetQueuedCount(),
        _totalCapacity,
        Interlocked.Read(ref _pendingWriters),
        Interlocked.Read(ref _enqueuedMessages),
        Interlocked.Read(ref _publishedMessages),
        Interlocked.Read(ref _publishedBatches),
        Interlocked.Read(ref _publishFailures),
        Interlocked.Read(ref _backpressureWaits));

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _ = stoppingToken;
        var drainToken = _drainCancellationSource.Token;
        return Task.WhenAll(_partitions.Select((partition, index) => RunPartitionAsync(index, partition.Reader, drainToken)));
    }

    private async Task RunPartitionAsync(
        int partitionIndex,
        ChannelReader<PlayloadData> reader,
        CancellationToken drainToken)
    {
        var batch = new List<PlayloadData>(_options.BatchSize);
        var timestampSequencer = new TelemetryTimestampSequencer();
        try
        {
            while (await reader.WaitToReadAsync(drainToken))
            {
                batch.Clear();
                if (!reader.TryRead(out var first))
                    continue;

                first.ts = timestampSequencer.Normalize(first.DeviceId, first.ts);
                batch.Add(first);
                var deadline = DateTime.UtcNow.AddMilliseconds(_options.FlushIntervalMilliseconds);

                while (batch.Count < _options.BatchSize)
                {
                    while (batch.Count < _options.BatchSize && reader.TryRead(out var next))
                    {
                        next.ts = timestampSequencer.Normalize(next.DeviceId, next.ts);
                        batch.Add(next);
                    }

                    if (batch.Count >= _options.BatchSize)
                        break;

                    var remaining = deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero)
                        break;

                    var waitToRead = reader.WaitToReadAsync(drainToken).AsTask();
                    var delay = Task.Delay(remaining, drainToken);
                    var completed = await Task.WhenAny(waitToRead, delay);
                    if (completed == delay || !await waitToRead)
                        break;
                }

                // PublishWithRetryAsync is awaited before this list is cleared/reused, so passing the
                // existing buffer avoids allocating and copying one PlayloadData[] for every batch.
                await PublishWithRetryAsync(partitionIndex, batch, drainToken);
            }
        }
        catch (OperationCanceledException) when (drainToken.IsCancellationRequested)
        {
            _logger.LogWarning("Telemetry ingest drain was cancelled before partition {Partition} was fully published.", partitionIndex);
        }
    }

    public override void Dispose()
    {
        _drainCancellationSource.Cancel();
        _drainCancellationSource.Dispose();
        base.Dispose();
    }

    private async Task PublishWithRetryAsync(
        int partitionIndex,
        IReadOnlyCollection<PlayloadData> batch,
        CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _publisher.PublishTelemetryDataBatch(batch);
                Interlocked.Add(ref _publishedMessages, batch.Count);
                Interlocked.Increment(ref _publishedBatches);
                PublishedCounter.Add(batch.Count);
                PublishedBatchCounter.Add(1);
                BatchSizeHistogram.Record(batch.Count);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref _publishFailures);
                PublishFailureCounter.Add(1);
                _logger.LogWarning(
                    ex,
                    "Telemetry ingest batch publish failed. partition={Partition}, count={Count}; retrying.",
                    partitionIndex,
                    batch.Count);
                await Task.Delay(_options.RetryDelayMilliseconds, stoppingToken);
            }
        }
    }

    private int GetPartition(Guid deviceId)
        => (deviceId.GetHashCode() & int.MaxValue) % _partitions.Length;

    private long GetQueuedCount()
    {
        long count = 0;
        foreach (var partition in _partitions)
        {
            if (partition.Reader.CanCount)
                count += partition.Reader.Count;
        }
        return count;
    }

    private static TelemetryIngestOptions Normalize(TelemetryIngestOptions source) => new()
    {
        PartitionCount = Math.Clamp(source.PartitionCount, 1, 64),
        CapacityPerPartition = Math.Max(1, source.CapacityPerPartition),
        BatchSize = Math.Max(1, source.BatchSize),
        FlushIntervalMilliseconds = Math.Max(1, source.FlushIntervalMilliseconds),
        RetryDelayMilliseconds = Math.Max(1, source.RetryDelayMilliseconds)
    };
}

/// <summary>
/// 为单个遥测接入分区中的设备生成严格递增的存储时间戳。
/// 同一 DeviceId 固定进入同一个单读者分区，因此这里不需要额外加锁。
/// SQL Server datetime2(7) 可以保存 100ns tick，用最小增量即可避免
/// (DeviceId, KeyName, DateTime) 在高频批量写入时发生主键冲突。
/// </summary>
internal sealed class TelemetryTimestampSequencer
{
    private readonly Dictionary<Guid, long> _lastTicksByDevice = new();

    public DateTime Normalize(Guid deviceId, DateTime timestamp)
    {
        var requestedTicks = timestamp.Ticks;
        if (!_lastTicksByDevice.TryGetValue(deviceId, out var lastTicks) || requestedTicks > lastTicks)
        {
            _lastTicksByDevice[deviceId] = requestedTicks;
            return timestamp;
        }

        if (lastTicks >= DateTime.MaxValue.Ticks)
            throw new InvalidOperationException($"Telemetry timestamp overflow for device {deviceId}.");

        var normalizedTicks = lastTicks + 1;
        _lastTicksByDevice[deviceId] = normalizedTicks;
        return new DateTime(normalizedTicks, timestamp.Kind);
    }
}
