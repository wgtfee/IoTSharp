using EasyCaching.Core;
using EasyCaching.Core.Configurations;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class TelemetryRuleEligibilityTests
{
    [Fact]
    public async Task Batch_WhenNoDeviceHasRules_StoresButSkipsRuleProjectionAndDispatch()
    {
        using var fixture = new SubscriberFixture(_ => Task.FromResult(false));
        var messages = new[] { Message(Guid.NewGuid()), Message(Guid.NewGuid()) };

        await fixture.Subscriber.StoreTelemetryDataBatch(messages);

        Assert.Equal(2, fixture.Storage.StoredMessages);
        Assert.Equal(0, fixture.DispatchCount);
    }

    [Fact]
    public async Task Batch_WhenOnlyOneDeviceHasRules_DispatchesOnlyEligibleDevice()
    {
        var eligible = Guid.NewGuid();
        using var fixture = new SubscriberFixture(id => Task.FromResult(id == eligible));
        var messages = new[] { Message(eligible), Message(Guid.NewGuid()), Message(eligible) };

        await fixture.Subscriber.StoreTelemetryDataBatch(messages);

        Assert.Equal(3, fixture.Storage.StoredMessages);
        Assert.Equal(2, fixture.DispatchCount);
    }

    [Theory]
    [InlineData(TelemetryRuleDispatchMode.Telemetry, true, false)]
    [InlineData(TelemetryRuleDispatchMode.TelemetryArray, false, true)]
    public async Task Batch_SelectivelyBuildsOnlyRequiredPayload(
        TelemetryRuleDispatchMode mode,
        bool expectTelemetry,
        bool expectTelemetryArray)
    {
        using var fixture = new SubscriberFixture(_ => Task.FromResult(true), _ => Task.FromResult(mode));

        await fixture.Subscriber.StoreTelemetryDataBatch(new[] { Message(Guid.NewGuid()) });

        Assert.Equal(expectTelemetry, fixture.LastTelemetry != null);
        Assert.Equal(expectTelemetryArray, fixture.LastTelemetryArray != null);
    }

    private static PlayloadData Message(Guid deviceId) => new()
    {
        DeviceId = deviceId,
        ts = DateTime.UtcNow,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object> { ["temperature"] = 23.5d }
    };

    private sealed class SubscriberFixture : IDisposable
    {
        private readonly ServiceProvider _provider;
        private int _dispatchCount;

        public SubscriberFixture(
            EventBusOption.ShouldDispatchTelemetryRulesEventHander eligibility,
            EventBusOption.GetTelemetryRuleDispatchModeEventHander? mode = null)
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddEasyCaching(options => options.UseInMemory("CachingUseIn-InMemory"));
            _provider = services.BuildServiceProvider();
            Storage = new CountingStorage();
            var option = new EventBusOption
            {
                AppSettings = new AppSettings { CachingUseIn = CachingUseIn.InMemory },
                ShouldDispatchTelemetryRules = eligibility
            };
            if (mode != null)
            {
                option.GetTelemetryRuleDispatchMode = mode;
            }
            option.DispatchTelemetryRules = (_, telemetry, telemetryArray) =>
            {
                LastTelemetry = telemetry;
                LastTelemetryArray = telemetryArray;
                Interlocked.Increment(ref _dispatchCount);
                return Task.CompletedTask;
            };
            Subscriber = new EventBusSubscriber(
                NullLogger<EventBusSubscriber>.Instance,
                _provider.GetRequiredService<IServiceScopeFactory>(),
                Storage,
                _provider.GetRequiredService<IEasyCachingProviderFactory>(),
                option);
        }

        public EventBusSubscriber Subscriber { get; }
        public CountingStorage Storage { get; }
        public int DispatchCount => Volatile.Read(ref _dispatchCount);
        public object? LastTelemetry { get; private set; }
        public object? LastTelemetryArray { get; private set; }
        public void Dispose() => _provider.Dispose();
    }

    public sealed class CountingStorage : IStorage
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
            return Task.FromResult(new TelemetryBatchStoreResult(true, new List<TelemetryData>(), messages.Count));
        }
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId) => Task.FromResult(new List<TelemetryDataDto>());
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys) => Task.FromResult(new List<TelemetryDataDto>());
        public Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate) => Task.FromResult(new List<TelemetryDataDto>());
    }
}
