using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Storage;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

public sealed class PdmWorkerActivationTests
{
    [Fact]
    public void DefaultConfiguration_CreatesNoWorkerAndNoPdmContextRegistration()
    {
        var services = new ServiceCollection();
        services.AddPredictiveMaintenanceP1(new ConfigurationBuilder().Build());
        Assert.DoesNotContain(services, x => x.ServiceType == typeof(IHostedService));
        Assert.DoesNotContain(services, x => x.ServiceType == typeof(PdmDbContext));
    }

    [Fact]
    public void MissingExplicitSchemaOrSingleInstanceApproval_FailsClosed()
    {
        var options = new Dictionary<string, string?>
        {
            ["PredictiveMaintenance:Enabled"] = "true"
        };
        var config = new ConfigurationBuilder().AddInMemoryCollection(options).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPredictiveMaintenanceP1(config));
    }

    [Fact]
    public void EvenWithAllFlags_NoIndependentMetadataConnection_FailsClosed()
    {
        var options = ValidOptions();
        options.Remove("ConnectionStrings:PdmMetadata");
        var config = new ConfigurationBuilder().AddInMemoryCollection(options).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPredictiveMaintenanceP1(config));
    }

    [Fact]
    public void ReusingMainDatabaseConnection_IsExplicitlyRejected()
    {
        var options = ValidOptions();
        options["ConnectionStrings:IoTSharp"] = options["ConnectionStrings:PdmMetadata"];
        var config = new ConfigurationBuilder().AddInMemoryCollection(options).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPredictiveMaintenanceP1(config));
    }

    [Theory]
    [InlineData("PredictiveMaintenance:HistoryQueryPlanApproved")]
    [InlineData("PredictiveMaintenance:HistoryUtcContractApproved")]
    public void MissingProviderSafetyGate_RejectsStartup(string key)
    {
        var values = ValidOptions();
        values[key] = "false";
        var config = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPredictiveMaintenanceP1(config));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("121")]
    public void InvalidPerDeviceTimeout_RejectsStartup(string timeout)
    {
        var values = ValidOptions();
        values["PredictiveMaintenance:HistoryQueryTimeoutSeconds"] = timeout;
        var config = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPredictiveMaintenanceP1(config));
    }
    [Fact]
    public void OptInWithIndependentSchemaReadyMetadata_RegistersOneHostedWorker()
    {
        var services = new ServiceCollection();
        services.AddPredictiveMaintenanceP1(
            new ConfigurationBuilder().AddInMemoryCollection(ValidOptions()).Build());
        Assert.Single(services, x => x.ServiceType == typeof(IHostedService));
        Assert.Contains(services, x => x.ServiceType == typeof(PdmDbContext));
        Assert.Contains(services, x => x.ServiceType == typeof(IPdmHistoryReader));
    }

    [Fact]
    public async Task DisabledWorker_RunCyclePerformsNoDbOperations()
    {
        using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
        var worker = new PdmEvaluationWorker(
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PdmWorkerOptions()),
            NullLogger<PdmEvaluationWorker>.Instance);
        await worker.RunCycleAsync(CancellationToken.None);
    }

    private static Dictionary<string, string?> ValidOptions() => new()
    {
        ["PredictiveMaintenance:Enabled"] = "true",
        ["PredictiveMaintenance:SchemaReady"] = "true",
        ["PredictiveMaintenance:SingleInstanceAcknowledged"] = "true",
        ["PredictiveMaintenance:PointMappingsApproved"] = "true",
        ["PredictiveMaintenance:HistoryQueryPlanApproved"] = "true",
        ["PredictiveMaintenance:HistoryUtcContractApproved"] = "true",
        ["PredictiveMaintenance:MetadataProvider"] = "Sqlite",
        ["ConnectionStrings:PdmMetadata"] = "Data Source=pdm-test-artifact-not-opened.db"
    };
}

public sealed class PdmTelemetryHistoryReaderTests
{
    private static readonly DateTimeOffset End =
        new(2026, 11, 12, 8, 15, 0, TimeSpan.Zero);

    private static PdmDeviceProfile Profile() => new()
    {
        Id = Guid.NewGuid(), TenantId = Guid.NewGuid(),
        CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
        Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
        RunStateTelemetryKey = "run_state", RunStateIntervalSeconds = 60,
        RunStateRunningValue = 1, WindowMinutes = 15,
        MinimumCoverageRatio = 0.8
    };

    private static PdmPointPolicy Point(PdmDeviceProfile p) => new()
    {
        ProfileId = p.Id, TelemetryKey = "temperature", Unit = "°C",
        ExpectedIntervalSeconds = 60,
        MinValidValue = -40, MaxValidValue = 200,
        WarningHighValue = 80, CriticalHighValue = 100, Enabled = true, Required = true
    };

    private static List<TelemetryDataDto> History(DateTimeOffset end)
    {
        var begin = end.AddMinutes(-15);
        var list = Enumerable.Range(0, 15).Select(i => new TelemetryDataDto
        {
            KeyName = "temperature", DateTime = begin.AddMinutes(i).UtcDateTime,
            DataType = DataType.Double, Value = 55d + i / 10d
        }).ToList();
        list.Add(new TelemetryDataDto
        {
            KeyName = "run_state", DateTime = end.AddMinutes(-1).UtcDateTime,
            DataType = DataType.Boolean, Value = true
        });
        return list;
    }

