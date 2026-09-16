using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.Ingestion;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class ReliableEventProcessorTests
{
    [Fact]
    public async Task Process_FirstEvent_CompletesAndRunsBusinessOnce()
    {
        await using var fixture = await Fixture.CreateAsync();
        var envelope = Envelope("evt-1", "Alarm-A");

        var result = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, Hash(envelope));

        Assert.True(result.Success, result.Message);
        Assert.False(result.Duplicate);
        Assert.Equal(1, fixture.Handler.Calls);
        var receipt = await fixture.ReadReceiptAsync("evt-1");
        Assert.Equal(ReliableEventReceiptStatuses.Completed, receipt.Status);
        Assert.NotNull(receipt.ProcessedAt);
    }

    [Fact]
    public async Task Process_CompletedDuplicate_DoesNotRunBusinessTwice()
    {
        await using var fixture = await Fixture.CreateAsync();
        var envelope = Envelope("evt-dup", "Alarm-A");
        var hash = Hash(envelope);

        var first = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, hash);
        var second = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, hash);

        Assert.True(first.Success);
        Assert.True(second.Success);
        Assert.True(second.Duplicate);
        Assert.Equal(1, fixture.Handler.Calls);
    }

    [Fact]
    public async Task Process_SameEventIdDifferentPayload_ReturnsConflict()
    {
        await using var fixture = await Fixture.CreateAsync();
        var first = Envelope("evt-conflict", "Alarm-A");
        var conflicting = Envelope("evt-conflict", "Alarm-B");

        Assert.True((await fixture.Processor.ProcessAsync(fixture.Gateway, first, Hash(first))).Success);
        var result = await fixture.Processor.ProcessAsync(fixture.Gateway, conflicting, Hash(conflicting));

        Assert.False(result.Success);
        Assert.True(result.Conflict);
        Assert.Equal(1, fixture.Handler.Calls);
        var receipt = await fixture.ReadReceiptAsync("evt-conflict");
        Assert.Equal(Hash(first), receipt.PayloadHash);
        Assert.Equal(ReliableEventReceiptStatuses.Completed, receipt.Status);
    }

    [Fact]
    public async Task Process_FailedEvent_CanRetryAndComplete()
    {
        await using var fixture = await Fixture.CreateAsync(failuresBeforeSuccess: 1);
        var envelope = Envelope("evt-retry", "Alarm-A");
        var hash = Hash(envelope);

        var first = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, hash);
        Assert.False(first.Success);
        var failed = await fixture.ReadReceiptAsync("evt-retry");
        Assert.Equal(ReliableEventReceiptStatuses.Failed, failed.Status);
        Assert.False(string.IsNullOrWhiteSpace(failed.LastError));

        var second = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, hash);
        Assert.True(second.Success, second.Message);
        Assert.False(second.Duplicate);
        Assert.Equal(2, fixture.Handler.Calls);
        var completed = await fixture.ReadReceiptAsync("evt-retry");
        Assert.Equal(ReliableEventReceiptStatuses.Completed, completed.Status);
        Assert.Null(completed.LastError);
    }

    [Fact]
    public async Task Process_BusinessFailure_PersistsFailedReceipt()
    {
        await using var fixture = await Fixture.CreateAsync(failuresBeforeSuccess: int.MaxValue);
        var envelope = Envelope("evt-fail", "Alarm-A");

        var result = await fixture.Processor.ProcessAsync(fixture.Gateway, envelope, Hash(envelope));

        Assert.False(result.Success);
        var receipt = await fixture.ReadReceiptAsync("evt-fail");
        Assert.Equal(ReliableEventReceiptStatuses.Failed, receipt.Status);
        Assert.Null(receipt.ProcessedAt);
        Assert.Contains("simulated failure", receipt.LastError, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Process_ConcurrentSameEvent_RunsBusinessOnce()
    {
        await using var fixture = await Fixture.CreateAsync(delayMs: 40);
        var envelope = Envelope("evt-concurrent", "Alarm-A");
        var hash = Hash(envelope);

        var tasks = Enumerable.Range(0, 8)
            .Select(_ => fixture.Processor.ProcessAsync(fixture.Gateway, envelope, hash))
            .ToArray();
        var results = await Task.WhenAll(tasks);

        Assert.All(results, result => Assert.True(result.Success, result.Message));
        Assert.Equal(1, fixture.Handler.Calls);
        Assert.Equal(7, results.Count(result => result.Duplicate));
    }

    private static ReliableEventEnvelope Envelope(string eventId, string alarmType)
    {
        using var document = JsonDocument.Parse($"{{\"alarmType\":\"{alarmType}\",\"alarmDetail\":\"test\"}}");
        return new ReliableEventEnvelope
        {
            Version = 1,
            GatewayId = "GW-TEST",
            EventId = eventId,
            Type = "Alarm",
            DeviceId = "me",
            OccurredAt = new DateTime(2026, 9, 15, 5, 20, 0, DateTimeKind.Utc),
            Payload = document.RootElement.Clone()
        };
    }

    private static string Hash(ReliableEventEnvelope envelope)
        => ReliableEventParserValidator.ComputeSemanticHash(envelope);

    private sealed class FakeBusinessHandler : IReliableEventBusinessHandler
    {
        private readonly int _failuresBeforeSuccess;
        private readonly int _delayMs;
        private int _calls;

        public FakeBusinessHandler(int failuresBeforeSuccess, int delayMs)
        {
            _failuresBeforeSuccess = failuresBeforeSuccess;
            _delayMs = delayMs;
        }

        public int Calls => Volatile.Read(ref _calls);
        public bool CanHandle(string eventType) => string.Equals(eventType, "Alarm", StringComparison.OrdinalIgnoreCase);

        public async Task<ReliableEventBusinessResult> HandleAsync(
            ApplicationDbContext dbContext,
            Device gateway,
            Device targetDevice,
            ReliableEventEnvelope envelope,
            CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _calls);
            if (_delayMs > 0) await Task.Delay(_delayMs, cancellationToken);
            return call <= _failuresBeforeSuccess
                ? ReliableEventBusinessResult.Fail("simulated failure")
                : ReliableEventBusinessResult.Ok("processed");
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly ServiceProvider _provider;
        public Device Gateway { get; }
        public ReliableEventProcessor Processor { get; }
        public FakeBusinessHandler Handler { get; }

        private Fixture(ServiceProvider provider, Device gateway, ReliableEventProcessor processor, FakeBusinessHandler handler)
        {
            _provider = provider;
            Gateway = gateway;
            Processor = processor;
            Handler = handler;
        }

        public static async Task<Fixture> CreateAsync(int failuresBeforeSuccess = 0, int delayMs = 0)
        {
            var databaseName = $"reliable-events-{Guid.NewGuid():N}";
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddEntityFrameworkInMemoryDatabase();
            services.AddSingleton<IDataBaseModelBuilderOptions, TestModelBuilderOptions>();
            services.AddDbContext<ApplicationDbContext>((provider, options) =>
            {
                options.UseInMemoryDatabase(databaseName);
                options.UseInternalServiceProvider(provider);
            });
            services.AddSingleton<GatewayChildDeviceResolver>();
            var handler = new FakeBusinessHandler(failuresBeforeSuccess, delayMs);
            services.AddSingleton<IReliableEventBusinessHandler>(handler);
            services.AddSingleton<ReliableEventProcessor>();

            var provider = services.BuildServiceProvider(validateScopes: true);
            var gateway = new Gateway
            {
                Id = Guid.NewGuid(),
                Name = "GW-TEST",
                DeviceType = DeviceType.Gateway,
                Timeout = 300,
                Children = []
            };
            using (var scope = provider.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                db.Gateway.Add(gateway);
                await db.SaveChangesAsync();
            }

            return new Fixture(provider, new Device
            {
                Id = gateway.Id,
                Name = gateway.Name,
                DeviceType = DeviceType.Gateway,
                Timeout = gateway.Timeout
            }, provider.GetRequiredService<ReliableEventProcessor>(), handler);
        }

        public async Task<ReliableEventReceipt> ReadReceiptAsync(string eventId)
        {
            using var scope = _provider.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            return await db.ReliableEventReceipts.AsNoTracking()
                .SingleAsync(item => item.GatewayId == Gateway.Id && item.EventId == eventId);
        }

        public async ValueTask DisposeAsync() => await _provider.DisposeAsync();
    }

    private sealed class TestModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}
