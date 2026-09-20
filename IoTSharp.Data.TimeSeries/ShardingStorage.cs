using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Shardings;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Data;
using System.Globalization;
using System.Collections.Generic;

namespace IoTSharp.Storage
{
    public class ShardingStorage : IStorage, ISplitTelemetryBatchStorage
    {
        // Durable row replay is a provider capability, not a generic property of the
        // sharding wrapper. Only provider paths with a materialized-row writer that is
        // safe for retry/replay advertise the capability.
        public bool SupportsTelemetryHistoryRowReplay
            => CanUseSqlServerMonthlyBulkCopy() || CanUsePostgreSqlMonthlyBinaryCopy();

        private static readonly string[] SqlServerHistoryColumns =
        [
            nameof(TelemetryData.DeviceId), nameof(TelemetryData.KeyName), nameof(TelemetryData.DateTime),
            nameof(TelemetryData.DataSide), nameof(TelemetryData.Type), nameof(TelemetryData.Value_Boolean),
            nameof(TelemetryData.Value_String), nameof(TelemetryData.Value_Long), nameof(TelemetryData.Value_DateTime),
            nameof(TelemetryData.Value_Double), nameof(TelemetryData.Value_Json), nameof(TelemetryData.Value_XML),
            nameof(TelemetryData.Value_Binary)
        ];

        private static readonly string[] SqlServerLatestColumns =
        [
            nameof(DataStorage.Catalog), nameof(DataStorage.DeviceId), nameof(DataStorage.KeyName), nameof(DataStorage.DateTime),
            nameof(DataStorage.DataSide), nameof(DataStorage.Type), nameof(DataStorage.Value_Boolean),
            nameof(DataStorage.Value_String), nameof(DataStorage.Value_Long), nameof(DataStorage.Value_DateTime),
            nameof(DataStorage.Value_Double), nameof(DataStorage.Value_Json), nameof(DataStorage.Value_XML),
            nameof(DataStorage.Value_Binary)
        ];

        private static readonly string[] SqlServerLatestMutableColumns =
        [
            nameof(DataStorage.DateTime), nameof(DataStorage.DataSide), nameof(DataStorage.Type),
            nameof(DataStorage.Value_Boolean), nameof(DataStorage.Value_String), nameof(DataStorage.Value_Long),
            nameof(DataStorage.Value_DateTime), nameof(DataStorage.Value_Double), nameof(DataStorage.Value_Json),
            nameof(DataStorage.Value_XML), nameof(DataStorage.Value_Binary)
        ];

        private readonly AppSettings _appSettings;
        private readonly ILogger _logger;
        private readonly IServiceScopeFactory _scopeFactor;

        public ShardingStorage(ILogger<ShardingStorage> logger, IServiceScopeFactory scopeFactor
           , IOptions<AppSettings> options
            )
        {
            _appSettings = options.Value;
            _logger = logger;
            _scopeFactor = scopeFactor;
        }

