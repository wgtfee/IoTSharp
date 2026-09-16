using EasyCaching.Core;
using EasyCaching.Core.Configurations;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using IoTSharp.EventBus;
using IoTSharp.Services.RuleDispatch;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Dynamic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Benchmarks.Load;

internal static class TelemetryRuleLoadRunner
{
    public static async Task<int> RunAsync(string[] args)
    {
        var totalPoints = ReadInt(args, "--points", 100_000, 1, 10_000_000);
        var pointsPerMessage = ReadInt(args, "--points-per-message", 100, 1, 10_000);
        var messagesPerBatch = ReadInt(args, "--messages-per-batch", 128, 1, 4096);
        var partitions = ReadInt(args, "--partitions", Math.Clamp(Environment.ProcessorCount, 2, 16), 1, 64);
        var capacityPerPartition = ReadInt(args, "--capacity-per-partition", 2048, 1, 1_000_000);
        var rulesEnabled = ReadBool(args, "--rules-enabled", true);
        var ruleMode = ReadRuleMode(args, "--rule-mode",
            rulesEnabled ? TelemetryRuleDispatchMode.All : TelemetryRuleDispatchMode.None);
        if (!rulesEnabled)
            ruleMode = TelemetryRuleDispatchMode.None;
        var durationSeconds = ReadInt(args, "--duration-seconds", 0, 0, 3600);

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddEasyCaching(options => options.UseInMemory("CachingUseIn-InMemory"));
        using var provider = services.BuildServiceProvider();

        var eventBusOption = new EventBusOption
        {
            AppSettings = new AppSettings { CachingUseIn = CachingUseIn.InMemory }
        };
        eventBusOption.ShouldDispatchTelemetryRules = _ => Task.FromResult(ruleMode != TelemetryRuleDispatchMode.None);
        eventBusOption.GetTelemetryRuleDispatchMode = _ => Task.FromResult(ruleMode);
        long telemetryRuleCalls = 0;
        long telemetryArrayRuleCalls = 0;
        eventBusOption.RunRules = (_, _, eventType) =>
        {
            if (eventType == EventType.Telemetry)
                Interlocked.Increment(ref telemetryRuleCalls);
            else if (eventType == EventType.TelemetryArray)
                Interlocked.Increment(ref telemetryArrayRuleCalls);
            return Task.CompletedTask;
        };

        var rulePipeline = new TelemetryRuleDispatchPipeline(
            eventBusOption,
            Options.Create(new TelemetryRuleDispatchOptions
            {
                PartitionCount = partitions,
                CapacityPerPartition = capacityPerPartition
            }),
            NullLogger<TelemetryRuleDispatchPipeline>.Instance);
        eventBusOption.DispatchTelemetryRules = rulePipeline.EnqueueAsync;

        var storage = new CountingStorage();
        var subscriber = new EventBusSubscriber(
            NullLogger<EventBusSubscriber>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>(),
            storage,
            provider.GetRequiredService<IEasyCachingProviderFactory>(),
            eventBusOption);

        var fullBatchPoints = checked(pointsPerMessage * messagesPerBatch);
        var fullBatch = BuildMessages(fullBatchPoints, pointsPerMessage, 0);
        if (!ValidateRuleProjection(fullBatch[0]))
        {
            Console.Error.WriteLine("Telemetry rule load setup failed: rule projection semantic validation failed.");
            return 2;
        }

        await rulePipeline.StartAsync(CancellationToken.None);
        await subscriber.StoreTelemetryDataBatch(new[] { fullBatch[0] });
        if (ruleMode != TelemetryRuleDispatchMode.None)
        {
            await WaitForProcessedAsync(rulePipeline, 1, TimeSpan.FromSeconds(10));
        }
        var processedBefore = rulePipeline.GetSnapshot().Processed;
        var storedBefore = storage.StoredMessages;
        var telemetryRulesBefore = Interlocked.Read(ref telemetryRuleCalls);
        var telemetryArrayRulesBefore = Interlocked.Read(ref telemetryArrayRuleCalls);

        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        var retainedBefore = GC.GetTotalMemory(false);
        var allocationBefore = GC.GetTotalAllocatedBytes(true);
        var workingSetBefore = Process.GetCurrentProcess().WorkingSet64;
        var gen0Before = GC.CollectionCount(0);
        var gen1Before = GC.CollectionCount(1);
        var gen2Before = GC.CollectionCount(2);
        var stopwatch = Stopwatch.StartNew();

        long submittedPoints = 0;
        long submittedMessages = 0;
        long maxQueueDepth = 0;
        long maxPendingWriters = 0;
        var batchIndex = 0;
        while (durationSeconds > 0 ? stopwatch.Elapsed.TotalSeconds < durationSeconds : submittedPoints < totalPoints)
        {
            var remaining = durationSeconds > 0 ? fullBatchPoints : totalPoints - submittedPoints;
            var pointsThisBatch = (int)Math.Min(fullBatchPoints, remaining);
            var batch = pointsThisBatch == fullBatchPoints
                ? fullBatch
                : BuildMessages(pointsThisBatch, pointsPerMessage, batchIndex * messagesPerBatch);
            await subscriber.StoreTelemetryDataBatch(batch);
            submittedPoints += batch.Sum(message => message.MsgBody.Count);
            submittedMessages += batch.Count;
            batchIndex++;

            var snapshot = rulePipeline.GetSnapshot();
            UpdateMax(ref maxQueueDepth, snapshot.QueueDepth);
            UpdateMax(ref maxPendingWriters, snapshot.PendingWriters);
        }

        var expectedProcessed = processedBefore +
            (ruleMode != TelemetryRuleDispatchMode.None ? submittedMessages : 0);
        await WaitForProcessedAsync(rulePipeline, expectedProcessed, TimeSpan.FromMinutes(2));
        stopwatch.Stop();
        var snapshotFinal = rulePipeline.GetSnapshot();
        UpdateMax(ref maxQueueDepth, snapshotFinal.QueueDepth);
        UpdateMax(ref maxPendingWriters, snapshotFinal.PendingWriters);
        await rulePipeline.StopAsync(CancellationToken.None);

        var storedMessages = storage.StoredMessages - storedBefore;
        var telemetryRules = Interlocked.Read(ref telemetryRuleCalls) - telemetryRulesBefore;
        var telemetryArrayRules = Interlocked.Read(ref telemetryArrayRuleCalls) - telemetryArrayRulesBefore;
        var processedMessages = snapshotFinal.Processed - processedBefore;
        var allocationAfter = GC.GetTotalAllocatedBytes(true);
        var workingSetAfter = Process.GetCurrentProcess().WorkingSet64;
        var seconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.000001);
        var gen0 = GC.CollectionCount(0) - gen0Before;
        var gen1 = GC.CollectionCount(1) - gen1Before;
        var gen2 = GC.CollectionCount(2) - gen2Before;
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        var retainedAfter = GC.GetTotalMemory(true);

