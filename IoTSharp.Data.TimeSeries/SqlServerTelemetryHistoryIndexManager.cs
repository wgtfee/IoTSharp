using IoTSharp.Contracts;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using System.Collections.Concurrent;
using System.Globalization;

namespace IoTSharp.Storage;

/// <summary>
/// Applies optional SQL Server-only index lifecycle rules to monthly telemetry History shards.
/// The common EF model is intentionally left unchanged so other relational providers keep their existing schema behavior.
/// </summary>
internal static class SqlServerTelemetryHistoryIndexManager
{
    private const string TablePrefix = "dbo.TelemetryData_";
    private static readonly SemaphoreSlim MaintenanceGate = new(1, 1);
    private static readonly ConcurrentDictionary<string, byte> AppliedStates = new(StringComparer.OrdinalIgnoreCase);

    internal static bool IsEnabled(AppSettings settings)
        => settings.TelemetryHistoryShardIndexMode == TelemetryHistoryShardIndexMode.WriteOptimizedHotShard
           && settings.DataBase == DataBaseType.SqlServer
           && settings.EffectiveTelemetryHistoryStorage == TelemetryStorage.Sharding
           && settings.ShardingByDateMode == ShardingByDateMode.PerMonth;

    internal static async Task ApplyAsync(
        SqlConnection connection,
        AppSettings settings,
        ILogger logger,
        IEnumerable<string> touchedTables)
    {
        if (!IsEnabled(settings))
            return;

        var now = DateTime.UtcNow;
        var hotSuffix = now.ToString("yyyyMM", CultureInfo.InvariantCulture);
        var desiredStates = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

        foreach (var table in touchedTables)
        {
            if (!TryGetMonthlySuffix(table, out var suffix))
                continue;

            // Current month is write-optimized. Any late-arriving cold shard keeps its query index.
            desiredStates[table] = !string.Equals(suffix, hotSuffix, StringComparison.Ordinal);
        }

        // On the first write after a month rollover, finalize the immediately previous shard for queries.
        var previousSuffix = now.AddMonths(-1).ToString("yyyyMM", CultureInfo.InvariantCulture);
        desiredStates[$"{TablePrefix}{previousSuffix}"] = true;

        foreach (var (table, ensureQueryIndex) in desiredStates)
        {
            var stateKey = $"{connection.DataSource}|{connection.Database}|{table}|{ensureQueryIndex}";
            if (AppliedStates.ContainsKey(stateKey))
                continue;

            await MaintenanceGate.WaitAsync();
            try
            {
                if (AppliedStates.ContainsKey(stateKey))
                    continue;

                var changed = await SetDeviceTimeIndexStateAsync(connection, table, ensureQueryIndex);
                AppliedStates.TryAdd(stateKey, 0);
                if (changed)
                {
                    logger.LogInformation(
                        "SQL Server telemetry shard index mode applied. Table={Table}, Mode={Mode}",
                        table,
                        ensureQueryIndex ? "QueryOptimized" : "WriteOptimized");
                }
            }
            catch (SqlException ex) when (ex.Number is 3701 or 1913)
            {
                // Another cluster node may have changed the same index between the metadata check and DDL.
                AppliedStates.TryAdd(stateKey, 0);
                logger.LogDebug(ex, "SQL Server telemetry shard index state changed concurrently. Table={Table}", table);
            }
            finally
            {
                MaintenanceGate.Release();
            }
        }
    }

    private static async Task<bool> SetDeviceTimeIndexStateAsync(
        SqlConnection connection,
        string qualifiedTable,
        bool ensureIndex)
    {
        if (!TryGetMonthlySuffix(qualifiedTable, out var suffix))
            return false;

        var tableName = $"TelemetryData_{suffix}";
        var indexName = $"IX_{tableName}_DeviceId_DateTime";
        var objectName = $"dbo.{tableName}";

        await using var command = connection.CreateCommand();
        command.Parameters.AddWithValue("@objectName", objectName);
        command.Parameters.AddWithValue("@schemaName", "dbo");
        command.Parameters.AddWithValue("@tableName", tableName);
        command.Parameters.AddWithValue("@indexName", indexName);

        command.CommandText = ensureIndex
            ? """
                DECLARE @objectId int = OBJECT_ID(@objectName, 'U');
                IF @objectId IS NULL
                BEGIN
                    SELECT CAST(0 AS int);
                    RETURN;
                END;
                IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND name = @indexName)
                BEGIN
                    DECLARE @createSql nvarchar(max) = N'CREATE INDEX ' + QUOTENAME(@indexName)
                        + N' ON ' + QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName)
                        + N' ([DeviceId], [DateTime]);';
                    EXEC sys.sp_executesql @createSql;
                    SELECT CAST(1 AS int);
                END
                ELSE
                    SELECT CAST(0 AS int);
                """
            : """
                DECLARE @objectId int = OBJECT_ID(@objectName, 'U');
                IF @objectId IS NULL
                BEGIN
                    SELECT CAST(0 AS int);
                    RETURN;
                END;
                IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND name = @indexName)
                BEGIN
                    DECLARE @dropSql nvarchar(max) = N'DROP INDEX ' + QUOTENAME(@indexName)
                        + N' ON ' + QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName) + N';';
                    EXEC sys.sp_executesql @dropSql;
                    SELECT CAST(1 AS int);
                END
                ELSE
                    SELECT CAST(0 AS int);
                """;

        return Convert.ToInt32(await command.ExecuteScalarAsync(), CultureInfo.InvariantCulture) == 1;
    }

    private static bool TryGetMonthlySuffix(string table, out string suffix)
    {
        suffix = string.Empty;
        if (!table.StartsWith(TablePrefix, StringComparison.OrdinalIgnoreCase))
            return false;

        var candidate = table[TablePrefix.Length..];
        if (candidate.Length != 6 || !candidate.All(char.IsDigit))
            return false;

        if (!DateTime.TryParseExact(candidate, "yyyyMM", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            return false;

        suffix = candidate;
        return true;
    }
}
