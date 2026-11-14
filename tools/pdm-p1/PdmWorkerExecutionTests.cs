using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

public sealed class PdmWorkerExecutionTests
{
    [Fact]
    public async Task Worker_ProcessesVerifiedDevicesInSeparateScopes_AndContinuesAfterReaderError()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var failedDevice = Guid.NewGuid();
        using var provider = BuildProvider(connection, failedDevice);
        await using (var init = provider.CreateAsyncScope())
        {
            var db = init.ServiceProvider.GetRequiredService<PdmDbContext>();
            await db.Database.EnsureCreatedAsync();
            AddProfile(db, failedDevice);
            AddProfile(db, Guid.NewGuid());
            await db.SaveChangesAsync();
        }

        var options = EnabledOptions();
        var worker = new PdmEvaluationWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(options),
            NullLogger<PdmEvaluationWorker>.Instance);

        await worker.RunCycleAsync();
        await using (var resultScope = provider.CreateAsyncScope())
        {
            var db = resultScope.ServiceProvider.GetRequiredService<PdmDbContext>();
            Assert.Equal(1, await db.HealthSnapshots.CountAsync());
            Assert.Equal(1, await db.RiskEvents.CountAsync());
            Assert.NotEqual(failedDevice, (await db.HealthSnapshots.SingleAsync()).DeviceId);
        }
        // Same configured profile window: repeated poll must not create more events.
        await worker.RunCycleAsync();
        await using (var checkScope = provider.CreateAsyncScope())
        {
            var db = checkScope.ServiceProvider.GetRequiredService<PdmDbContext>();
            Assert.Equal(1, await db.HealthSnapshots.CountAsync());
            Assert.Equal(1, (await db.RiskEvents.SingleAsync()).OccurrenceCount);
        }
    }

    [Fact]
    public async Task Worker_MissingSchema_FailsBeforeFetchingHistory()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        using var provider = BuildProvider(connection, Guid.Empty);
        var worker = new PdmEvaluationWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(EnabledOptions()),
            NullLogger<PdmEvaluationWorker>.Instance);
        await Assert.ThrowsAnyAsync<Exception>(() => worker.RunCycleAsync());
        Assert.Equal(0, provider.GetRequiredService<StubHistory>().Calls);
    }

    private static PdmWorkerOptions EnabledOptions() => new()
    {
        Enabled = true, SchemaReady = true, SingleInstanceAcknowledged = true,
        PointMappingsApproved = true, HistoryQueryPlanApproved = true,
        HistoryUtcContractApproved = true, MaxProfilesPerCycle = 5,
        MaxPointsPerDevice = 3, MaxHistoryRowsPerDevice = 500, RecoveryConsecutiveWindows = 2
    };

    private static void AddProfile(PdmDbContext db, Guid deviceId)
    {
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = deviceId,
            Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
            RunStateTelemetryKey = "run_state", WindowMinutes = 15,
            MinimumCoverageRatio = 0.8
        };
        db.DeviceProfiles.Add(p);
        db.PointPolicies.Add(new PdmPointPolicy
        {
            ProfileId = p.Id, TelemetryKey = "temperature", Unit = "°C",
            Enabled = true, Required = true,
            ExpectedIntervalSeconds = 60, MinValidValue = 0, MaxValidValue = 200,
            WarningHighValue = 80, CriticalHighValue = 100, Weight = 1
        });
    }

    private static ServiceProvider BuildProvider(SqliteConnection connection, Guid failedDevice)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(new StubHistory(failedDevice));
        services.AddScoped<IPdmHistoryReader>(sp => sp.GetRequiredService<StubHistory>());
        services.AddSingleton<PdmHealthEvaluator>();
        services.AddDbContext<PdmDbContext>(b => b.UseSqlite(connection));
        services.AddScoped<PdmCycleProcessor>();
        return services.BuildServiceProvider(validateScopes: true);
    }

    private sealed class StubHistory : IPdmHistoryReader
    {
        private readonly Guid _failedDevice;
        public int Calls { get; private set; }

        public StubHistory(Guid failedDevice) => _failedDevice = failedDevice;

        public Task<PdmHistoryWindow> ReadAsync(PdmDeviceProfile profile,
            IReadOnlyList<PdmPointPolicy> policies, DateTimeOffset end,
            int maximumRows, CancellationToken cancellationToken)
        {
            Calls++;
            if (profile.DeviceId == _failedDevice)
                throw new InvalidOperationException("synthetic per-device read failure");
            var start = end.AddMinutes(-profile.WindowMinutes);
            var data = Enumerable.Range(0, profile.WindowMinutes)
                .Select(i => new PdmTelemetrySample(profile.TenantId, profile.CustomerId,
                    profile.DeviceId, "temperature", start.AddMinutes(i), 110d, "°C")).ToArray();
            return Task.FromResult(new PdmHistoryWindow(data, PdmOperatingState.Running, null));
        }
    }
}

