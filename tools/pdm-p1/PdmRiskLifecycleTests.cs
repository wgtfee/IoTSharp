using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

public sealed class PdmRiskLifecycleTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 11, 12, 8, 0, 0, TimeSpan.Zero);

    private static PdmDeviceProfile Profile() => new()
    {
        Id = Guid.NewGuid(), TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
        DeviceId = Guid.NewGuid(), Enabled = true,
        PointMappingsVerified = true, RunStateVerified = true,
        RunStateTelemetryKey = "run_state", WindowMinutes = 15,
        MinimumCoverageRatio = 0.8, Version = 1
    };

    private static PdmPointPolicy Point(PdmDeviceProfile p) => new()
    {
        ProfileId = p.Id, TelemetryKey = "temperature", Unit = "°C", Required = true,
        Enabled = true, ExpectedIntervalSeconds = 60,
        MinValidValue = -40, MaxValidValue = 200,
        WarningHighValue = 80, CriticalHighValue = 100,
        Weight = 1, RisingTrendPerMinute = 0.5
    };

    private static async Task<(SqliteConnection connection, DbContextOptions<PdmDbContext> options, PdmDeviceProfile profile)>
        CreateAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<PdmDbContext>().UseSqlite(connection).Options;
        await using var db = new PdmDbContext(options);
        await db.Database.EnsureCreatedAsync();
        var profile = Profile();
        db.DeviceProfiles.Add(profile);
        db.PointPolicies.Add(Point(profile));
        await db.SaveChangesAsync();
        return (connection, options, profile);
    }

    private static PdmCycleProcessor Processor(
        PdmDbContext context, PdmDeviceProfile profile, double temp,
        PdmOperatingState state = PdmOperatingState.Running)
    {
        var reader = new FakeHistoryReader(profile, temp, state);
        return new PdmCycleProcessor(context, reader, new PdmHealthEvaluator());
    }

    [Fact]
    public async Task DuplicateWindow_IsIdempotentAndRestartsRestoreSameOpenRisk()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        {
            await using (var db = new PdmDbContext(options))
            {
                var processor = Processor(db, p, 105);
                var first = await processor.ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 3);
                Assert.True(first.Committed);
                Assert.Equal(PdmRiskTransitionKind.Opened, first.RiskTransition);
                var again = await processor.ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 3);
                Assert.True(again.DuplicateWindow);
                Assert.Equal(1, await db.RiskEvents.CountAsync());
                Assert.Equal(1, (await db.RiskEvents.SingleAsync()).OccurrenceCount);
            }
            // New DbContext / processor simulates process restart after committed state.
            await using (var db = new PdmDbContext(options))
            {
                var second = await Processor(db, p, 95)
                    .ProcessAsync(p.Id, T0.AddMinutes(30), 4, 1000, 3);
                Assert.Equal(PdmRiskTransitionKind.Updated, second.RiskTransition);
                Assert.Equal(1, await db.RiskEvents.CountAsync());
                Assert.Equal(2, (await db.RiskEvents.SingleAsync()).OccurrenceCount);
                Assert.Equal(2, await db.HealthSnapshots.CountAsync());
            }
        }
    }

    [Fact]
    public async Task ThreeContiguousNormalWindows_ClearRisk_ThenNextEpisodeIsNew()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        await using (var db = new PdmDbContext(options))
        {
            Assert.Equal(PdmRiskTransitionKind.Opened,
                (await Processor(db, p, 105).ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 3)).RiskTransition);
            var normal = Processor(db, p, 50);
            Assert.Equal(PdmRiskTransitionKind.RecoveryPending,
                (await normal.ProcessAsync(p.Id, T0.AddMinutes(30), 4, 1000, 3)).RiskTransition);
            Assert.Equal(PdmRiskTransitionKind.RecoveryPending,
                (await normal.ProcessAsync(p.Id, T0.AddMinutes(45), 4, 1000, 3)).RiskTransition);
            Assert.Equal(PdmRiskTransitionKind.Cleared,
                (await normal.ProcessAsync(p.Id, T0.AddMinutes(60), 4, 1000, 3)).RiskTransition);
            var event1 = await db.RiskEvents.SingleAsync();
            Assert.Equal("Cleared", event1.Status);
            Assert.Equal(T0.AddMinutes(60).UtcDateTime, event1.ClearedAtUtc);
            Assert.Equal(1, event1.OccurrenceCount);

            var next = await Processor(db, p, 105)
                .ProcessAsync(p.Id, T0.AddMinutes(75), 4, 1000, 3);
            Assert.Equal(PdmRiskTransitionKind.Opened, next.RiskTransition);
            Assert.Equal(2, await db.RiskEvents.CountAsync());
            Assert.Equal(2, await db.RiskEvents.Select(x => x.EventKey).Distinct().CountAsync());
        }
    }

    [Fact]
    public async Task UnknownData_PreservesOpenEventAndNeverClears()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        await using (var db = new PdmDbContext(options))
        {
            await Processor(db, p, 105).ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 2);
            var held = await Processor(db, p, 60, PdmOperatingState.Offline)
                .ProcessAsync(p.Id, T0.AddMinutes(30), 4, 1000, 2);
            Assert.Equal(PdmRiskTransitionKind.HeldForUnknown, held.RiskTransition);
            Assert.Equal(PdmRiskLevel.Unknown, held.Risk);
            Assert.Null((await db.HealthSnapshots.SingleAsync(x => x.WindowEndUtc ==
                T0.AddMinutes(30).UtcDateTime)).HealthIndex);
            Assert.Equal("Open", (await db.RiskEvents.SingleAsync()).Status);
        }
    }

    [Fact]
    public async Task GappedRecovery_RestartsStreakAndOldWindowCannotRewind()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        await using (var db = new PdmDbContext(options))
        {
            await Processor(db, p, 105).ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 2);
            var normal = Processor(db, p, 50);
            await normal.ProcessAsync(p.Id, T0.AddMinutes(30), 4, 1000, 2);
            var afterGap = await normal.ProcessAsync(p.Id, T0.AddMinutes(60), 4, 1000, 2);
            Assert.Equal(PdmRiskTransitionKind.RecoveryPending, afterGap.RiskTransition);
            Assert.Equal(1, (await db.RiskEvents.SingleAsync()).RecoveryStreak);
            var rewind = await normal.ProcessAsync(p.Id, T0.AddMinutes(45), 4, 1000, 2);
            Assert.False(rewind.Committed);
            Assert.Equal("Open", (await db.RiskEvents.SingleAsync()).Status);
        }
    }

    [Fact]
    public async Task MissingVerifiedSource_DoesNotReadOrWrite()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        await using (var db = new PdmDbContext(options))
        {
            var entity = await db.DeviceProfiles.SingleAsync();
            entity.RunStateVerified = false;
            await db.SaveChangesAsync();
            var fake = new FakeHistoryReader(p, 105);
            var worker = new PdmCycleProcessor(db, fake, new PdmHealthEvaluator());
            var result = await worker.ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 3);
            Assert.False(result.Committed);
            Assert.Equal(0, fake.Calls);
            Assert.Equal(0, await db.HealthSnapshots.CountAsync());
            Assert.Equal(0, await db.RiskEvents.CountAsync());
        }
    }

    [Fact]
    public async Task MixedTenantReaderData_CannotGenerateRiskEvent()
    {
        var (connection, options, p) = await CreateAsync();
        await using (connection)
        await using (var db = new PdmDbContext(options))
        {
            var reader = new FakeHistoryReader(p, 105) { CrossTenant = true };
            var result = await new PdmCycleProcessor(db, reader, new PdmHealthEvaluator())
                .ProcessAsync(p.Id, T0.AddMinutes(15), 4, 1000, 3);
            Assert.True(result.Committed);
            Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
            Assert.Equal(0, await db.RiskEvents.CountAsync());
            Assert.Null((await db.HealthSnapshots.SingleAsync()).HealthIndex);
        }
    }

    [Fact]
    public async Task RiskEventIdentity_IsScopedByVersionAndUtcEpisode()
    {
        var p = Profile();
        var k1 = PdmRiskEventTransitions.EventKey(p, T0.UtcDateTime);
        Assert.Equal(k1, PdmRiskEventTransitions.EventKey(p, T0.UtcDateTime));
        p.Version++;
        Assert.NotEqual(k1, PdmRiskEventTransitions.EventKey(p, T0.UtcDateTime));
        Assert.Throws<ArgumentException>(() => PdmRiskEventTransitions.EventKey(p, T0.LocalDateTime));
        await Task.CompletedTask;
    }

    private sealed class FakeHistoryReader : IPdmHistoryReader
    {
        private readonly PdmDeviceProfile _profile;
        private readonly double _temperature;
        private readonly PdmOperatingState _operatingState;

        public int Calls { get; private set; }
        public bool CrossTenant { get; init; }

        public FakeHistoryReader(PdmDeviceProfile p, double temp,
            PdmOperatingState state = PdmOperatingState.Running)
        {
            _profile = p;
            _temperature = temp;
            _operatingState = state;
        }

        public Task<PdmHistoryWindow> ReadAsync(PdmDeviceProfile profile,
            IReadOnlyList<PdmPointPolicy> policies, DateTimeOffset end, int maxRows,
            CancellationToken cancellationToken)
        {
            Calls++;
            var start = end.AddMinutes(-15);
            var rows = Enumerable.Range(0, 15).Select(i =>
                new PdmTelemetrySample(CrossTenant && i == 1 ? Guid.NewGuid() : _profile.TenantId,
                    _profile.CustomerId, _profile.DeviceId, "temperature",
                    start.AddMinutes(i), _temperature, "°C")).ToArray();
            return Task.FromResult(new PdmHistoryWindow(rows, _operatingState, null));
        }
    }
}

