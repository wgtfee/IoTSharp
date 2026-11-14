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

public sealed class PdmQueryTimeoutTests
{
    [Fact]
    public async Task OneDeviceQueryTimesOut_OtherDeviceStillProducesHealthSnapshot()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var reader = new SlowAndFastReader();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(reader);
        services.AddScoped<IPdmHistoryReader>(sp => sp.GetRequiredService<SlowAndFastReader>());
        services.AddSingleton<PdmHealthEvaluator>();
        services.AddDbContext<PdmDbContext>(db => db.UseSqlite(connection));
        services.AddScoped<PdmCycleProcessor>();
        using var provider = services.BuildServiceProvider(validateScopes: true);
        await using (var scope = provider.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
            await db.Database.EnsureCreatedAsync();
            CreateDevice(db);
            CreateDevice(db);
            await db.SaveChangesAsync();
            reader.SlowDevice = (await db.DeviceProfiles.OrderBy(p => p.Id).FirstAsync()).DeviceId;
        }
        var worker = new PdmEvaluationWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PdmWorkerOptions
            {
                Enabled = true, SchemaReady = true,
                PointMappingsApproved = true, SingleInstanceAcknowledged = true,
                HistoryQueryPlanApproved = true, HistoryUtcContractApproved = true,
                MaxProfilesPerCycle = 5, HistoryQueryTimeoutSeconds = 1,
                MaxHistoryRowsPerDevice = 1000, MaxPointsPerDevice = 3
            }),
            NullLogger<PdmEvaluationWorker>.Instance);

        await worker.RunCycleAsync();

        await using var verify = provider.CreateAsyncScope();
        var context = verify.ServiceProvider.GetRequiredService<PdmDbContext>();
        var list = await context.HealthSnapshots.AsNoTracking().ToListAsync();
        Assert.Single(list);
        Assert.NotEqual(reader.SlowDevice, list[0].DeviceId);
        Assert.True(reader.SlowWasCancelled);
        Assert.Equal(2, reader.Calls);
    }

    private static void CreateDevice(PdmDbContext db)
    {
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
            DeviceId = Guid.NewGuid(), Enabled = true, WindowMinutes = 15,
            PointMappingsVerified = true, RunStateVerified = true,
            RunStateTelemetryKey = "run_state", MinimumCoverageRatio = 0.8
        };
        db.DeviceProfiles.Add(p);
        db.PointPolicies.Add(new PdmPointPolicy
        {
            ProfileId = p.Id, Enabled = true, Required = true, TelemetryKey = "temp",
            Unit = "°C", ExpectedIntervalSeconds = 60, MinValidValue = 0,
            MaxValidValue = 200, Weight = 1, WarningHighValue = 80, CriticalHighValue = 100
        });
    }

    private sealed class SlowAndFastReader : IPdmHistoryReader
    {
        public Guid SlowDevice { get; set; }
        public bool SlowWasCancelled { get; private set; }
        public int Calls { get; private set; }

        public async Task<PdmHistoryWindow> ReadAsync(
            PdmDeviceProfile p, IReadOnlyList<PdmPointPolicy> policies,
            DateTimeOffset end, int maximumRows, CancellationToken token)
        {
            Calls++;
            if (p.DeviceId == SlowDevice)
            {
                try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
                catch (OperationCanceledException)
                {
                    SlowWasCancelled = true;
                    throw;
                }
            }
            var begin = end.AddMinutes(-15);
            var samples = Enumerable.Range(0, 15)
                .Select(i => new PdmTelemetrySample(p.TenantId, p.CustomerId,
                    p.DeviceId, "temp", begin.AddMinutes(i), 55d, "°C"))
                .ToArray();
            return new PdmHistoryWindow(samples, PdmOperatingState.Running, null);
        }
    }
}

