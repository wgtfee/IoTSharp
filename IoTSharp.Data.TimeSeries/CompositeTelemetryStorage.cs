using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace IoTSharp.Storage;

/// <summary>
/// Latest-value contract used by mixed telemetry deployments.
/// </summary>
public interface IRelationalTelemetryLatestStore
{
    Task<bool> CheckAsync();
    Task<bool> StoreBatchAsync(IReadOnlyCollection<PlayloadData> messages);
    Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId);
    Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys);
}

/// <summary>
/// Keeps history in the selected time-series provider while maintaining latest values
/// in the business relational database. There is intentionally no distributed transaction
/// across the two stores; latest is written first because it is idempotent and safe to retry.
/// </summary>
public sealed class CompositeTelemetryStorage : IStorage, ISplitTelemetryBatchStorage
{
    private readonly IStorage _historyStorage;
    private readonly IRelationalTelemetryLatestStore _latestStore;

    private ITelemetryHistoryRowStorage? HistoryRowStorage
        => _historyStorage as ITelemetryHistoryRowStorage;

    public CompositeTelemetryStorage(IStorage historyStorage, IRelationalTelemetryLatestStore latestStore)
    {
        _historyStorage = historyStorage;
        _latestStore = latestStore;
    }

    public bool SupportsTelemetryHistoryRowReplay
        => HistoryRowStorage?.SupportsTelemetryHistoryRowReplay == true;

    public async Task<TelemetryBatchStoreResult> StoreTelemetryLatestBatchAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
            return new TelemetryBatchStoreResult(true, [], 0);

        var ok = await _latestStore.StoreBatchAsync(messages);
        return new TelemetryBatchStoreResult(ok, [], messages.Count);
    }

    public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (_historyStorage is ISplitTelemetryBatchStorage splitStorage)
            return splitStorage.StoreTelemetryHistoryBatchAsync(messages);

        return _historyStorage.StoreTelemetryBatchAsync(messages);
    }

    public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(
        IReadOnlyCollection<TelemetryData> rows,
        int messageCount)
    {
        if (HistoryRowStorage is { SupportsTelemetryHistoryRowReplay: true } rowStorage)
        {
            return rowStorage.StoreTelemetryHistoryRowsAsync(rows, messageCount);
        }

        return Task.FromResult(new TelemetryBatchStoreResult(false, rows.ToList(), messageCount));
    }

    public async Task<bool> CheckTelemetryStorage()
    {
        var latestOk = await _latestStore.CheckAsync();
        var historyOk = await _historyStorage.CheckTelemetryStorage();
        return latestOk && historyOk;
    }

    public async Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
    {
        if (!await _latestStore.StoreBatchAsync([msg]))
            return (false, []);

        return await _historyStorage.StoreTelemetryAsync(msg);
    }

    public async Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
            return new TelemetryBatchStoreResult(true, [], 0);

        if (!await _latestStore.StoreBatchAsync(messages))
            return new TelemetryBatchStoreResult(false, [], messages.Count);

        var historyResult = await _historyStorage.StoreTelemetryBatchAsync(messages);
        return new TelemetryBatchStoreResult(
            historyResult.Result,
            historyResult.Telemetries,
            historyResult.MessageCount);
    }

    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
        => _latestStore.GetTelemetryLatest(deviceId);

    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
        => _latestStore.GetTelemetryLatest(deviceId, keys);

    public Task<List<TelemetryDataDto>> LoadTelemetryAsync(
        Guid deviceId,
        string keys,
        DateTime begin,
        DateTime end,
        TimeSpan every,
        Aggregate aggregate)
        => _historyStorage.LoadTelemetryAsync(deviceId, keys, begin, end, every, aggregate);
}

/// <summary>
/// Latest-only implementation backed by ApplicationDbContext. It never writes TelemetryData history.
/// SQL Server reuses the lock-optimized bulk latest upsert path; other relational providers use EF.
/// </summary>
public sealed class RelationalTelemetryLatestStore : IRelationalTelemetryLatestStore
{
    private readonly AppSettings _settings;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<RelationalTelemetryLatestStore> _logger;

