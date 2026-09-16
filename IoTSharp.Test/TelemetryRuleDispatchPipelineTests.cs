using IoTSharp.Contracts;
using IoTSharp.EventBus;
using IoTSharp.Services.RuleDispatch;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class TelemetryRuleDispatchPipelineTests
{
    [Fact]
    public async Task SameDevice_PreservesWorkItemAndEventTypeOrder()
    {
        var option = new EventBusOption();
        var observed = new ConcurrentQueue<string>();
        option.RunRules += (_, payload, eventType) =>
        {
            observed.Enqueue($"{payload}:{eventType}");
            return Task.CompletedTask;
        };
        var pipeline = CreatePipeline(option, capacity: 8);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var deviceId = Guid.NewGuid();
            await pipeline.EnqueueAsync(deviceId, "t1", "a1");
            await pipeline.EnqueueAsync(deviceId, "t2", "a2");
            await WaitForProcessedAsync(pipeline, 2);

            Assert.Equal(
                new[] { "t1:Telemetry", "a1:TelemetryArray", "t2:Telemetry", "a2:TelemetryArray" },
                observed.ToArray());
        }
        finally
        {
            await pipeline.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Worker_DoesNotMarkProcessedUntilRuleExecutionCompletes()
    {
        var option = new EventBusOption();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        option.RunRules += async (_, _, eventType) =>
        {
            if (eventType == EventType.Telemetry)
            {
                started.TrySetResult();
                await release.Task;
            }
        };
        var pipeline = CreatePipeline(option, capacity: 4);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            await pipeline.EnqueueAsync(Guid.NewGuid(), new object(), new object());
            await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(0, pipeline.GetSnapshot().Processed);

            release.TrySetResult();
            await WaitForProcessedAsync(pipeline, 1);
            Assert.Equal(1, pipeline.GetSnapshot().Processed);
        }
        finally
        {
            release.TrySetResult();
            await pipeline.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task BoundedCapacity_AppliesBackpressureWithoutDroppingWorkItems()
    {
        var option = new EventBusOption();
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var telemetryCalls = 0;
        option.RunRules += async (_, _, eventType) =>
        {
            if (eventType != EventType.Telemetry)
                return;

            var call = Interlocked.Increment(ref telemetryCalls);
            if (call == 1)
            {
                firstStarted.TrySetResult();
                await releaseFirst.Task;
            }
        };
        var pipeline = CreatePipeline(option, capacity: 1);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var deviceId = Guid.NewGuid();
            await pipeline.EnqueueAsync(deviceId, 1, 1);
            await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await pipeline.EnqueueAsync(deviceId, 2, 2);

            var third = pipeline.EnqueueAsync(deviceId, 3, 3);
            await Task.Delay(50);
            Assert.False(third.IsCompleted);

            releaseFirst.TrySetResult();
            await third;
            await WaitForProcessedAsync(pipeline, 3);

            var snapshot = pipeline.GetSnapshot();
            Assert.Equal(3, snapshot.Enqueued);
            Assert.Equal(3, snapshot.Processed);
            Assert.Equal(0, snapshot.Failed);
            Assert.True(snapshot.BackpressureWaits >= 1);
        }
        finally
        {
            releaseFirst.TrySetResult();
            await pipeline.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task SelectivePayload_OnlyRunsPresentRuleType()
    {
        var option = new EventBusOption();
        var observed = new ConcurrentQueue<EventType>();
        option.RunRules += (_, _, eventType) =>
        {
            observed.Enqueue(eventType);
            return Task.CompletedTask;
        };
        var pipeline = CreatePipeline(option, capacity: 4);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            await pipeline.EnqueueAsync(Guid.NewGuid(), new object(), null);
            await WaitForProcessedAsync(pipeline, 1);

            Assert.Equal(new[] { EventType.Telemetry }, observed.ToArray());
        }
        finally
        {
            await pipeline.StopAsync(CancellationToken.None);
        }
    }

    private static TelemetryRuleDispatchPipeline CreatePipeline(EventBusOption option, int capacity)
        => new(
            option,
            Options.Create(new TelemetryRuleDispatchOptions
            {
                PartitionCount = 1,
                CapacityPerPartition = capacity
            }),
            NullLogger<TelemetryRuleDispatchPipeline>.Instance);

    private static async Task WaitForProcessedAsync(TelemetryRuleDispatchPipeline pipeline, long count)
    {
        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (pipeline.GetSnapshot().Processed < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10);
        }

        Assert.True(pipeline.GetSnapshot().Processed >= count,
            $"Expected at least {count} processed items, actual {pipeline.GetSnapshot().Processed}.");
    }
}
