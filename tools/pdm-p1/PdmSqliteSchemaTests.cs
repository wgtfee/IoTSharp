using System;
using System.Linq;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Data.Configurations;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

/// <summary>
/// SQLite in-memory relational test: verify real DDL, UNIQUE, FK and durable shape.
/// Does not create or modify any user database file.
/// </summary>
public sealed class PdmSqliteSchemaTests
{
    [Fact]
    public async Task FourPdmTables_CreateInRealRelationalEngine_AndRejectDuplicateScopedProfile()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<PdmSchemaContext>()
            .UseSqlite(connection).Options;

        await using var db = new PdmSchemaContext(options);
        Assert.True(await db.Database.EnsureCreatedAsync());
        var tables = await db.Database.SqlQueryRaw<string>(
            "SELECT name AS Value FROM sqlite_master WHERE type='table' AND name LIKE 'Pdm%' ORDER BY name"
        ).ToListAsync();
        Assert.Equal(new[] { "PdmDeviceProfile", "PdmHealthSnapshot", "PdmPointPolicy", "PdmRiskEvent" }, tables);

        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var device = Guid.NewGuid();
        var profile = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device,
            Enabled = false, WindowMinutes = 15, MinimumCoverageRatio = .8
        };
        db.Profiles.Add(profile);
        await db.SaveChangesAsync();

        var duplicate = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device
        };
        db.Profiles.Add(duplicate);
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        db.ChangeTracker.Clear();

        var policy = new PdmPointPolicy
        {
            ProfileId = profile.Id, TelemetryKey = "temperature", Unit = "°C",
            ExpectedIntervalSeconds = 60, MinValidValue = 0, MaxValidValue = 150,
            WarningHighValue = 80, CriticalHighValue = 100
        };
        db.Policies.Add(policy);
        var snap = new PdmHealthSnapshot
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device,
            ProfileId = profile.Id, ProfileVersion = 1,
            WindowStartUtc = new DateTime(2026, 11, 12, 8, 0, 0, DateTimeKind.Utc),
            WindowEndUtc = new DateTime(2026, 11, 12, 8, 15, 0, DateTimeKind.Utc),
            DataQuality = "Unknown", RiskLevel = "Unknown", ExplanationJson = "{}"
        };
        db.Snapshots.Add(snap);
        await db.SaveChangesAsync();

        db.ChangeTracker.Clear();
        var loaded = await db.Snapshots.SingleAsync(x => x.TenantId == tenant && x.CustomerId == customer);
        Assert.Null(loaded.HealthIndex);
        Assert.Equal(profile.Id, loaded.ProfileId);
        Assert.Equal(1, await db.Profiles.CountAsync());
        Assert.Equal(1, await db.Policies.CountAsync());
        Assert.Equal(1, await db.Snapshots.CountAsync());
    }

    [Fact]
    public async Task UniquePointAndSnapshotKeys_PreventDuplicatePersistence()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<PdmSchemaContext>().UseSqlite(connection).Options;
        await using var db = new PdmSchemaContext(options);
        await db.Database.EnsureCreatedAsync();
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid()
        };
        db.Profiles.Add(p);
        var first = new PdmPointPolicy { ProfileId = p.Id, TelemetryKey = "temp", Unit = "°C" };
        db.Policies.Add(first);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        db.Policies.Add(new PdmPointPolicy { ProfileId = p.Id, TelemetryKey = "temp", Unit = "°C" });
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        db.ChangeTracker.Clear();

        var start = new DateTime(2026, 11, 12, 8, 0, 0, DateTimeKind.Utc);
        var end = start.AddMinutes(15);
        PdmHealthSnapshot NewSnapshot() => new()
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
            ProfileId = p.Id, ProfileVersion = 1, WindowStartUtc = start,
            WindowEndUtc = end, DataQuality = "Unknown", RiskLevel = "Unknown"
        };
        db.Snapshots.Add(NewSnapshot());
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        db.Snapshots.Add(NewSnapshot());
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    [Fact]
    public async Task RiskEventIdempotencyKey_IsUniqueWithinTenantAndCustomer()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<PdmSchemaContext>().UseSqlite(connection).Options;
        await using var db = new PdmSchemaContext(options);
        await db.Database.EnsureCreatedAsync();
        var profile = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid()
        };
        db.Profiles.Add(profile);
        await db.SaveChangesAsync();
        PdmRiskEvent NewEvent() => new()
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            DeviceId = profile.DeviceId, ProfileId = profile.Id,
            EventKey = "episode-synthetic-0001", RiskType = "temperature-trend",
            RiskLevel = "Attention", FirstObservedUtc = DateTime.UtcNow,
            LastObservedUtc = DateTime.UtcNow
        };
        db.RiskEvents.Add(NewEvent());
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        db.RiskEvents.Add(NewEvent());
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        db.ChangeTracker.Clear();
        Assert.Equal(1, await db.RiskEvents.CountAsync());
    }
    private sealed class PdmSchemaContext : DbContext
    {
        public PdmSchemaContext(DbContextOptions<PdmSchemaContext> options) : base(options) { }

        public DbSet<PdmDeviceProfile> Profiles => Set<PdmDeviceProfile>();
        public DbSet<PdmPointPolicy> Policies => Set<PdmPointPolicy>();
        public DbSet<PdmHealthSnapshot> Snapshots => Set<PdmHealthSnapshot>();
        public DbSet<PdmRiskEvent> RiskEvents => Set<PdmRiskEvent>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.ApplyConfiguration(new PdmDeviceProfileConfiguration());
            modelBuilder.ApplyConfiguration(new PdmPointPolicyConfiguration());
            modelBuilder.ApplyConfiguration(new PdmHealthSnapshotConfiguration());
            modelBuilder.ApplyConfiguration(new PdmRiskEventConfiguration());
        }
    }
}