        Console.WriteLine("TELEMETRY_RULE_LOAD_OK");
        Console.WriteLine($"points={submittedPoints:N0} messages={submittedMessages:N0} batches={batchIndex:N0}");
        Console.WriteLine($"elapsedMs={stopwatch.Elapsed.TotalMilliseconds:F1} pointsPerSec={submittedPoints / seconds:N0} messagesPerSec={submittedMessages / seconds:N0}");
        Console.WriteLine($"managedAllocatedMB={(allocationAfter - allocationBefore) / 1024d / 1024d:F1} workingSetDeltaMB={(workingSetAfter - workingSetBefore) / 1024d / 1024d:F1}");
        Console.WriteLine($"ruleQueueMax={maxQueueDepth:N0}/{snapshotFinal.Capacity:N0} pendingWritersMax={maxPendingWriters:N0} backpressureWaits={snapshotFinal.BackpressureWaits:N0} failed={snapshotFinal.Failed:N0}");
        Console.WriteLine($"storedMessages={storedMessages:N0} processedMessages={processedMessages:N0} telemetryRules={telemetryRules:N0} telemetryArrayRules={telemetryArrayRules:N0}");
        Console.WriteLine($"rulesEnabled={ruleMode != TelemetryRuleDispatchMode.None} ruleMode={ruleMode}");
        Console.WriteLine($"durationSeconds={durationSeconds} retainedManagedDeltaMB={(retainedAfter - retainedBefore) / 1024d / 1024d:F1}");
        Console.WriteLine($"gcGen0={gen0} gcGen1={gen1} gcGen2={gen2}");

