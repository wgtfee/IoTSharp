using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Data;
using System.Diagnostics;
using System.Globalization;

namespace IoTSharp.Storage;

/// <summary>
/// SQL Server 月分表遥测批量写入器。
/// Latest 与 History 在同一个事务内完成，避免 EF 大批参数化 SQL 和两阶段提交窗口。
/// </summary>
internal static class ShardingSqlServerBatchWriter
{
    private static readonly string[] HistoryColumns =
    [
        nameof(TelemetryData.DeviceId), nameof(TelemetryData.KeyName), nameof(TelemetryData.DateTime),
        nameof(TelemetryData.DataSide), nameof(TelemetryData.Type), nameof(TelemetryData.Value_Boolean),
        nameof(TelemetryData.Value_String), nameof(TelemetryData.Value_Long), nameof(TelemetryData.Value_DateTime),
        nameof(TelemetryData.Value_Double), nameof(TelemetryData.Value_Json), nameof(TelemetryData.Value_XML),
        nameof(TelemetryData.Value_Binary)
    ];

    private static readonly string[] LatestColumns =
    [
        nameof(DataStorage.Catalog), nameof(DataStorage.DeviceId), nameof(DataStorage.KeyName), nameof(DataStorage.DateTime),
        nameof(DataStorage.DataSide), nameof(DataStorage.Type), nameof(DataStorage.Value_Boolean),
        nameof(DataStorage.Value_String), nameof(DataStorage.Value_Long), nameof(DataStorage.Value_DateTime),
        nameof(DataStorage.Value_Double), nameof(DataStorage.Value_Json), nameof(DataStorage.Value_XML),
        nameof(DataStorage.Value_Binary)
    ];

    private static readonly string[] LatestMutableColumns =
    [
        nameof(DataStorage.DateTime), nameof(DataStorage.DataSide), nameof(DataStorage.Type),
        nameof(DataStorage.Value_Boolean), nameof(DataStorage.Value_String), nameof(DataStorage.Value_Long),
        nameof(DataStorage.Value_DateTime), nameof(DataStorage.Value_Double), nameof(DataStorage.Value_Json),
        nameof(DataStorage.Value_XML), nameof(DataStorage.Value_Binary)
    ];

    internal static async Task<bool> TryStoreAsync(
        AppSettings appSettings,
        IServiceScopeFactory scopeFactory,
        ILogger logger,
        ShardingTelemetryBatch batch)
    {
        var connectionString = appSettings.ConnectionStrings!["TelemetryStorage"];
        var historyRows = new List<SqlServerTelemetryRow>(batch.HistoryRows.Count);
        var rowIndicesByTable = new Dictionary<string, List<int>>(StringComparer.Ordinal);

        for (var index = 0; index < batch.HistoryRows.Count; index++)
        {
            var history = batch.HistoryRows[index];
            historyRows.Add(ToStorageRow(history));

            var table = $"dbo.TelemetryData_{history.DateTime.ToString("yyyyMM", CultureInfo.InvariantCulture)}";
            if (!rowIndicesByTable.TryGetValue(table, out var indices))
            {
                indices = [];
                rowIndicesByTable.Add(table, indices);
            }
            indices.Add(index);
        }

        var latestRows = new List<SqlServerTelemetryRow>(batch.LatestValues.Count);
        foreach (var latest in batch.LatestValues)
        {
            var materialized = new TelemetryData();
            materialized.FillKVToMe(new KeyValuePair<string, object>(latest.KeyName, latest.Value));
            latestRows.Add(new SqlServerTelemetryRow
            {
                DeviceIdValue = latest.DeviceId,
                KeyName = latest.KeyName,
                DateTimeValue = latest.Timestamp,
                DataSideValue = (int)latest.DataSide,
                Type = materialized.Type,
                Value = latest.Value,
                HasValue = true
            });
        }

        string latestTable;
        using (var scope = scopeFactory.CreateScope())
        using (var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>())
        {
            latestTable = GetQualifiedTableName<TelemetryLatest>(dbContext);
        }

        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();

        foreach (var table in rowIndicesByTable.Keys)
        {
            await using var existsCommand = connection.CreateCommand();
            existsCommand.CommandText = "SELECT OBJECT_ID(@tableName, 'U')";
            existsCommand.Parameters.AddWithValue("@tableName", table);
            if (await existsCommand.ExecuteScalarAsync() is DBNull or null)
            {
                logger.LogWarning(
                    "SQL Server 分片表 {Table} 尚不存在，回退 ShardingCore EF 批量写入。",
                    table);
                return false;
            }
        }

        var total = Stopwatch.StartNew();
        var stage = Stopwatch.StartNew();
        await StoreHistoryAsync(connection, historyRows, rowIndicesByTable);
        var historyMs = stage.ElapsedMilliseconds;

        stage.Restart();
        await StoreLatestAsync(connection, latestTable, latestRows);
        var latestMs = stage.ElapsedMilliseconds;

        logger.LogDebug(
            "SQL Server sharding telemetry batch committed. HistoryRows={HistoryRows}, LatestRows={LatestRows}, HistoryMs={HistoryMs}, LatestMs={LatestMs}, TotalMs={TotalMs}",
            historyRows.Count,
            latestRows.Count,
            historyMs,
            latestMs,
            total.ElapsedMilliseconds);
        return true;
    }