        public Task<bool> CheckTelemetryStorage()
        {
            return Task.FromResult(true);
        }

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
        {
            try
            {
                using (var scope = _scopeFactor.CreateScope())
                {
                    using (var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>())
                    {
                        var devid = from t in context.TelemetryLatest
                                    where t.DeviceId == deviceId
                                    select new TelemetryDataDto() { DateTime = t.DateTime, KeyName = t.KeyName, DataType = t.Type, Value = t.ToObject() };

                        return Task.FromResult(devid.AsNoTracking().ToList());
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{deviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
                throw;
            }
        }

        public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
        {
            try
            {
                using (var scope = _scopeFactor.CreateScope())
                {
                    using (var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>())
                    {
                        var keyary = keys.Split(',', ' ', ';');
                        var devid = from t in context.TelemetryLatest
                                    where t.DeviceId == deviceId && keyary.Contains(t.KeyName)

                                    select new TelemetryDataDto() { DateTime = t.DateTime, KeyName = t.KeyName, DataType = t.Type, Value = t.ToObject() };

                        return Task.FromResult(devid.AsNoTracking().ToList());
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{deviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
                throw;
            }
        }

        public async Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate)
        {
            List<TelemetryDataDto> result = new List<TelemetryDataDto>();
            try
            {
                using (var scope = _scopeFactor.CreateScope())
                {
                    using (var context = scope.ServiceProvider.GetRequiredService<ShardingDbContext>())
                    {
                        var keyNames = string.IsNullOrWhiteSpace(keys)
                            ? Array.Empty<string>()
                            : keys.Split([',', ' ', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                                .Distinct(StringComparer.Ordinal)
                                .ToArray();
                        var query = context.Set<TelemetryData>()
                            .Where(t => t.DeviceId == deviceId && t.DateTime >= begin && t.DateTime < end);
                        if (keyNames.Length > 0)
                        {
                            query = query.Where(t => keyNames.Contains(t.KeyName));
                        }
                        var lst = await query
                            .Select(t => new TelemetryDataDto() { DateTime = t.DateTime, KeyName = t.KeyName, Value = t.ToObject(), DataType = t.Type })
                            .ToListAsync();
                        result = AggregateDataHelpers.AggregateData(lst, begin, end, every, aggregate);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{deviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
                throw;
            }
            return result;
        }

        public async Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
        {
            bool result = false;
            List<TelemetryData> telemetries = new List<TelemetryData>();

            try
            {
                using var scope = _scopeFactor.CreateScope();

                using (var db = scope.ServiceProvider.GetRequiredService<ShardingDbContext>())
                {

                    var lst = new List<TelemetryData>();
                    msg.MsgBody.ToList().ForEach(kp =>
                                     {
                                         if (kp.Value != null)
                                         {
                                             var tdata = new TelemetryData() { DateTime = msg.ts, DeviceId = msg.DeviceId, KeyName = kp.Key };
                                             tdata.FillKVToMe(kp);
                                             lst.Add(tdata);
                                             telemetries.Add(tdata);
                                         }
                                     });
                    await db.Set<TelemetryData>().AddRangeAsync(lst);
                    await db.SaveChangesAsync();
                    _logger.LogInformation($"新增({msg.DeviceId})遥测数据1");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{msg.DeviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
            }

            try
            {
                using (var scope = _scopeFactor.CreateScope())
                {
                    using (var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>())
                    {
                        var result1 = await dbContext.SaveAsync<TelemetryLatest>(msg.MsgBody, msg.DeviceId, msg.DataSide);
                        result1.exceptions?.ToList().ForEach(ex =>
                        {
                            _logger.LogError(ex.Value, $"{ex.Key} {ex.Value.Message} {ex.Value.InnerException?.Message}");
                        });
                        _logger.LogInformation($"新增({msg.DeviceId})遥测数据更新最新信息{result1.ret}");
                        result = true;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{msg.DeviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
            }
            return (result, telemetries);
        }

        /// <summary>
        /// 批量保存分片遥测。历史数据一次进入 ShardingDbContext，Latest 在批内按设备/Key 只保留最后样本，
        /// 避免默认 IStorage 实现把一个批次重新拆成大量 DbContext + SaveChanges。
        /// </summary>
        public async Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            var batch = ShardingTelemetryBatchBuilder.Build(messages);
            if (batch.MessageCount == 0 || batch.HistoryRows.Count == 0)
            {
                return new TelemetryBatchStoreResult(true, batch.HistoryRows, batch.MessageCount);
            }

            try
            {
                // Latest 先提交：如果后续历史写入发生瞬时故障，上游重试只会重复一次幂等 Latest 更新，
                // 不会出现“历史已提交但 Latest 失败”后重试被历史主键卡死的情况。
                if (CanUseSqlServerMonthlyBulkCopy())
                {
                    if (!await ShardingSqlServerBatchWriter.TryStoreAsync(_appSettings, _scopeFactor, _logger, batch))
                        await StoreBatchWithEfAsync(batch);
                }
                else if (CanUsePostgreSqlMonthlyBinaryCopy())
                {
                    await StoreLatestValuesAsync(batch.LatestValues);
                    if (!await ShardingPostgreSqlBatchWriter.TryStoreHistoryAsync(_appSettings, _logger, batch.HistoryRows))
                        await StoreHistoryWithShardingEfAsync(batch.HistoryRows);
                }
                else
                {
                    await StoreBatchWithEfAsync(batch);
                }


                _logger.LogDebug(
                    "分片遥测批量保存完成. Messages={MessageCount}, HistoryRows={HistoryRows}, LatestRows={LatestRows}",
                    batch.MessageCount,
                    batch.HistoryRows.Count,
                    batch.LatestValues.Count);
                return new TelemetryBatchStoreResult(true, batch.HistoryRows, batch.MessageCount);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "分片遥测批量保存失败. Messages={MessageCount}, HistoryRows={HistoryRows}, LatestRows={LatestRows}",
                    batch.MessageCount,
                    batch.HistoryRows.Count,
                    batch.LatestValues.Count);
                return new TelemetryBatchStoreResult(false, batch.HistoryRows, batch.MessageCount);
            }
        }

        public async Task<TelemetryBatchStoreResult> StoreTelemetryLatestBatchAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            var batch = ShardingTelemetryBatchBuilder.Build(messages);
            if (batch.MessageCount == 0 || batch.LatestValues.Count == 0)
                return new TelemetryBatchStoreResult(true, [], batch.MessageCount);

            try
            {
                if (CanUseSqlServerMonthlyBulkCopy())
                {
                    var connectionString = _appSettings.ConnectionStrings!["TelemetryStorage"];
                    var ok = await ShardingSqlServerBatchWriter.TryStoreLatestAsync(
                        _scopeFactor,
                        _logger,
                        batch.LatestValues,
                        connectionString);
                    return new TelemetryBatchStoreResult(ok, [], batch.MessageCount);
                }

                await StoreLatestValuesAsync(batch.LatestValues);
                return new TelemetryBatchStoreResult(true, [], batch.MessageCount);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Sharding telemetry Latest-only batch persistence failed. Messages={MessageCount}, LatestRows={LatestRows}",
                    batch.MessageCount,
                    batch.LatestValues.Count);
                return new TelemetryBatchStoreResult(false, [], batch.MessageCount);
            }
        }

        public async Task<TelemetryBatchStoreResult> StoreTelemetryHistoryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            var batch = ShardingTelemetryBatchBuilder.Build(messages);
            if (batch.MessageCount == 0 || batch.HistoryRows.Count == 0)
                return new TelemetryBatchStoreResult(true, batch.HistoryRows, batch.MessageCount);

            try
            {
                if (CanUseSqlServerMonthlyBulkCopy())
                {
                    if (!await ShardingSqlServerBatchWriter.TryStoreHistoryAsync(
                            _appSettings,
                            _logger,
                            batch.HistoryRows))
                    {
                        await StoreHistoryWithShardingEfAsync(batch.HistoryRows);
                    }
                }
                else if (CanUsePostgreSqlMonthlyBinaryCopy())
                {
                    if (!await ShardingPostgreSqlBatchWriter.TryStoreHistoryAsync(_appSettings, _logger, batch.HistoryRows))
                        await StoreHistoryWithShardingEfAsync(batch.HistoryRows);
                }
                else
                {
                    await StoreHistoryWithShardingEfAsync(batch.HistoryRows);
                }

                return new TelemetryBatchStoreResult(true, batch.HistoryRows, batch.MessageCount);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Sharding telemetry History-only batch persistence failed. Messages={MessageCount}, HistoryRows={HistoryRows}",
                    batch.MessageCount,
                    batch.HistoryRows.Count);
                return new TelemetryBatchStoreResult(false, batch.HistoryRows, batch.MessageCount);
            }
        }

        public async Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(IReadOnlyCollection<TelemetryData> rows, int messageCount)
        {
            if (rows.Count == 0)
                return new TelemetryBatchStoreResult(true, [], messageCount);

            var materializedRows = rows as IReadOnlyList<TelemetryData> ?? rows.ToArray();
            try
            {
                if (CanUseSqlServerMonthlyBulkCopy())
                {
                    if (!await ShardingSqlServerBatchWriter.TryStoreHistoryAsync(_appSettings, _logger, materializedRows))
                        await StoreHistoryWithShardingEfAsync(materializedRows);
                }
                else if (CanUsePostgreSqlMonthlyBinaryCopy())
                {
                    if (!await ShardingPostgreSqlBatchWriter.TryStoreHistoryAsync(_appSettings, _logger, materializedRows))
                        await StoreHistoryWithShardingEfAsync(materializedRows);
                }
                else
                {
                    await StoreHistoryWithShardingEfAsync(materializedRows);
                }

                return new TelemetryBatchStoreResult(true, materializedRows.ToList(), messageCount);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Sharding telemetry materialized History persistence failed. Messages={MessageCount}, HistoryRows={HistoryRows}", messageCount, materializedRows.Count);
                return new TelemetryBatchStoreResult(false, materializedRows.ToList(), messageCount);
            }
        }

        private bool CanUseSqlServerMonthlyBulkCopy()
            => _appSettings.DataBase == DataBaseType.SqlServer
               && _appSettings.ShardingByDateMode == ShardingByDateMode.PerMonth
               && _appSettings.ConnectionStrings?.TryGetValue("TelemetryStorage", out var connectionString) == true
               && !string.IsNullOrWhiteSpace(connectionString);

        private bool CanUsePostgreSqlMonthlyBinaryCopy()
            => _appSettings.DataBase == DataBaseType.PostgreSql
               && _appSettings.ShardingByDateMode == ShardingByDateMode.PerMonth
               && _appSettings.ConnectionStrings?.TryGetValue("TelemetryStorage", out var connectionString) == true
               && !string.IsNullOrWhiteSpace(connectionString);

        private async Task StoreBatchWithEfAsync(ShardingTelemetryBatch batch)
        {
            await StoreLatestValuesAsync(batch.LatestValues);
            await StoreHistoryWithShardingEfAsync(batch.HistoryRows);
        }

        private async Task StoreLatestValuesAsync(IReadOnlyCollection<ShardingTelemetryLatestValue> latestValues)
        {
            if (latestValues.Count == 0)
                return;

            using var scope = _scopeFactor.CreateScope();
            using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

            var deviceIds = latestValues.Select(item => item.DeviceId).Distinct().ToArray();
            var keyNames = latestValues.Select(item => item.KeyName).Distinct().ToArray();
            var existing = await dbContext.Set<TelemetryLatest>()
                .Where(item => deviceIds.Contains(item.DeviceId) && keyNames.Contains(item.KeyName))
                .ToDictionaryAsync(item => (item.DeviceId, item.KeyName));

            foreach (var latest in latestValues)
            {
                var pair = new KeyValuePair<string, object>(latest.KeyName, latest.Value);
                if (existing.TryGetValue((latest.DeviceId, latest.KeyName), out var target))
                {
                    target.FillKVToMe(pair);
                    target.DateTime = latest.Timestamp;
                    target.DataSide = latest.DataSide;
                }
                else
                {
                    target = new TelemetryLatest
                    {
                        Catalog = DataCatalog.TelemetryLatest,
                        DeviceId = latest.DeviceId,
                        KeyName = latest.KeyName,
                        DateTime = latest.Timestamp,
                        DataSide = latest.DataSide
                    };
                    target.FillKVToMe(pair);
                    dbContext.Set<TelemetryLatest>().Add(target);
                    existing.Add((latest.DeviceId, latest.KeyName), target);
                }
            }

            await dbContext.SaveChangesAsync();
        }

        private async Task StoreHistoryWithShardingEfAsync(IReadOnlyCollection<TelemetryData> historyRows)
        {
            using var historyScope = _scopeFactor.CreateScope();
            using var historyDb = historyScope.ServiceProvider.GetRequiredService<ShardingDbContext>();
            await historyDb.Set<TelemetryData>().AddRangeAsync(historyRows);
            await historyDb.SaveChangesAsync();
        }

        private async Task StoreSqlServerMonthlyHistoryAsync(IReadOnlyList<TelemetryData> historyRows)
        {
            var connectionString = _appSettings.ConnectionStrings!["TelemetryStorage"];
            var rows = new List<SqlServerTelemetryRow>(historyRows.Count);
            var rowIndicesByTable = new Dictionary<string, List<int>>(StringComparer.Ordinal);

            for (var index = 0; index < historyRows.Count; index++)
            {
                var history = historyRows[index];
                rows.Add(new SqlServerTelemetryRow
                {
                    DeviceIdValue = history.DeviceId,
                    KeyName = history.KeyName,
                    DateTimeValue = history.DateTime,
                    DataSideValue = (int)history.DataSide,
                    Type = history.Type,
                    Value = history.ToObject(),
                    HasValue = true
                });

                var table = $"dbo.TelemetryData_{history.DateTime.ToString("yyyyMM", CultureInfo.InvariantCulture)}";
                if (!rowIndicesByTable.TryGetValue(table, out var indices))
                {
                    indices = new List<int>();
                    rowIndicesByTable.Add(table, indices);
                }
                indices.Add(index);
            }

            await using var connection = new SqlConnection(connectionString);
            await connection.OpenAsync();

            // ShardingCore normally creates the current physical table at startup. If a boundary table is not
            // present yet, fall back to the normal sharding path once so table creation/routing semantics stay intact.
            foreach (var table in rowIndicesByTable.Keys)
            {
                await using var existsCommand = connection.CreateCommand();
                existsCommand.CommandText = "SELECT OBJECT_ID(@tableName, 'U')";
                existsCommand.Parameters.AddWithValue("@tableName", table);
                if (await existsCommand.ExecuteScalarAsync() is DBNull or null)
                {
                    _logger.LogWarning("SQL Server 分片表 {Table} 尚不存在，回退 ShardingCore EF 写入。", table);
                    await StoreHistoryWithShardingEfAsync(historyRows);
                    return;
                }
            }

            await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            try
            {
                foreach (var group in rowIndicesByTable)
                {
                    using var reader = new SqlServerStorage.TelemetryBulkDataReader(
                        rows,
                        includeCatalog: false,
                        rowIndices: group.Value);
                    using var bulkCopy = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
                    {
                        DestinationTableName = $"[{group.Key.Replace(".", "].[")}]",
                        BatchSize = Math.Clamp(group.Value.Count, 1, 5000),
                        BulkCopyTimeout = 60,
                        EnableStreaming = true
                    };
                    foreach (var column in SqlServerHistoryColumns)
                        bulkCopy.ColumnMappings.Add(column, column);

                    await bulkCopy.WriteToServerAsync(reader);
                }

                await transaction.CommitAsync();
            }
            catch
            {
                await transaction.RollbackAsync();
                throw;
            }
        }
    }

    internal sealed record ShardingTelemetryLatestValue(
        Guid DeviceId,
        string KeyName,
        object Value,
        DataSide DataSide,
        DateTime Timestamp);

    internal sealed record ShardingTelemetryBatch(
        List<TelemetryData> HistoryRows,
        List<ShardingTelemetryLatestValue> LatestValues,
        int MessageCount);

    internal static class ShardingTelemetryBatchBuilder
    {
        internal static ShardingTelemetryBatch Build(IReadOnlyCollection<PlayloadData> messages)
        {
            var estimatedPoints = messages.Sum(message => message.MsgBody?.Count ?? 0);
            var historyRows = new List<TelemetryData>(estimatedPoints);
            var latestByKey = new Dictionary<(Guid DeviceId, string KeyName), ShardingTelemetryLatestValue>();

            foreach (var message in messages)
            {
                if (message.MsgBody is null)
                {
                    continue;
                }

                foreach (var pair in message.MsgBody)
                {
                    if (pair.Key is null || pair.Value is null)
                    {
                        continue;
                    }

                    var history = new TelemetryData
                    {
                        DateTime = message.ts,
                        DeviceId = message.DeviceId,
                        KeyName = pair.Key,
                        DataSide = message.DataSide
                    };
                    history.FillKVToMe(pair);
                    historyRows.Add(history);

                    var latestKey = (message.DeviceId, pair.Key);
                    if (!latestByKey.TryGetValue(latestKey, out var currentLatest)
                        || message.ts >= currentLatest.Timestamp)
                    {
                        latestByKey[latestKey] = new ShardingTelemetryLatestValue(
                            message.DeviceId,
                            pair.Key,
                            pair.Value,
                            message.DataSide,
                            message.ts);
                    }
                }
            }

            return new ShardingTelemetryBatch(historyRows, latestByKey.Values.ToList(), messages.Count);
        }
    }
}