        if (submittedPoints < totalPoints
            || storedMessages != submittedMessages
            || processedMessages != (ruleMode != TelemetryRuleDispatchMode.None ? submittedMessages : 0)
            || telemetryRules != ((ruleMode & TelemetryRuleDispatchMode.Telemetry) != 0 ? submittedMessages : 0)
            || telemetryArrayRules != ((ruleMode & TelemetryRuleDispatchMode.TelemetryArray) != 0 ? submittedMessages : 0)
            || snapshotFinal.Failed != 0)
        {
            Console.Error.WriteLine("Telemetry rule load validation failed: count mismatch or failed rule dispatch.");
            return 3;
        }
        return 0;
    }

    private static List<PlayloadData> BuildMessages(int pointCount, int pointsPerMessage, int deviceOffset)
    {
        var messages = new List<PlayloadData>((int)Math.Ceiling((double)pointCount / pointsPerMessage));
        var remaining = pointCount;
        var messageIndex = 0;
        while (remaining > 0)
        {
            var count = Math.Min(pointsPerMessage, remaining);
            var values = new Dictionary<string, object>(count, StringComparer.Ordinal);
            for (var i = 0; i < count; i++)
                values[$"p{i:D5}"] = i + messageIndex;
            messages.Add(new PlayloadData
            {
                DeviceId = CreateStableGuid(deviceOffset + messageIndex),
                ts = DateTime.UtcNow,
                MsgBody = values,
                DataSide = DataSide.ClientSide,
                DataCatalog = DataCatalog.TelemetryData
            });
            messageIndex++;
            remaining -= count;
        }
        return messages;
    }

    private static bool ValidateRuleProjection(PlayloadData template)
    {
        var jsonObject = JsonSerializer.SerializeToElement(new { status = "ok", code = 7 });
        var sample = new PlayloadData
        {
            DeviceId = template.DeviceId,
            ts = new DateTime(2026, 9, 15, 6, 0, 0, DateTimeKind.Utc),
            DataSide = DataSide.ClientSide,
            DataCatalog = DataCatalog.TelemetryData,
            MsgBody = new Dictionary<string, object>
            {
                ["long"] = 12,
                ["double"] = 12.5d,
                ["bool"] = true,
                ["text"] = "ok",
                ["json"] = jsonObject,
                ["time"] = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc)
            }
        };
        var projected = sample.ToRuleTelemetryData().ToDictionary(item => item.KeyName!, StringComparer.Ordinal);
        return projected["long"].DataType == DataType.Long && Equals(projected["long"].Value, 12L)
            && projected["double"].DataType == DataType.Double && Equals(projected["double"].Value, 12.5d)
            && projected["bool"].DataType == DataType.Boolean && Equals(projected["bool"].Value, true)
            && projected["text"].DataType == DataType.String && Equals(projected["text"].Value, "ok")
            && projected["json"].DataType == DataType.String && projected["json"].Value?.ToString()?.Contains("\"status\":\"ok\"", StringComparison.Ordinal) == true
            && projected["time"].DataType == DataType.DateTime && Equals(projected["time"].Value, sample.ts);
    }

    private static async Task WaitForProcessedAsync(TelemetryRuleDispatchPipeline pipeline, long count, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (pipeline.GetSnapshot().Processed < count)
        {
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException($"Timed out waiting for {count} rule work items. Actual={pipeline.GetSnapshot().Processed}.");
            await Task.Delay(5);
        }
    }

    private static Guid CreateStableGuid(int value)
    {
        Span<byte> bytes = stackalloc byte[16];
        BitConverter.TryWriteBytes(bytes, value);
        bytes[15] = 2;
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

    private static bool ReadBool(string[] args, string name, bool fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)
                && bool.TryParse(args[i + 1], out var parsed))
                return parsed;
        }
        return fallback;
    }

    private static TelemetryRuleDispatchMode ReadRuleMode(
        string[] args,
        string name,
        TelemetryRuleDispatchMode fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (!string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                continue;

            return args[i + 1].ToLowerInvariant() switch
            {
                "none" => TelemetryRuleDispatchMode.None,
                "telemetry" => TelemetryRuleDispatchMode.Telemetry,
                "array" or "telemetryarray" => TelemetryRuleDispatchMode.TelemetryArray,
                "both" or "all" => TelemetryRuleDispatchMode.All,
                _ => fallback
            };
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

    private sealed class CountingStorage : IStorage
    {
        private long _storedMessages;
        public long StoredMessages => Interlocked.Read(ref _storedMessages);

        public Task<bool> CheckTelemetryStorage() => Task.FromResult(true);

        public Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
        {
            Interlocked.Increment(ref _storedMessages);
            return Task.FromResult((true, new List<TelemetryData>()));
        }

        public Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            Interlocked.Add(ref _storedMessages, messages.Count);
            return Task.FromResult(new TelemetryBatchStoreResult(true, new List<TelemetryData>(0), messages.Count));
        }

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
            => Task.FromResult(new List<TelemetryDataDto>());

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
            => Task.FromResult(new List<TelemetryDataDto>());

        public Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate)
            => Task.FromResult(new List<TelemetryDataDto>());
    }
}