    private static SqlServerTelemetryRow ToStorageRow(TelemetryData history)
        => new()
        {
            DeviceIdValue = history.DeviceId,
            KeyName = history.KeyName,
            DateTimeValue = history.DateTime,
            DataSideValue = (int)history.DataSide,
            Type = history.Type,
            Value = history.ToObject(),
            HasValue = true
        };

    private static async Task StoreLatestAsync(
        SqlConnection connection,
        string latestTable,
        IReadOnlyList<SqlServerTelemetryRow> latestRows)
    {
        if (latestRows.Count == 0)
            return;

        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
        const string tempLatest = "#TelemetryLatestBatch";
        await using (var create = connection.CreateCommand())
        {
            create.Transaction = transaction;
            create.CommandText = $"SELECT TOP (0) {ColumnList(LatestColumns)} INTO {tempLatest} FROM {latestTable};";
            await create.ExecuteNonQueryAsync();
        }

        using (var reader = new SqlServerStorage.TelemetryBulkDataReader(
                   latestRows,
                   includeCatalog: true,
                   catalogOverride: DataCatalog.TelemetryLatest))
        using (var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
        {
            DestinationTableName = tempLatest,
            BatchSize = Math.Clamp(latestRows.Count, 1, 5000),
            BulkCopyTimeout = 60,
            EnableStreaming = true
        })
        {
            foreach (var column in LatestColumns)
                bulk.ColumnMappings.Add(column, column);
            await bulk.WriteToServerAsync(reader);
        }

        var updateAssignments = string.Join(", ", LatestMutableColumns.Select(column => $"t.{Quote(column)} = s.{Quote(column)}"));
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            UPDATE t
            SET {updateAssignments}
            FROM {latestTable} AS t
            INNER JOIN {tempLatest} AS s
                ON t.[Catalog] = s.[Catalog]
               AND t.[DeviceId] = s.[DeviceId]
               AND t.[KeyName] = s.[KeyName];

            INSERT INTO {latestTable} ({ColumnList(LatestColumns)})
            SELECT {PrefixedColumnList("s", LatestColumns)}
            FROM {tempLatest} AS s
            WHERE NOT EXISTS
            (
                SELECT 1
                FROM {latestTable} AS t
                WHERE t.[Catalog] = s.[Catalog]
                  AND t.[DeviceId] = s.[DeviceId]
                  AND t.[KeyName] = s.[KeyName]
            );
            """;
        await command.ExecuteNonQueryAsync();
            await transaction.CommitAsync();
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }

    private static async Task StoreHistoryAsync(
        SqlConnection connection,
        IReadOnlyList<SqlServerTelemetryRow> historyRows,
        IReadOnlyDictionary<string, List<int>> rowIndicesByTable)
    {
        foreach (var group in rowIndicesByTable)
        {
            await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            try
            {
                const string tempHistory = "#TelemetryHistoryBatch";
                await using (var create = connection.CreateCommand())
                {
                    create.Transaction = transaction;
                    create.CommandText = $"SELECT TOP (0) {ColumnList(HistoryColumns)} INTO {tempHistory} FROM [{group.Key.Replace(".", "].[")}];";
                    await create.ExecuteNonQueryAsync();
                }

                using (var reader = new SqlServerStorage.TelemetryBulkDataReader(
                           historyRows,
                           includeCatalog: false,
                           rowIndices: group.Value))
                using (var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
                {
                    DestinationTableName = tempHistory,
                    BatchSize = Math.Clamp(group.Value.Count, 1, 5000),
                    BulkCopyTimeout = 60,
                    EnableStreaming = true
                })
                {
                    foreach (var column in HistoryColumns)
                        bulk.ColumnMappings.Add(column, column);
                    await bulk.WriteToServerAsync(reader);
                }

                await using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = $"""
                    INSERT INTO [{group.Key.Replace(".", "].[")}] ({ColumnList(HistoryColumns)})
                    SELECT {PrefixedColumnList("s", HistoryColumns)}
                    FROM {tempHistory} AS s
                    WHERE NOT EXISTS
                    (
                        SELECT 1
                        FROM [{group.Key.Replace(".", "].[")}] AS t
                        WHERE t.[DeviceId] = s.[DeviceId]
                          AND t.[KeyName] = s.[KeyName]
                          AND t.[DateTime] = s.[DateTime]
                    );
                    """;
                await insert.ExecuteNonQueryAsync();
                await transaction.CommitAsync();
            }
            catch
            {
                await transaction.RollbackAsync();
                throw;
            }
        }
    }

    private static string GetQualifiedTableName<TEntity>(DbContext context)
    {
        var entity = context.Model.FindEntityType(typeof(TEntity))
            ?? throw new InvalidOperationException($"EF metadata for {typeof(TEntity).Name} was not found.");
        var table = entity.GetTableName()
            ?? throw new InvalidOperationException($"SQL table for {typeof(TEntity).Name} was not found.");
        var schema = entity.GetSchema();
        return string.IsNullOrWhiteSpace(schema) ? Quote(table) : $"{Quote(schema)}.{Quote(table)}";
    }

    private static string ColumnList(IEnumerable<string> columns)
        => string.Join(", ", columns.Select(Quote));

    private static string PrefixedColumnList(string alias, IEnumerable<string> columns)
        => string.Join(", ", columns.Select(column => $"{alias}.{Quote(column)}"));

    private static string Quote(string identifier)
        => $"[{identifier.Replace("]", "]]", StringComparison.Ordinal)}]";
}
