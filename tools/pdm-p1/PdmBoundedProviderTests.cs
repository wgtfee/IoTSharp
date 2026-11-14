using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Contracts;
using IoTSharp.Data.Configurations;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

/// <summary>Real SQLite row budget; offline SqlServer/PostgreSql SQL generation; safe Flux shape.</summary>
public sealed class PdmBoundedProviderTests
{
    private static readonly Guid DeviceId = Guid.NewGuid();
    private static readonly DateTime Start = new(2026, 11, 12, 8, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime End = Start.AddMinutes(15);
    private static readonly string[] Keys = ["temperature", "run_state"];

    [Fact]
    public void SqlServerAndPostgreSqlTranslateRowLimitIntoSql()
    {
        var sqlServerOptions = new DbContextOptionsBuilder<TelemetryTestContext>()
            .UseSqlServer("Server=localhost;Database=pdm_ddl_only;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;
        using (var sqlServer = new TelemetryTestContext(sqlServerOptions))
        {
            var sql = BoundedTelemetryHistoryQuery.Build(
                sqlServer.Rows, DeviceId, Keys, Start, End, 200).ToQueryString();
            Assert.Contains("TOP(", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("DeviceId", sql);
            Assert.Contains("KeyName", sql);
            Assert.DoesNotContain("Value_Binary", sql);
            Assert.DoesNotContain("Value_Json", sql);
            Assert.DoesNotContain("Value_XML", sql);
        }
        var postgresOptions = new DbContextOptionsBuilder<TelemetryTestContext>()
            .UseNpgsql("Host=localhost;Database=pdm_ddl_only;Username=offline")
            .Options;
        using (var postgres = new TelemetryTestContext(postgresOptions))
        {
            var sql = BoundedTelemetryHistoryQuery.Build(
                postgres.Rows, DeviceId, Keys, Start, End, 200).ToQueryString();
            Assert.Contains("LIMIT", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("DeviceId", sql);
            Assert.Contains("KeyName", sql);
            Assert.DoesNotContain("Value_Binary", sql);
            Assert.DoesNotContain("Value_Json", sql);
            Assert.DoesNotContain("Value_XML", sql);
        }
    }

    [Fact]
    public async Task SqliteActuallyReturnsAtMostLimitPlusOne_AndRejectsTruncation()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        var options = new DbContextOptionsBuilder<TelemetryTestContext>().UseSqlite(con).Options;
        await using var db = new TelemetryTestContext(options);
        await db.Database.EnsureCreatedAsync();
        for (int i = 0; i < 9; i++)
        {
            db.Rows.Add(new TelemetryData
            {
                DeviceId = DeviceId, KeyName = "temperature",
                DateTime = Start.AddMinutes(i), Type = IoTSharp.Contracts.DataType.Double,
                Value_Double = i + 1,
                Value_Binary = i == 0 ? new byte[65536] : null,
                Value_Json = i == 0 ? new string('x', 8192) : null
            });
        }
        db.Rows.Add(new TelemetryData { DeviceId = Guid.NewGuid(), KeyName = "temperature",
            DateTime = Start.AddMinutes(1), Value_Double = 777 });
        db.Rows.Add(new TelemetryData { DeviceId = DeviceId, KeyName = "other",
            DateTime = Start.AddMinutes(1), Value_Double = 888 });
        db.Rows.Add(new TelemetryData { DeviceId = DeviceId, KeyName = "temperature",
            DateTime = End, Value_Double = 999 });
        await db.SaveChangesAsync();

        var query = BoundedTelemetryHistoryQuery.Build(
            db.Rows.AsNoTracking(), DeviceId, Keys, Start, End, 5);
        Assert.Contains("LIMIT", query.ToQueryString(), StringComparison.OrdinalIgnoreCase);
        var limited = await query.ToListAsync();
        Assert.Equal(6, limited.Count);
        Assert.Throws<TelemetryHistoryLimitExceededException>(() =>
            BoundedTelemetryHistoryQuery.CompleteOrThrow(
                limited.Select(x => new IoTSharp.Contracts.TelemetryDataDto
                    { KeyName = x.KeyName, DateTime = x.DateTime, Value = x.Value_Double }).ToList(), 5));
        var enough = await BoundedTelemetryHistoryQuery.Build(
            db.Rows.AsNoTracking(), DeviceId, Keys, Start, End, 10).ToListAsync();
        Assert.Equal(9, enough.Count);
        Assert.All(enough, x => { Assert.Null(x.Value_Binary); Assert.Null(x.Value_Json); });
        Assert.All(enough, x => Assert.True(x.DateTime < End));
    }

    [Fact]
    public async Task SqliteEfQueryCancellation_IsForwarded()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        var options = new DbContextOptionsBuilder<TelemetryTestContext>().UseSqlite(con).Options;
        await using var db = new TelemetryTestContext(options);
        await db.Database.EnsureCreatedAsync();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            BoundedTelemetryHistoryQuery.Build(
                db.Rows.AsNoTracking(), DeviceId, Keys, Start, End, 5)
                .ToListAsync(cts.Token));
    }

    [Fact]
    public void FluxHasGlobalLimitAfterSeriesGroupAndNoUnsanitizedFieldInterpolation()
    {
        var flux = PdmBoundedFluxBuilder.Build("iotsharp-bucket", DeviceId, Keys, Start, End, 200);
        var group = flux.IndexOf("group(columns: [])", StringComparison.Ordinal);
        var limit = flux.LastIndexOf("limit(n: 201)", StringComparison.Ordinal);
        Assert.True(group >= 0 && limit > group);
        Assert.Contains("contains(value: r[\"_field\"]", flux);
        Assert.Contains("range(start: time", flux);
        Assert.Contains("2026-11-12T08:00:00", flux);
        Assert.DoesNotContain("aggregateWindow", flux);
        Assert.Throws<ArgumentException>(() =>
            PdmBoundedFluxBuilder.Build("bad\"bucket", DeviceId, Keys, Start, End, 200));
        Assert.Throws<ArgumentException>(() =>
            PdmBoundedFluxBuilder.Build("iotsharp", DeviceId, ["temperature\"); drop"], Start, End, 200));
    }


    [Fact]
    public void FluxLimitsEachSeriesBeforeGlobalGroup_AndNormalizesTypes()
    {
        var flux = PdmBoundedFluxBuilder.Build("iotsharp-bucket", DeviceId, Keys, Start, End, 200);
        var conversion = flux.IndexOf("map(fn: (r) => ({ r with _value: string(v: r._value) }))", StringComparison.Ordinal);
        var firstLimit = flux.IndexOf("limit(n: 201)", StringComparison.Ordinal);
        var grouped = flux.IndexOf("group(columns: [])", StringComparison.Ordinal);
        var lastLimit = flux.LastIndexOf("limit(n: 201)", StringComparison.Ordinal);
        Assert.True(conversion > 0 && conversion < firstLimit &&
                    firstLimit < grouped && grouped < lastLimit);
        Assert.Equal(2, flux.Split("limit(n: 201)", StringSplitOptions.None).Length - 1);
    }

    [Theory]
    [InlineData("true", "Boolean")]
    [InlineData("FALSE", "Boolean")]
    [InlineData("123456", "Long")]
    [InlineData("-32", "Long")]
    [InlineData("5.75", "Double")]
    [InlineData("2.5e-3", "Double")]
    public void FluxNormalizedNumericBooleanValues_RoundTripUnderInvariantCulture(
        string raw, string expectedType)
    {
        var parsed = PdmFluxValueParser.Parse(raw);
        Assert.Equal(expectedType, parsed.Type.ToString());
    }

    [Theory]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("not-a-number")]
    [InlineData("1,25")]
    [InlineData("")]
    public void FluxInvalidOrNonFiniteNumericValues_AreRejected(string raw)
    {
        Assert.Throws<InvalidOperationException>(() => PdmFluxValueParser.Parse(raw));
    }

