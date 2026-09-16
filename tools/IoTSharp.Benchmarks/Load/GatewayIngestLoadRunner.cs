using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Services.Ingestion;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Benchmarks.Load;

internal static class GatewayIngestLoadRunner
{
    public static async Task<int> RunAsync(string[] args)
    {
        var totalPoints = ReadInt(args, "--points", 100_000, 1, 10_000_000);
        var batchPoints = ReadInt(args, "--batch-points", 2_000, 1, 20_000);
        var devicesPerBatch = ReadInt(args, "--devices-per-batch", 20, 1, 500);
        var producers = ReadInt(args, "--producers", Math.Clamp(Environment.ProcessorCount / 2, 1, 8), 1, 64);
        var partitions = ReadInt(args, "--partitions", Math.Clamp(Environment.ProcessorCount, 2, 16), 1, 64);
        var capacityPerPartition = ReadInt(args, "--capacity-per-partition", 4096, 1, 1_000_000);
        var pipelineBatchSize = ReadInt(args, "--pipeline-batch-size", 256, 1, 8192);
        var publisherDelayMs = ReadInt(args, "--publisher-delay-ms", 0, 0, 60_000);
        var failEveryBatch = ReadInt(args, "--fail-every-batch", 0, 0, 1_000_000);

        devicesPerBatch = Math.Min(devicesPerBatch, batchPoints);
        var fullPayload = BuildPayload("GW-BENCH", batchPoints, devicesPerBatch);
        var options = new GatewayBatchIngestOptions
        {
            Version = 1,
            MaxBatchBytes = Math.Max(512 * 1024, fullPayload.Length * 2),
            MaxBatchPoints = Math.Max(batchPoints, 1),
            MaxDevicesPerBatch = devicesPerBatch
        };
        var gateway = new Device
        {
            Id = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Name = "GW-BENCH",
            DeviceType = DeviceType.Gateway
        };

        var publisher = new CountingPublisher(publisherDelayMs, failEveryBatch);
        var pipeline = new TelemetryIngestPipeline(
            publisher,
            Options.Create(new TelemetryIngestOptions
            {
                PartitionCount = partitions,
                CapacityPerPartition = capacityPerPartition,
                BatchSize = pipelineBatchSize,
                FlushIntervalMilliseconds = 5,
                RetryDelayMilliseconds = 10
            }),
            NullLogger<TelemetryIngestPipeline>.Instance);

        var warmup = GatewayBatchIngestValidator.Validate(fullPayload, gateway.Name, gateway, options);
        if (!warmup.Success || warmup.Batch is null)
        {
            Console.Error.WriteLine($"Gateway ingest load setup failed: {warmup.Error}");
            return 2;
        }
        _ = GatewayBatchIngestValidator.ToTelemetryValues(warmup.Batch.Devices[0]);

        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        var allocationBefore = GC.GetTotalAllocatedBytes(true);
        var workingSetBefore = Process.GetCurrentProcess().WorkingSet64;
        var gen0Before = GC.CollectionCount(0);
        var gen1Before = GC.CollectionCount(1);
        var gen2Before = GC.CollectionCount(2);
        var stopwatch = Stopwatch.StartNew();
        await pipeline.StartAsync(CancellationToken.None);

        var batchCount = (int)Math.Ceiling((double)totalPoints / batchPoints);
        var nextBatch = -1;
        long enqueuedMessages = 0;
        long acceptedPoints = 0;
        long parsedBytes = 0;
        long maxQueueDepth = 0;
        long maxPendingWriters = 0;
        var failures = new ConcurrentQueue<string>();
        var childIds = Enumerable.Range(0, devicesPerBatch)
            .ToDictionary(index => $"PLC-{index:D4}", index => CreateStableGuid(index), StringComparer.OrdinalIgnoreCase);

        async Task ProducerAsync()
        {
            while (true)
            {
                var batchIndex = Interlocked.Increment(ref nextBatch);
                if (batchIndex >= batchCount) return;
                var remaining = totalPoints - (batchIndex * batchPoints);
                var pointsThisBatch = Math.Min(batchPoints, remaining);
                var payload = pointsThisBatch == batchPoints
                    ? fullPayload
                    : BuildPayload(gateway.Name, pointsThisBatch, Math.Min(devicesPerBatch, pointsThisBatch));
                var validation = GatewayBatchIngestValidator.Validate(payload, gateway.Name, gateway, options);
                if (!validation.Success || validation.Batch is null)
                {
                    failures.Enqueue(validation.Error);
                    return;
                }

                Interlocked.Add(ref parsedBytes, payload.Length);
                Interlocked.Add(ref acceptedPoints, validation.PointCount);
                foreach (var device in validation.Batch.Devices)
                {
                    if (!childIds.TryGetValue(device.DeviceId, out var deviceId))
                        deviceId = CreateStableGuid(Math.Abs(StringComparer.OrdinalIgnoreCase.GetHashCode(device.DeviceId)));
                    await pipeline.EnqueueAsync(new PlayloadData
                    {
                        DeviceId = deviceId,
                        ts = validation.TimestampUtc,
                        MsgBody = GatewayBatchIngestValidator.ToTelemetryValues(device),
                        DataSide = DataSide.ClientSide,
                        DataCatalog = DataCatalog.TelemetryData
                    });
                    Interlocked.Increment(ref enqueuedMessages);
                }

                var snapshot = pipeline.GetSnapshot();
                UpdateMax(ref maxQueueDepth, snapshot.QueueDepth);
                UpdateMax(ref maxPendingWriters, snapshot.PendingWriters);
            }
        }

        await Task.WhenAll(Enumerable.Range(0, producers).Select(_ => ProducerAsync()));
        if (!failures.IsEmpty)
        {
            await pipeline.StopAsync(CancellationToken.None);
            Console.Error.WriteLine($"Gateway ingest load failed: {string.Join(" | ", failures.Take(3))}");
            return 3;
        }

        using var drainTimeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        while (publisher.PublishedMessages < Volatile.Read(ref enqueuedMessages))
        {
            await Task.Delay(10, drainTimeout.Token);
            var draining = pipeline.GetSnapshot();
            UpdateMax(ref maxQueueDepth, draining.QueueDepth);
            UpdateMax(ref maxPendingWriters, draining.PendingWriters);
        }

        await pipeline.StopAsync(CancellationToken.None);
        stopwatch.Stop();
        var finalSnapshot = pipeline.GetSnapshot();
        var allocationAfter = GC.GetTotalAllocatedBytes(true);
        var workingSetAfter = Process.GetCurrentProcess().WorkingSet64;
        var elapsedSeconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.000001);
        var pointsPerSecond = acceptedPoints / elapsedSeconds;
        var messagesPerSecond = enqueuedMessages / elapsedSeconds;

