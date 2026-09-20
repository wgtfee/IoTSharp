using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Data;
using System.Diagnostics;

namespace IoTSharp.Storage;

/// <summary>
/// SQL Server monthly-shard telemetry batch writer.
/// History uses sharded BulkCopy; Latest uses fixed key ordering and small upsert transactions.
/// </summary>
internal static class ShardingSqlServerBatchWriter
{
    private const int LatestUpsertChunkSize = 1000;
    private const int LatestUpsertMaxAttempts = 3;
    private const int HistoryBulkCopyBatchSize = 50_000;
    private const int DefaultHistoryTransactionRows = 50_000;
    private const int MinHistoryTransactionRows = 1_000;
    private const int MaxHistoryTransactionRows = 250_000;

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
        var rowIndicesByTable = BuildHistoryRowIndices(batch.HistoryRows);

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
        if (!await EnsureHistoryShardTablesAsync(connection, logger, rowIndicesByTable.Keys))
            return false;
        await SqlServerTelemetryHistoryIndexManager.ApplyAsync(connection, appSettings, logger, rowIndicesByTable.Keys);

        var total = Stopwatch.StartNew();
        var stage = Stopwatch.StartNew();
        var historyFallback = await StoreHistoryAsync(
            connection,
            logger,
            batch.HistoryRows,
            rowIndicesByTable,
            NormalizeHistoryTransactionRows(appSettings.TelemetryHistoryTransactionRows));
        var historyMs = stage.ElapsedMilliseconds;

        stage.Restart();
        await StoreLatestAsync(connection, latestTable, latestRows);
        var latestMs = stage.ElapsedMilliseconds;