    [Fact]
    public void FluxLocalTimeKind_IsNeverSilentlyRelabelledAsUtc()
    {
        var utc = new DateTime(2026, 11, 12, 8, 15, 0, DateTimeKind.Utc);
        var unspecified = DateTime.SpecifyKind(utc, DateTimeKind.Unspecified);
        Assert.Equal(DateTimeKind.Utc, PdmFluxValueParser.RequireUtcInstant(utc).Kind);
        Assert.Equal(utc.Ticks, PdmFluxValueParser.RequireUtcInstant(unspecified).Ticks);
        Assert.Throws<InvalidOperationException>(() =>
            PdmFluxValueParser.RequireUtcInstant(DateTime.SpecifyKind(utc, DateTimeKind.Local)));
    }
    [Fact]
    public void InvalidWindowsAndKeysFailBeforeAnyDatabaseQuery()
    {
        Assert.ThrowsAny<ArgumentException>(() =>
            BoundedTelemetryHistoryQuery.Validate(DeviceId, Keys, DateTime.SpecifyKind(Start, DateTimeKind.Unspecified), End, 5));
        Assert.ThrowsAny<ArgumentException>(() =>
            BoundedTelemetryHistoryQuery.Validate(DeviceId, Keys, End, Start, 5));
        Assert.ThrowsAny<ArgumentException>(() =>
            BoundedTelemetryHistoryQuery.Validate(DeviceId, Keys, Start, End.AddHours(2), 5));
        Assert.ThrowsAny<ArgumentException>(() =>
            BoundedTelemetryHistoryQuery.Validate(DeviceId, ["temperature", "temperature"], Start, End, 5));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            BoundedTelemetryHistoryQuery.Validate(DeviceId, Keys, Start, End, 0));
    }

    [Fact]
    public async Task UnsupportedHistoryProviderFailsClosedWithoutUsingLegacyUnboundedCall()
    {
        var profile = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = DeviceId,
            PointMappingsVerified = true, RunStateVerified = true, Enabled = true,
            RunStateTelemetryKey = "run_state", WindowMinutes = 15
        };
        var point = new PdmPointPolicy
        {
            ProfileId = profile.Id, TelemetryKey = "temperature", Unit = "°C", Enabled = true
        };
        var storage = new UnboundedOnlyStorage();
        var result = await new PdmTelemetryHistoryReader(storage)
            .ReadAsync(profile, [point], new DateTimeOffset(End), 200, CancellationToken.None);
        Assert.Equal(PdmOperatingState.Unknown, result.OperatingState);
        Assert.NotNull(result.Failure);
        Assert.Equal(0, storage.LegacyCalls);
    }

    private sealed class UnboundedOnlyStorage : IStorage
    {
        public int LegacyCalls { get; private set; }
        public Task<bool> CheckTelemetryStorage() => Task.FromResult(true);
        public Task<(bool result, System.Collections.Generic.List<TelemetryData> telemetries)>
            StoreTelemetryAsync(PlayloadData msg) => throw new NotSupportedException();
        public Task<System.Collections.Generic.List<IoTSharp.Contracts.TelemetryDataDto>>
            GetTelemetryLatest(Guid deviceId) => throw new NotSupportedException();
        public Task<System.Collections.Generic.List<IoTSharp.Contracts.TelemetryDataDto>>
            GetTelemetryLatest(Guid deviceId, string keys) => throw new NotSupportedException();
        public Task<System.Collections.Generic.List<IoTSharp.Contracts.TelemetryDataDto>>
            LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin,
                DateTime end, TimeSpan every, Aggregate aggregate)
        {
            LegacyCalls++;
            throw new InvalidOperationException("Legacy unbounded API must never be called by PdM.");
        }
    }

    private sealed class TelemetryTestContext : DbContext
    {
        public TelemetryTestContext(DbContextOptions<TelemetryTestContext> options) : base(options) { }
        public DbSet<TelemetryData> Rows => Set<TelemetryData>();
        protected override void OnModelCreating(ModelBuilder builder)
        {
            builder.ApplyConfiguration(new TelemetryDataConfiguration());
        }
    }
}