    [Fact]
    public async Task VerifiedHistory_MapsUtcDataAndRunStateOnly()
    {
        var p = Profile();
        var storage = new StubStorage { Records = History(End) };
        var result = await new PdmTelemetryHistoryReader(storage)
            .ReadAsync(p, new[] { Point(p) }, End, 1000, CancellationToken.None);
        Assert.Null(result.Failure);
        Assert.Equal(PdmOperatingState.Running, result.OperatingState);
        Assert.Equal(15, result.Samples.Count);
        Assert.All(result.Samples, s =>
        {
            Assert.Equal(p.TenantId, s.TenantId);
            Assert.Equal(p.DeviceId, s.DeviceId);
            Assert.Equal("°C", s.Unit);
            Assert.Equal(TimeSpan.Zero, s.EventTime.Offset);
        });
        Assert.Equal(1, storage.Calls);
    }

    [Fact]
    public async Task UnverifiedSiteMapping_DoesNotQueryHistory()
    {
        var p = Profile();
        p.PointMappingsVerified = false;
        var storage = new StubStorage { Records = History(End) };
        var result = await new PdmTelemetryHistoryReader(storage)
            .ReadAsync(p, new[] { Point(p) }, End, 1000, CancellationToken.None);
        Assert.Equal(0, storage.Calls);
        Assert.NotNull(result.Failure);
        Assert.Equal(PdmOperatingState.Unknown, result.OperatingState);
    }

    [Fact]
    public async Task UnspecifiedProviderDateKind_RejectsHistoryInsteadOfGuessingZone()
    {
        var p = Profile();
        var data = History(End);
        data[0].DateTime = DateTime.SpecifyKind(data[0].DateTime, DateTimeKind.Unspecified);
        var result = await new PdmTelemetryHistoryReader(new StubStorage { Records = data })
            .ReadAsync(p, new[] { Point(p) }, End, 1000, CancellationToken.None);
        Assert.NotNull(result.Failure);
        Assert.Equal(PdmOperatingState.Unknown, result.OperatingState);
    }

    [Fact]
    public async Task AuditedUtcContract_CanInterpretSqlDatetimeWithoutKind()
    {
        var profile = Profile();
        var history = History(End);
        history[0].DateTime = DateTime.SpecifyKind(history[0].DateTime, DateTimeKind.Unspecified);
        var confirmed = new PdmTelemetryHistoryReader(
            new StubStorage { Records = history },
            Options.Create(new PdmWorkerOptions { HistoryUtcContractApproved = true }));
        var result = await confirmed.ReadAsync(
            profile, new[] { Point(profile) }, End, 1000, CancellationToken.None);
        Assert.Null(result.Failure);
        Assert.Equal(PdmOperatingState.Running, result.OperatingState);
        Assert.Equal(15, result.Samples.Count);
        Assert.All(result.Samples, row => Assert.Equal(TimeSpan.Zero, row.EventTime.Offset));
    }

    [Fact]
    public async Task LocalTimeKind_IsRejectedEvenWithUtcApproval()
    {
        var profile = Profile();
        var history = History(End);
        history[0].DateTime = DateTime.SpecifyKind(history[0].DateTime, DateTimeKind.Local);
        var confirmed = new PdmTelemetryHistoryReader(
            new StubStorage { Records = history },
            Options.Create(new PdmWorkerOptions { HistoryUtcContractApproved = true }));
        var result = await confirmed.ReadAsync(
            profile, new[] { Point(profile) }, End, 1000, CancellationToken.None);
        Assert.NotNull(result.Failure);
        Assert.Equal(PdmOperatingState.Unknown, result.OperatingState);
    }
    [Fact]
    public async Task ExcessHistoryRows_FailsClosedAfterProviderResponse()
    {
        var p = Profile();
        var result = await new PdmTelemetryHistoryReader(new StubStorage { Records = History(End) })
            .ReadAsync(p, new[] { Point(p) }, End, 5, CancellationToken.None);
        Assert.NotNull(result.Failure);
        Assert.Empty(result.Samples);
    }

    [Fact]
    public async Task StaleRunState_IsUnknownEvenWithValidTemperature()
    {
        var p = Profile();
        var data = History(End);
        data[^1].DateTime = End.AddMinutes(-6).UtcDateTime;
        var result = await new PdmTelemetryHistoryReader(new StubStorage { Records = data })
            .ReadAsync(p, new[] { Point(p) }, End, 1000, CancellationToken.None);
        Assert.Equal(PdmOperatingState.Unknown, result.OperatingState);
    }

    private sealed class StubStorage : IStorage, IBoundedTelemetryHistoryStorage
    {
        public List<TelemetryDataDto> Records { get; init; } = new();
        public int Calls { get; private set; }

        public Task<bool> CheckTelemetryStorage() => Task.FromResult(true);
        public Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg) =>
            throw new NotSupportedException("Read-only P1 test must never write.");
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId) =>
            throw new NotSupportedException("P1 must read history, not Latest.");
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys) =>
            throw new NotSupportedException("P1 must read history, not Latest.");
        public Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys,
            DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate) =>
            throw new InvalidOperationException("PdM must not fall back to unbounded history.");

        public Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
            Guid deviceId, IReadOnlyList<string> keys, DateTime beginUtc,
            DateTime endUtc, int maxRows, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal(DateTimeKind.Utc, beginUtc.Kind);
            Assert.Equal(DateTimeKind.Utc, endUtc.Kind);
            Assert.Contains("run_state", keys);
            Assert.Contains("temperature", keys);
            cancellationToken.ThrowIfCancellationRequested();
            if (Records.Count > maxRows)
                throw new TelemetryHistoryLimitExceededException();
            return Task.FromResult(Records);
        }
    }
}

