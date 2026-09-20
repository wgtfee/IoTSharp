using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.Test;

public sealed class TelemetryHistoryCapabilityTests
{
    [Fact]
    public void ShardingStorage_AdvertisesRowReplay_OnlyForVerifiedMonthlyNativeWriterPaths()
    {
        using var services = new ServiceCollection().BuildServiceProvider();
        var scopeFactory = services.GetRequiredService<IServiceScopeFactory>();

        var sqlServerMonthly = CreateShardingSettings(DataBaseType.SqlServer, ShardingByDateMode.PerMonth);
        var sqlServerDaily = CreateShardingSettings(DataBaseType.SqlServer, ShardingByDateMode.PerDay);
        var postgreSqlMonthly = CreateShardingSettings(DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);
        var postgreSqlDaily = CreateShardingSettings(DataBaseType.PostgreSql, ShardingByDateMode.PerDay);

        Assert.True(CreateShardingStorage(sqlServerMonthly, scopeFactory).SupportsTelemetryHistoryRowReplay);
        Assert.False(CreateShardingStorage(sqlServerDaily, scopeFactory).SupportsTelemetryHistoryRowReplay);
        Assert.True(CreateShardingStorage(postgreSqlMonthly, scopeFactory).SupportsTelemetryHistoryRowReplay);
        Assert.False(CreateShardingStorage(postgreSqlDaily, scopeFactory).SupportsTelemetryHistoryRowReplay);
    }

    [Theory]
    [InlineData(DataBaseType.SqlServer)]
    [InlineData(DataBaseType.PostgreSql)]
    public void ShardingStorage_RowReplayRequiresTelemetryStorageConnection(DataBaseType database)
    {
        using var services = new ServiceCollection().BuildServiceProvider();
        var scopeFactory = services.GetRequiredService<IServiceScopeFactory>();
        var settings = CreateShardingSettings(database, ShardingByDateMode.PerMonth);
        settings.ConnectionStrings!.Remove("TelemetryStorage");

        Assert.False(CreateShardingStorage(settings, scopeFactory).SupportsTelemetryHistoryRowReplay);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CompositeTelemetryStorage_ForwardsHistoryRowReplayCapability(bool supported)
    {
        var history = new FakeHistoryStorage(supported);
        var composite = new CompositeTelemetryStorage(history, new FakeLatestStore());

        Assert.Equal(supported, composite.SupportsTelemetryHistoryRowReplay);

        var result = await composite.StoreTelemetryHistoryRowsAsync([new TelemetryData()], 1);
        Assert.Equal(supported, result.Result);
        Assert.Equal(supported ? 1 : 0, history.RowReplayCalls);
    }

    private static ShardingStorage CreateShardingStorage(AppSettings settings, IServiceScopeFactory scopeFactory)
        => new(
            NullLogger<ShardingStorage>.Instance,
            scopeFactory,
            Options.Create(settings));

    private static AppSettings CreateShardingSettings(DataBaseType database, ShardingByDateMode shardingMode)
    {
        var connectionString = database == DataBaseType.PostgreSql
            ? "Host=localhost;Database=IoTSharp;Username=test;Password=test"
            : "Server=localhost;Database=IoTSharp;User Id=test;Password=test;TrustServerCertificate=True";

        return new AppSettings
        {
            DataBase = database,
            TelemetryStorage = TelemetryStorage.Sharding,
            TelemetryHistoryStorage = TelemetryStorage.Sharding,
            ShardingByDateMode = shardingMode,
            ConnectionStrings = new Dictionary<string, string>
            {
                ["TelemetryStorage"] = connectionString
            }
        };
    }

    private sealed class FakeHistoryStorage(bool supportsReplay) : IStorage, ITelemetryHistoryRowStorage
    {
        public int RowReplayCalls { get; private set; }
        public bool SupportsTelemetryHistoryRowReplay => supportsReplay;

        public Task<bool> CheckTelemetryStorage() => Task.FromResult(true);

        public Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
            => Task.FromResult<(bool, List<TelemetryData>)>((true, []));

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
            => Task.FromResult(new List<TelemetryDataDto>());

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
            => Task.FromResult(new List<TelemetryDataDto>());

        public Task<List<TelemetryDataDto>> LoadTelemetryAsync(
            Guid deviceId,
            string keys,
            DateTime begin,
            DateTime end,
            TimeSpan every,
            Aggregate aggregate)
            => Task.FromResult(new List<TelemetryDataDto>());

        public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(
            IReadOnlyCollection<TelemetryData> rows,
            int messageCount)
        {
            RowReplayCalls++;
            return Task.FromResult(new TelemetryBatchStoreResult(true, rows.ToList(), messageCount));
        }
    }

    private sealed class FakeLatestStore : IRelationalTelemetryLatestStore
    {
        public Task<bool> CheckAsync() => Task.FromResult(true);
        public Task<bool> StoreBatchAsync(IReadOnlyCollection<PlayloadData> messages) => Task.FromResult(true);
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
            => Task.FromResult(new List<TelemetryDataDto>());
        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
            => Task.FromResult(new List<TelemetryDataDto>());
    }
}
