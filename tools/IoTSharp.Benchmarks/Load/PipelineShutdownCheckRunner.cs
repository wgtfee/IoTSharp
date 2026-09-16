using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Services.RuleDispatch;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Benchmarks.Load;

internal static class PipelineShutdownCheckRunner
{
    private const int ItemCount = 64;

    public static async Task<int> RunAsync()
    {
        await VerifyIngestDrainAsync();
        await VerifyRuleDispatchDrainAsync();
        Console.WriteLine("PIPELINE_SHUTDOWN_CHECK_OK");
        return 0;
    }

    private static async Task VerifyIngestDrainAsync()
    {
        var publisher = new CountingPublisher();
        using var pipeline = new TelemetryIngestPipeline(
            publisher,
            Options.Create(new TelemetryIngestOptions
            {
                PartitionCount = 1,
                CapacityPerPartition = 128,
                BatchSize = 256,
                FlushIntervalMilliseconds = 5_000,
                RetryDelayMilliseconds = 1
            }),
            NullLogger<TelemetryIngestPipeline>.Instance);

        await pipeline.StartAsync(CancellationToken.None);
        var deviceId = Guid.NewGuid();
        for (var i = 0; i < ItemCount; i++)
            await pipeline.EnqueueAsync(Message(deviceId, i));

        using (var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            await pipeline.StopAsync(stopCts.Token);

        var snapshot = pipeline.GetSnapshot();
        if (publisher.PublishedMessages != ItemCount || snapshot.PublishedMessages != ItemCount)
            throw new InvalidOperationException($"Telemetry ingest drain lost messages. publisher={publisher.PublishedMessages}, snapshot={snapshot.PublishedMessages}.");
        if (snapshot.QueueDepth != 0)
            throw new InvalidOperationException($"Telemetry ingest queue was not drained. depth={snapshot.QueueDepth}.");

        var enqueuedBeforeLateWrite = snapshot.EnqueuedMessages;
        await pipeline.EnqueueAsync(Message(deviceId, ItemCount));
        if (pipeline.GetSnapshot().EnqueuedMessages != enqueuedBeforeLateWrite)
            throw new InvalidOperationException("Telemetry ingest accepted a new message after shutdown started.");

        Console.WriteLine($"pipeline=ingest enqueued={snapshot.EnqueuedMessages} published={snapshot.PublishedMessages} batches={snapshot.PublishedBatches} queueDepth={snapshot.QueueDepth}");
    }

    private static async Task VerifyRuleDispatchDrainAsync()
    {
        var calls = 0;
        var option = new EventBusOption();
        option.RunRules += (_, _, eventType) =>
        {
            if (eventType == EventType.Telemetry)
                Interlocked.Increment(ref calls);
            return Task.CompletedTask;
        };

        using var pipeline = new TelemetryRuleDispatchPipeline(
            option,
            Options.Create(new TelemetryRuleDispatchOptions
            {
                PartitionCount = 1,
                CapacityPerPartition = 128
            }),
            NullLogger<TelemetryRuleDispatchPipeline>.Instance);

        await pipeline.StartAsync(CancellationToken.None);
        var deviceId = Guid.NewGuid();
        for (var i = 0; i < ItemCount; i++)
            await pipeline.EnqueueAsync(deviceId, i, null);

        using (var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            await pipeline.StopAsync(stopCts.Token);

        var snapshot = pipeline.GetSnapshot();
        if (Volatile.Read(ref calls) != ItemCount || snapshot.Processed != ItemCount)
            throw new InvalidOperationException($"Telemetry rule dispatch drain lost work. calls={calls}, processed={snapshot.Processed}.");
        if (snapshot.QueueDepth != 0)
            throw new InvalidOperationException($"Telemetry rule dispatch queue was not drained. depth={snapshot.QueueDepth}.");

        var enqueuedBeforeLateWrite = snapshot.Enqueued;
        await pipeline.EnqueueAsync(deviceId, ItemCount, null);
        if (pipeline.GetSnapshot().Enqueued != enqueuedBeforeLateWrite)
            throw new InvalidOperationException("Telemetry rule dispatch accepted new work after shutdown started.");

        Console.WriteLine($"pipeline=rule-dispatch enqueued={snapshot.Enqueued} processed={snapshot.Processed} failed={snapshot.Failed} queueDepth={snapshot.QueueDepth}");
    }

    private static PlayloadData Message(Guid deviceId, int value) => new()
    {
        DeviceId = deviceId,
        ts = DateTime.UtcNow,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object> { ["P0001"] = value }
    };

    private sealed class CountingPublisher : IPublisher
    {
        private long _publishedMessages;
        private long _publishedBatches;

        public long PublishedMessages => Interlocked.Read(ref _publishedMessages);
        public long PublishedBatches => Interlocked.Read(ref _publishedBatches);

        public Task<EventBusMetrics> GetMetrics() => Task.FromResult(default(EventBusMetrics)!);
        public Task PublishCreateDevice(Guid devid) => Task.CompletedTask;
        public Task PublishDeleteDevice(Guid devid) => Task.CompletedTask;
        public Task PublishAttributeData(PlayloadData msg) => Task.CompletedTask;
        public Task PublishTelemetryData(PlayloadData msg)
        {
            Interlocked.Increment(ref _publishedMessages);
            return Task.CompletedTask;
        }

        public Task PublishTelemetryDataBatch(IReadOnlyCollection<PlayloadData> messages)
        {
            Interlocked.Add(ref _publishedMessages, messages.Count);
            Interlocked.Increment(ref _publishedBatches);
            return Task.CompletedTask;
        }

        public Task PublishConnect(Guid devid, ConnectStatus devicestatus) => Task.CompletedTask;
        public Task PublishActive(Guid devid, ActivityStatus activity) => Task.CompletedTask;
        public Task PublishDeviceAlarm(CreateAlarmDto alarmDto) => Task.CompletedTask;
    }
}
