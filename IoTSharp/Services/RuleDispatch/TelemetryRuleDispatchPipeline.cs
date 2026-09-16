using IoTSharp.Contracts;
using IoTSharp.EventBus;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace IoTSharp.Services.RuleDispatch;

public sealed class TelemetryRuleDispatchOptions
{
    public const string SectionName = "TelemetryRuleDispatch";

    public int PartitionCount { get; set; } = Math.Clamp(Environment.ProcessorCount, 2, 16);
    public int CapacityPerPartition { get; set; } = 2048;
}

public sealed record TelemetryRuleDispatchSnapshot(
    long QueueDepth,
    long Capacity,
    long PendingWriters,
    long Enqueued,
    long Processed,
    long Failed,
    long BackpressureWaits);

internal readonly record struct TelemetryRuleWorkItem(Guid DeviceId, object? Telemetry, object? TelemetryArray);

public sealed class TelemetryRuleDispatchPipeline : BackgroundService
{
    private readonly EventBusOption _eventBusOption;
    private readonly ILogger<TelemetryRuleDispatchPipeline> _logger;
    private readonly Channel<TelemetryRuleWorkItem>[] _partitions;
    private readonly long _totalCapacity;
    private readonly CancellationTokenSource _drainCancellationSource = new();
    private int _stopping;
    private long _pendingWriters;
    private long _enqueued;
    private long _processed;
    private long _failed;
    private long _backpressureWaits;

    public TelemetryRuleDispatchPipeline(
        EventBusOption eventBusOption,
        IOptions<TelemetryRuleDispatchOptions> options,
        ILogger<TelemetryRuleDispatchPipeline> logger)
    {
        _eventBusOption = eventBusOption;
        _logger = logger;
        var configured = options.Value;
        var partitionCount = Math.Clamp(configured.PartitionCount, 1, 64);
        var capacity = Math.Max(1, configured.CapacityPerPartition);
        _partitions = Enumerable.Range(0, partitionCount)
            .Select(_ => Channel.CreateBounded<TelemetryRuleWorkItem>(new BoundedChannelOptions(capacity)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = true,
                SingleWriter = false,
                AllowSynchronousContinuations = false
            }))
            .ToArray();
        _totalCapacity = (long)partitionCount * capacity;
    }

    public async Task EnqueueAsync(Guid deviceId, object? telemetry, object? telemetryArray)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return;

        var workItem = new TelemetryRuleWorkItem(deviceId, telemetry, telemetryArray);
        var channel = _partitions[GetPartition(deviceId)];
        if (!channel.Writer.TryWrite(workItem))
        {
            Interlocked.Increment(ref _backpressureWaits);
            Interlocked.Increment(ref _pendingWriters);
            try
            {
                await channel.Writer.WriteAsync(workItem);
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
        Interlocked.Increment(ref _enqueued);
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

    public TelemetryRuleDispatchSnapshot GetSnapshot() => new(
        GetQueuedCount(),
        _totalCapacity,
        Interlocked.Read(ref _pendingWriters),
        Interlocked.Read(ref _enqueued),
        Interlocked.Read(ref _processed),
        Interlocked.Read(ref _failed),
        Interlocked.Read(ref _backpressureWaits));

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _ = stoppingToken;
        var drainToken = _drainCancellationSource.Token;
        return Task.WhenAll(_partitions.Select((partition, index) => RunPartitionAsync(index, partition.Reader, drainToken)));
    }

    private async Task RunPartitionAsync(int partitionIndex, ChannelReader<TelemetryRuleWorkItem> reader, CancellationToken drainToken)
    {
        try
        {
            await foreach (var item in reader.ReadAllAsync(drainToken))
            {
                try
                {
                    if (item.Telemetry != null)
                    {
                        await _eventBusOption.RunRules(item.DeviceId, item.Telemetry, EventType.Telemetry);
                    }
                    if (item.TelemetryArray != null)
                    {
                        await _eventBusOption.RunRules(item.DeviceId, item.TelemetryArray, EventType.TelemetryArray);
                    }
                    Interlocked.Increment(ref _processed);
                }
                catch (OperationCanceledException) when (drainToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref _failed);
                    _logger.LogError(ex, "Telemetry rule dispatch failed. DeviceId={DeviceId}", item.DeviceId);
                }
            }
        }
        catch (OperationCanceledException) when (drainToken.IsCancellationRequested)
        {
            _logger.LogWarning("Telemetry rule dispatch drain was cancelled before partition {Partition} was fully processed.", partitionIndex);
        }
    }

    public override void Dispose()
    {
        _drainCancellationSource.Cancel();
        _drainCancellationSource.Dispose();
        base.Dispose();
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
}