        Console.WriteLine("GATEWAY_INGEST_LOAD_OK");
        Console.WriteLine($"points={acceptedPoints:N0} batches={batchCount:N0} deviceMessages={enqueuedMessages:N0} parsedBytes={parsedBytes:N0}");
        Console.WriteLine($"elapsedMs={stopwatch.Elapsed.TotalMilliseconds:F1} pointsPerSec={pointsPerSecond:N0} messagesPerSec={messagesPerSecond:N0}");
        Console.WriteLine($"managedAllocatedMB={(allocationAfter - allocationBefore) / 1024d / 1024d:F1} workingSetDeltaMB={(workingSetAfter - workingSetBefore) / 1024d / 1024d:F1}");
        Console.WriteLine($"queueMax={maxQueueDepth:N0}/{finalSnapshot.Capacity:N0} pendingWritersMax={maxPendingWriters:N0} backpressureWaits={finalSnapshot.BackpressureWaits:N0} publishedBatches={finalSnapshot.PublishedBatches:N0}");
        Console.WriteLine($"publisherDelayMs={publisherDelayMs} failEveryBatch={failEveryBatch} publishFailures={finalSnapshot.PublishFailures:N0} publishAttempts={publisher.PublishAttempts:N0}");
        Console.WriteLine($"gcGen0={GC.CollectionCount(0) - gen0Before} gcGen1={GC.CollectionCount(1) - gen1Before} gcGen2={GC.CollectionCount(2) - gen2Before}");
        if (publisher.PublishedMessages != enqueuedMessages)
        {
            Console.Error.WriteLine($"Gateway ingest load lost messages: enqueued={enqueuedMessages}, published={publisher.PublishedMessages}.");
            return 4;
        }
        return 0;
    }

    private static byte[] BuildPayload(string gatewayId, int pointCount, int deviceCount)
    {
        deviceCount = Math.Clamp(deviceCount, 1, pointCount);
        var remaining = pointCount;
        var devices = new List<object>(deviceCount);
        for (var deviceIndex = 0; deviceIndex < deviceCount; deviceIndex++)
        {
            var slotsLeft = deviceCount - deviceIndex;
            var count = remaining / slotsLeft;
            remaining -= count;
            var values = new Dictionary<string, object>(count, StringComparer.Ordinal);
            for (var pointIndex = 0; pointIndex < count; pointIndex++)
                values[$"p{pointIndex:D5}"] = pointIndex + deviceIndex;
            devices.Add(new { deviceId = $"PLC-{deviceIndex:D4}", values });
        }

        return JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = 1,
            gatewayId,
            batchId = 1L,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            devices
        });
    }

    private static Guid CreateStableGuid(int value)
    {
        Span<byte> bytes = stackalloc byte[16];
        BitConverter.TryWriteBytes(bytes, value);
        bytes[15] = 1;
        return new Guid(bytes);
    }

    private static int ReadInt(string[] args, string name, int fallback, int min, int max)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)
                && int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                return Math.Clamp(parsed, min, max);
        }
        return fallback;
    }

    private static void UpdateMax(ref long target, long value)
    {
        while (true)
        {
            var current = Volatile.Read(ref target);
            if (value <= current) return;
            if (Interlocked.CompareExchange(ref target, value, current) == current) return;
        }
    }

    private sealed class CountingPublisher : IPublisher
    {
        private readonly int _delayMilliseconds;
        private readonly int _failEveryBatch;
        private long _publishedMessages;
        private long _publishAttempts;

        public CountingPublisher(int delayMilliseconds, int failEveryBatch)
        {
            _delayMilliseconds = delayMilliseconds;
            _failEveryBatch = failEveryBatch;
        }

        public long PublishedMessages => Interlocked.Read(ref _publishedMessages);
        public long PublishAttempts => Interlocked.Read(ref _publishAttempts);

        public Task<EventBusMetrics> GetMetrics() => Task.FromResult<EventBusMetrics>(null);
        public Task PublishCreateDevice(Guid devid) => Task.CompletedTask;
        public Task PublishDeleteDevice(Guid devid) => Task.CompletedTask;
        public Task PublishAttributeData(PlayloadData msg) => Task.CompletedTask;
        public Task PublishConnect(Guid devid, ConnectStatus devicestatus) => Task.CompletedTask;
        public Task PublishActive(Guid devid, ActivityStatus activity) => Task.CompletedTask;
        public Task PublishDeviceAlarm(CreateAlarmDto alarmDto) => Task.CompletedTask;
        public async Task PublishTelemetryData(PlayloadData msg)
        {
            var attempt = Interlocked.Increment(ref _publishAttempts);
            if (_delayMilliseconds > 0)
                await Task.Delay(_delayMilliseconds);
            if (_failEveryBatch > 0 && attempt % _failEveryBatch == 0)
                throw new InvalidOperationException($"Injected publisher failure at attempt {attempt}.");
            Interlocked.Increment(ref _publishedMessages);
        }

        public async Task PublishTelemetryDataBatch(IReadOnlyCollection<PlayloadData> messages)
        {
            var attempt = Interlocked.Increment(ref _publishAttempts);
            if (_delayMilliseconds > 0)
                await Task.Delay(_delayMilliseconds);
            if (_failEveryBatch > 0 && attempt % _failEveryBatch == 0)
                throw new InvalidOperationException($"Injected publisher failure at attempt {attempt}.");
            Interlocked.Add(ref _publishedMessages, messages.Count);
        }
    }
}
