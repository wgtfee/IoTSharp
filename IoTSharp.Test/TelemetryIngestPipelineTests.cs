using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class TelemetryIngestPipelineTests
{
    [Fact]
    public async Task BatchSize_PreservesDeviceOrder()
    {
        var publisher = new RecordingPublisher();
        var pipeline = Create(publisher, 4, 32, 4, 1000);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var deviceId = Guid.NewGuid();
            for (var i = 0; i < 4; i++)
                await pipeline.EnqueueAsync(Message(deviceId, i));

            await publisher.WaitAsync(4);
            Assert.Equal(new[] { 0, 1, 2, 3 }, publisher.Messages.Select(Sequence).ToArray());
            Assert.Equal(1, publisher.BatchCalls);
        }
        finally { await pipeline.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task FlushInterval_FlushesPartialBatch()
    {
        var publisher = new RecordingPublisher();
        var pipeline = Create(publisher, 1, 8, 100, 30);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            await pipeline.EnqueueAsync(Message(Guid.NewGuid(), 7));
            await publisher.WaitAsync(1);
            Assert.Equal(7, Sequence(publisher.Messages.Single()));
        }
        finally { await pipeline.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task BoundedCapacity_WaitsWithoutDropping()
    {
        var publisher = new RecordingPublisher(true);
        var pipeline = Create(publisher, 1, 1, 1, 1000);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var id = Guid.NewGuid();
            await pipeline.EnqueueAsync(Message(id, 1));
            await publisher.FirstBatch.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await pipeline.EnqueueAsync(Message(id, 2));
            var third = pipeline.EnqueueAsync(Message(id, 3)).AsTask();
            await Task.Delay(50);
            Assert.False(third.IsCompleted);
            var blocked = pipeline.GetSnapshot();
            Assert.True(blocked.QueueDepth <= blocked.Capacity);
            Assert.True(blocked.PendingWriters > 0);

            publisher.Release.TrySetResult();
            await third;
            await publisher.WaitAsync(3);
            Assert.Equal(new[] { 1, 2, 3 }, publisher.Messages.Select(Sequence).ToArray());
            Assert.True(pipeline.GetSnapshot().BackpressureWaits > 0);
        }
        finally
        {
            publisher.Release.TrySetResult();
            await pipeline.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task SameDeviceSameTimestamp_IsNormalizedToStrictlyIncreasingTicks()
    {
        var publisher = new RecordingPublisher();
        var pipeline = Create(publisher, 4, 2048, 256, 10);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var deviceId = Guid.NewGuid();
            var timestamp = new DateTime(2026, 9, 16, 1, 56, 40, 722, DateTimeKind.Utc);
            const int count = 1000;
            for (var i = 0; i < count; i++)
                await pipeline.EnqueueAsync(Message(deviceId, i, timestamp));

            await publisher.WaitAsync(count);
            var messages = publisher.Messages.ToArray();
            Assert.Equal(count, messages.Length);
            Assert.Equal(timestamp, messages[0].ts);
            for (var i = 1; i < messages.Length; i++)
                Assert.Equal(messages[i - 1].ts.Ticks + 1, messages[i].ts.Ticks);
            Assert.Equal(count, messages.Select(message => message.ts).Distinct().Count());
        }
        finally { await pipeline.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task DifferentDevices_CanRetainTheSameTimestamp()
    {
        var publisher = new RecordingPublisher();
        var pipeline = Create(publisher, 1, 8, 8, 10);
        await pipeline.StartAsync(CancellationToken.None);
        try
        {
            var timestamp = new DateTime(2026, 9, 16, 2, 0, 0, DateTimeKind.Utc);
            await pipeline.EnqueueAsync(Message(Guid.NewGuid(), 1, timestamp));
            await pipeline.EnqueueAsync(Message(Guid.NewGuid(), 2, timestamp));

            await publisher.WaitAsync(2);
            Assert.All(publisher.Messages, message => Assert.Equal(timestamp, message.ts));
        }
        finally { await pipeline.StopAsync(CancellationToken.None); }
    }

    private static TelemetryIngestPipeline Create(RecordingPublisher publisher, int partitions, int capacity, int batch, int flush)
        => new(
            publisher,
            Options.Create(new TelemetryIngestOptions
            {
                PartitionCount = partitions,
                CapacityPerPartition = capacity,
                BatchSize = batch,
                FlushIntervalMilliseconds = flush,
                RetryDelayMilliseconds = 10
            }),
            NullLogger<TelemetryIngestPipeline>.Instance);

    private static PlayloadData Message(Guid id, int sequence, DateTime? timestamp = null) => new()
    {
        DeviceId = id,
        ts = timestamp ?? DateTime.UtcNow,
        DataCatalog = DataCatalog.TelemetryData,
        DataSide = DataSide.ClientSide,
        MsgBody = new Dictionary<string, object> { ["sequence"] = sequence }
    };

    private static int Sequence(PlayloadData message) => Convert.ToInt32(message.MsgBody["sequence"]);

    private sealed class RecordingPublisher(bool blockFirst = false) : IPublisher
    {
        private readonly ConcurrentQueue<PlayloadData> _messages = new();
        private int _batchCalls;
        public TaskCompletionSource FirstBatch { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IReadOnlyCollection<PlayloadData> Messages => _messages.ToArray();
        public int BatchCalls => Volatile.Read(ref _batchCalls);

        public async Task PublishTelemetryDataBatch(IReadOnlyCollection<PlayloadData> messages)
        {
            var call = Interlocked.Increment(ref _batchCalls);
            FirstBatch.TrySetResult();
            if (blockFirst && call == 1) await Release.Task;
            foreach (var message in messages) _messages.Enqueue(message);
        }

        public async Task WaitAsync(int count)
        {
            var deadline = DateTime.UtcNow.AddSeconds(3);
            while (_messages.Count < count && DateTime.UtcNow < deadline) await Task.Delay(10);
            Assert.True(_messages.Count >= count, $"Expected {count}, got {_messages.Count}");
        }

        public Task<EventBusMetrics> GetMetrics() => Task.FromResult(new EventBusMetrics());
        public Task PublishCreateDevice(Guid devid) => Task.CompletedTask;
        public Task PublishDeleteDevice(Guid devid) => Task.CompletedTask;
        public Task PublishAttributeData(PlayloadData msg) => Task.CompletedTask;
        public Task PublishTelemetryData(PlayloadData msg) { _messages.Enqueue(msg); return Task.CompletedTask; }
        public Task PublishConnect(Guid devid, ConnectStatus status) => Task.CompletedTask;
        public Task PublishActive(Guid devid, ActivityStatus status) => Task.CompletedTask;
        public Task PublishDeviceAlarm(CreateAlarmDto dto) => Task.CompletedTask;
    }
}