        logger.LogDebug(
            "SQL Server sharding telemetry batch committed. HistoryRows={HistoryRows}, LatestRows={LatestRows}, HistoryFallback={HistoryFallback}, HistoryMs={HistoryMs}, LatestMs={LatestMs}, TotalMs={TotalMs}",
            batch.HistoryRows.Count,
            latestRows.Count,
            historyFallback,
            historyMs,
            latestMs,
            total.ElapsedMilliseconds);
        return true;
    }

    /// <summary>
    /// Writes only sharded telemetry History using the same ordered/chunked SQL Server path as TryStoreAsync.
    /// </summary>
    internal static async Task<bool> TryStoreHistoryAsync(
        AppSettings appSettings,
        ILogger logger,
        IReadOnlyList<TelemetryData> historyValues)
    {
        if (historyValues.Count == 0)
            return true;

        var connectionString = appSettings.ConnectionStrings!["TelemetryStorage"];
        var rowIndicesByTable = BuildHistoryRowIndices(historyValues);
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        if (!await EnsureHistoryShardTablesAsync(connection, logger, rowIndicesByTable.Keys))
            return false;
        await SqlServerTelemetryHistoryIndexManager.ApplyAsync(connection, appSettings, logger, rowIndicesByTable.Keys);

        var stopwatch = Stopwatch.StartNew();
        var historyFallback = await StoreHistoryAsync(
            connection,
            logger,
            historyValues,
            rowIndicesByTable,
            NormalizeHistoryTransactionRows(appSettings.TelemetryHistoryTransactionRows));
        logger.LogDebug(
            "SQL Server sharding History-only batch committed. HistoryRows={HistoryRows}, HistoryFallback={HistoryFallback}, TotalMs={TotalMs}",
            historyValues.Count,
            historyFallback,
            stopwatch.ElapsedMilliseconds);
        return true;
    }

    private static Dictionary<string, int[]> BuildHistoryRowIndices(
        IReadOnlyList<TelemetryData> historyValues)
    {
        var shardCounts = new Dictionary<int, int>();
        for (var index = 0; index < historyValues.Count; index++)
        {
            var shardKey = GetMonthShardKey(historyValues[index].DateTime);
            shardCounts[shardKey] = shardCounts.TryGetValue(shardKey, out var count) ? count + 1 : 1;
        }

        var indicesByShard = new Dictionary<int, int[]>(shardCounts.Count);
        var nextOffsets = new Dictionary<int, int>(shardCounts.Count);
        foreach (var (shardKey, count) in shardCounts)
        {
            indicesByShard.Add(shardKey, new int[count]);
            nextOffsets.Add(shardKey, 0);
        }

        for (var index = 0; index < historyValues.Count; index++)
        {
            var shardKey = GetMonthShardKey(historyValues[index].DateTime);
            var offset = nextOffsets[shardKey];
            indicesByShard[shardKey][offset] = index;
            nextOffsets[shardKey] = offset + 1;
        }

        var rowIndicesByTable = new Dictionary<string, int[]>(indicesByShard.Count, StringComparer.Ordinal);
        foreach (var (shardKey, indices) in indicesByShard)
            rowIndicesByTable.Add($"dbo.TelemetryData_{shardKey:D6}", indices);
        return rowIndicesByTable;
    }

    private static int GetMonthShardKey(DateTime value) => checked(value.Year * 100 + value.Month);

    private static async Task<bool> EnsureHistoryShardTablesAsync(
        SqlConnection connection,
        ILogger logger,
        IEnumerable<string> tables)
    {
        foreach (var table in tables)
        {
            await using var existsCommand = connection.CreateCommand();
            existsCommand.CommandText = "SELECT OBJECT_ID(@tableName, 'U')";
            existsCommand.Parameters.AddWithValue("@tableName", table);
            if (await existsCommand.ExecuteScalarAsync() is DBNull or null)
            {
                logger.LogWarning(
                    "SQL Server shard table {Table} does not exist; falling back to ShardingCore EF batch persistence.",
                    table);
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// Writes only TelemetryLatest into the supplied SQL Server business database.
    /// This reuses the same lock-optimized upsert as the verified sharding path.
    /// </summary>
    internal static async Task<bool> TryStoreLatestAsync(
        IServiceScopeFactory scopeFactory,
        ILogger logger,
        IReadOnlyCollection<ShardingTelemetryLatestValue> latestValues,
        string connectionString)
    {
        if (latestValues.Count == 0)
            return true;

        var latestRows = new List<SqlServerTelemetryRow>(latestValues.Count);
        foreach (var latest in latestValues)
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
        var stopwatch = Stopwatch.StartNew();
        await StoreLatestAsync(connection, latestTable, latestRows);
        logger.LogDebug(
            "SQL Server relational latest batch committed. LatestRows={LatestRows}, TotalMs={TotalMs}",
            latestRows.Count,
            stopwatch.ElapsedMilliseconds);
        return true;
    }

    private static async Task StoreLatestAsync(
        SqlConnection connection,
        string latestTable,
        IReadOnlyList<SqlServerTelemetryRow> latestRows)
    {
        if (latestRows.Count == 0)
            return;

        const string tempLatest = "#TelemetryLatestBatch";
        await using (var create = connection.CreateCommand())
        {
            create.CommandText = $"""
                DROP TABLE IF EXISTS {tempLatest};
                SELECT TOP (0) {ColumnList(LatestColumns)} INTO {tempLatest} FROM {latestTable};
                CREATE UNIQUE CLUSTERED INDEX [IX_TelemetryLatestBatch_Key]
                    ON {tempLatest} ([Catalog], [DeviceId], [KeyName]);
                """;
            await create.ExecuteNonQueryAsync();
        }

        // All concurrent batches acquire latest-row locks in the same primary-key order to reduce deadlock risk.
        var orderedRowIndices = Enumerable.Range(0, latestRows.Count).ToArray();

        for (var offset = 0; offset < orderedRowIndices.Length; offset += LatestUpsertChunkSize)
        {
            var count = Math.Min(LatestUpsertChunkSize, orderedRowIndices.Length - offset);
            var chunkIndices = new ArraySegment<int>(orderedRowIndices, offset, count);
            await StoreLatestChunkWithRetryAsync(connection, latestTable, tempLatest, latestRows, chunkIndices);
        }
    }

    private static async Task StoreLatestChunkWithRetryAsync(
        SqlConnection connection,
        string latestTable,
        string tempLatest,
        IReadOnlyList<SqlServerTelemetryRow> latestRows,
        IReadOnlyList<int> chunkIndices)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await StoreLatestChunkAsync(connection, latestTable, tempLatest, latestRows, chunkIndices);
                return;
            }
            catch (SqlException ex) when (attempt < LatestUpsertMaxAttempts && IsRetryableLatestUpsertConflict(ex))
            {
                // Avoid HOLDLOCK on missing keys so the normal path does not create serializable key-range locks.
                // Rare concurrent INSERT races are resolved by the unique key; retry only the current small chunk.
                await Task.Delay(TimeSpan.FromMilliseconds(10 * attempt));
            }
        }
    }

    private static async Task StoreLatestChunkAsync(
        SqlConnection connection,
        string latestTable,
        string tempLatest,
        IReadOnlyList<SqlServerTelemetryRow> latestRows,
        IReadOnlyList<int> chunkIndices)
    {
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
            await using (var truncate = connection.CreateCommand())
            {
                truncate.Transaction = transaction;
                truncate.CommandText = $"TRUNCATE TABLE {tempLatest};";
                await truncate.ExecuteNonQueryAsync();
            }

            using (var reader = new SqlServerStorage.TelemetryBulkDataReader(
                       latestRows,
                       includeCatalog: true,
                       rowIndices: chunkIndices,
                       catalogOverride: DataCatalog.TelemetryLatest))
            using (var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
            {
                DestinationTableName = tempLatest,
                BatchSize = chunkIndices.Count,
                BulkCopyTimeout = 60,
                EnableStreaming = true
            })
            {
                foreach (var column in LatestColumns)
                    bulk.ColumnMappings.Add(column, column);
                await bulk.WriteToServerAsync(reader);
            }

            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandTimeout = 60;
            command.CommandText = BuildLatestUpsertCommandText(tempLatest, latestTable);
            await command.ExecuteNonQueryAsync();
            await transaction.CommitAsync();
        }
        catch
        {
            await TryRollbackAsync(transaction);
            throw;
        }
    }

    internal static string BuildLatestUpsertCommandText(string tempLatest, string latestTable)
    {
        var updateAssignments = string.Join(", ", LatestMutableColumns.Select(column => $"t.{Quote(column)} = s.{Quote(column)}"));
        return $"""
            UPDATE t WITH (ROWLOCK)
            SET {updateAssignments}
            FROM {latestTable} AS t
            INNER JOIN {tempLatest} AS s
                ON t.[Catalog] = s.[Catalog]
               AND t.[DeviceId] = s.[DeviceId]
               AND t.[KeyName] = s.[KeyName]
            WHERE s.[DateTime] >= t.[DateTime]
            OPTION (LOOP JOIN, MAXDOP 1);

            INSERT INTO {latestTable} WITH (ROWLOCK) ({ColumnList(LatestColumns)})
            SELECT {PrefixedColumnList("s", LatestColumns)}
            FROM {tempLatest} AS s
            WHERE NOT EXISTS
            (
                SELECT 1
                FROM {latestTable} AS t
                WHERE t.[Catalog] = s.[Catalog]
                  AND t.[DeviceId] = s.[DeviceId]
                  AND t.[KeyName] = s.[KeyName]
            )
            OPTION (LOOP JOIN, MAXDOP 1);
            """;
    }

    private static bool IsRetryableLatestUpsertConflict(SqlException exception)
        => exception.Number is 1205 or 2601 or 2627;

    private static int CompareLatestKey(SqlServerTelemetryRow left, SqlServerTelemetryRow right)
    {
        var deviceCompare = ((Guid)left.DeviceIdValue).CompareTo((Guid)right.DeviceIdValue);
        return deviceCompare != 0
            ? deviceCompare
            : StringComparer.Ordinal.Compare(left.KeyName, right.KeyName);
    }

    private static async Task<bool> StoreHistoryAsync(
        SqlConnection connection,
        ILogger logger,
        IReadOnlyList<TelemetryData> historyRows,
        IReadOnlyDictionary<string, int[]> rowIndicesByTable,
        int transactionRows)
    {
        var usedFallback = false;
        foreach (var group in rowIndicesByTable)
        {
            var orderedRowIndices = group.Value;
            Array.Sort(orderedRowIndices, (left, right) => CompareHistoryKey(historyRows[left], historyRows[right]));

            for (var offset = 0; offset < orderedRowIndices.Length; offset += transactionRows)
            {
                var count = Math.Min(transactionRows, orderedRowIndices.Length - offset);
                var chunkIndices = new ArraySegment<int>(orderedRowIndices, offset, count);
                if (await TryBulkCopyHistoryDirectAsync(connection, group.Key, historyRows, chunkIndices))
                    continue;

                usedFallback = true;
                logger.LogWarning(
                    "SQL Server history telemetry bulk write detected duplicate key; switching chunk to idempotent fallback. Table={Table}, Rows={Rows}, Offset={Offset}",
                    group.Key,
                    count,
                    offset);
                await StoreHistoryIdempotentAsync(connection, group.Key, historyRows, chunkIndices);
            }
        }

        return usedFallback;
    }

    internal static int NormalizeHistoryTransactionRows(int configured)
        => Math.Clamp(
            configured <= 0 ? DefaultHistoryTransactionRows : configured,
            MinHistoryTransactionRows,
            MaxHistoryTransactionRows);

    private static async Task<bool> TryBulkCopyHistoryDirectAsync(
        SqlConnection connection,
        string table,
        IReadOnlyList<TelemetryData> historyRows,
        IReadOnlyList<int> rowIndices)
    {
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
            using var reader = new SqlServerStorage.TelemetryBulkDataReader(
                historyRows,
                includeCatalog: false,
                rowIndices: rowIndices);
            using var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
            {
                DestinationTableName = $"[{table.Replace(".", "].[")}]",
                BatchSize = Math.Clamp(rowIndices.Count, 1, HistoryBulkCopyBatchSize),
                BulkCopyTimeout = 60,
                EnableStreaming = true
            };
            foreach (var column in HistoryColumns)
                bulk.ColumnMappings.Add(column, column);
            await bulk.WriteToServerAsync(reader);
            await transaction.CommitAsync();
            return true;
        }
        catch (SqlException ex) when (ex.Number is 2601 or 2627)
        {
            await TryRollbackAsync(transaction);
            return false;
        }
        catch
        {
            await TryRollbackAsync(transaction);
            throw;
        }
    }

    private static async Task StoreHistoryIdempotentAsync(
        SqlConnection connection,
        string table,
        IReadOnlyList<TelemetryData> historyRows,
        IReadOnlyList<int> rowIndices)
    {
        const int chunkSize = 5000;
        for (var offset = 0; offset < rowIndices.Count; offset += chunkSize)
        {
            var count = Math.Min(chunkSize, rowIndices.Count - offset);
            var chunkIndices = new int[count];
            for (var index = 0; index < count; index++)
                chunkIndices[index] = rowIndices[offset + index];
            await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            try
            {
                const string tempHistory = "#TelemetryHistoryBatch";
                await using (var create = connection.CreateCommand())
                {
                    create.Transaction = transaction;
                    create.CommandText = $"DROP TABLE IF EXISTS {tempHistory}; SELECT TOP (0) {ColumnList(HistoryColumns)} INTO {tempHistory} FROM [{table.Replace(".", "].[")}];";
                    await create.ExecuteNonQueryAsync();
                }

                using (var reader = new SqlServerStorage.TelemetryBulkDataReader(
                           historyRows,
                           includeCatalog: false,
                           rowIndices: chunkIndices))
                using (var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
                {
                    DestinationTableName = tempHistory,
                    BatchSize = count,
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
                    INSERT INTO [{table.Replace(".", "].[")}] ({ColumnList(HistoryColumns)})
                    SELECT {PrefixedColumnList("s", HistoryColumns)}
                    FROM {tempHistory} AS s
                    WHERE NOT EXISTS
                    (
                        SELECT 1
                        FROM [{table.Replace(".", "].[")}] AS t
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
                await TryRollbackAsync(transaction);
                throw;
            }
        }
    }

    private static int CompareHistoryKey(TelemetryData left, TelemetryData right)
    {
        var deviceCompare = left.DeviceId.CompareTo(right.DeviceId);
        if (deviceCompare != 0)
            return deviceCompare;

        var keyCompare = StringComparer.Ordinal.Compare(left.KeyName, right.KeyName);
        return keyCompare != 0
            ? keyCompare
            : left.DateTime.CompareTo(right.DateTime);
    }

    private static async Task TryRollbackAsync(SqlTransaction transaction)
    {
        try
        {
            await transaction.RollbackAsync();
        }
        catch (InvalidOperationException)
        {
            // SQL Server may already roll back a deadlock victim; keep the original write exception for retry classification.
        }
        catch (SqlException)
        {
            // A rollback failure must not hide the original 1205/2601/2627 write conflict.
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