    public RelationalTelemetryLatestStore(
        IOptions<AppSettings> options,
        IServiceScopeFactory scopeFactory,
        ILogger<RelationalTelemetryLatestStore> logger)
    {
        _settings = options.Value;
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task<bool> CheckAsync()
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            using var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            return await context.Database.CanConnectAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Relational telemetry latest storage health check failed.");
            return false;
        }
    }

    public async Task<bool> StoreBatchAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
            return true;

        var latestValues = ShardingTelemetryBatchBuilder.Build(messages).LatestValues;
        if (latestValues.Count == 0)
            return true;

        try
        {
            if (_settings.DataBase == DataBaseType.SqlServer)
            {
                if (_settings.ConnectionStrings?.TryGetValue("IoTSharp", out var connectionString) != true
                    || string.IsNullOrWhiteSpace(connectionString))
                {
                    throw new InvalidOperationException("ConnectionStrings:IoTSharp is required for relational telemetry latest storage.");
                }

                return await ShardingSqlServerBatchWriter.TryStoreLatestAsync(
                    _scopeFactory,
                    _logger,
                    latestValues,
                    connectionString);
            }

            return await StoreWithEfAsync(latestValues);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Relational telemetry latest batch write failed. Rows={Rows}", latestValues.Count);
            return false;
        }
    }

    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
        => QueryLatestAsync(deviceId, null);

    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
    {
        var keySet = keys.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return QueryLatestAsync(deviceId, keySet);
    }

    private async Task<List<TelemetryDataDto>> QueryLatestAsync(Guid deviceId, IReadOnlyCollection<string>? keys)
    {
        using var scope = _scopeFactory.CreateScope();
        using var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var query = context.Set<TelemetryLatest>()
            .AsNoTracking()
            .Where(item => item.DeviceId == deviceId);

        if (keys is { Count: > 0 })
        {
            var keyArray = keys.ToArray();
            query = query.Where(item => keyArray.Contains(item.KeyName));
        }

        var rows = await query.ToListAsync();
        return rows.Select(item => new TelemetryDataDto
        {
            DateTime = item.DateTime,
            KeyName = item.KeyName,
            DataType = item.Type,
            Value = item.ToObject()
        }).ToList();
    }

    private async Task<bool> StoreWithEfAsync(IReadOnlyCollection<ShardingTelemetryLatestValue> latestValues)
    {
        using var scope = _scopeFactory.CreateScope();
        using var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        var deviceIds = latestValues.Select(item => item.DeviceId).Distinct().ToArray();
        var keyNames = latestValues.Select(item => item.KeyName).Distinct().ToArray();
        var existing = await context.Set<TelemetryLatest>()
            .Where(item => deviceIds.Contains(item.DeviceId) && keyNames.Contains(item.KeyName))
            .ToDictionaryAsync(item => (item.DeviceId, item.KeyName));

        foreach (var latest in latestValues.OrderBy(item => item.DeviceId).ThenBy(item => item.KeyName, StringComparer.Ordinal))
        {
            var key = (latest.DeviceId, latest.KeyName);
            var pair = new KeyValuePair<string, object>(latest.KeyName, latest.Value);
            if (existing.TryGetValue(key, out var target))
            {
                if (latest.Timestamp < target.DateTime)
                    continue;

                target.FillKVToMe(pair);
                target.DateTime = latest.Timestamp;
                target.DataSide = latest.DataSide;
                continue;
            }

            target = new TelemetryLatest
            {
                Catalog = DataCatalog.TelemetryLatest,
                DeviceId = latest.DeviceId,
                KeyName = latest.KeyName,
                DateTime = latest.Timestamp,
                DataSide = latest.DataSide
            };
            target.FillKVToMe(pair);
            context.Set<TelemetryLatest>().Add(target);
            existing.Add(key, target);
        }

        await context.SaveChangesAsync();
        return true;
    }
}
