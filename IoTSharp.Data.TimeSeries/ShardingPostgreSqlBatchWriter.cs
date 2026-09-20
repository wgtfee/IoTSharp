using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Extensions.Logging;
using Npgsql;
using NpgsqlTypes;

namespace IoTSharp.Storage;

/// <summary>
/// PostgreSQL monthly-shard History writer using the native binary COPY protocol.
/// The fast path writes directly into the target shard; duplicate-key chunks are
/// retried through a temporary staging table with ON CONFLICT DO NOTHING.
/// </summary>
internal static class ShardingPostgreSqlBatchWriter
{
    private const int DefaultCopyRows = 50_000;
    private const int MinCopyRows = 1_000;
    private const int MaxCopyRows = 250_000;

    private static readonly string[] Columns =
    [
        nameof(TelemetryData.DeviceId), nameof(TelemetryData.KeyName), nameof(TelemetryData.DateTime),
        nameof(TelemetryData.DataSide), nameof(TelemetryData.Type), nameof(TelemetryData.Value_Boolean),
        nameof(TelemetryData.Value_String), nameof(TelemetryData.Value_Long), nameof(TelemetryData.Value_DateTime),
        nameof(TelemetryData.Value_Double), nameof(TelemetryData.Value_Json), nameof(TelemetryData.Value_XML),
        nameof(TelemetryData.Value_Binary)
    ];

    internal static async Task<bool> TryStoreHistoryAsync(
        AppSettings appSettings,
        ILogger logger,
        IReadOnlyList<TelemetryData> historyRows,
        CancellationToken cancellationToken = default)
    {
        if (historyRows.Count == 0)
            return true;
        if (appSettings.DataBase != DataBaseType.PostgreSql
            || appSettings.ShardingByDateMode != ShardingByDateMode.PerMonth
            || appSettings.ConnectionStrings?.TryGetValue("TelemetryStorage", out var connectionString) != true
            || string.IsNullOrWhiteSpace(connectionString))
        {
            return false;
        }

        var rowIndicesByTable = BuildHistoryRowIndices(historyRows);
        var chunkRows = NormalizeCopyRows(appSettings.TelemetryPostgreSqlCopyRows);

        await using var connection = new NpgsqlConnection(connectionString);
        try
        {
            await connection.OpenAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "PostgreSQL telemetry COPY fast path could not open the History connection; falling back to EF.");
            return false;
        }

        foreach (var group in rowIndicesByTable)
        {
            var orderedRowIndices = group.Value;
            Array.Sort(orderedRowIndices, (left, right) => CompareHistoryKey(historyRows[left], historyRows[right]));

            for (var offset = 0; offset < orderedRowIndices.Length; offset += chunkRows)
            {
                var count = Math.Min(chunkRows, orderedRowIndices.Length - offset);
                var chunk = new ArraySegment<int>(orderedRowIndices, offset, count);
                try
                {
                    await CopyChunkDirectAsync(connection, group.Key, historyRows, chunk, cancellationToken);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
                {
                    logger.LogWarning(
                        "PostgreSQL History COPY detected duplicate key; switching chunk to idempotent staging fallback. Table={Table}, Rows={Rows}, Offset={Offset}",
                        group.Key,
                        count,
                        offset);
                    await CopyChunkIdempotentAsync(connection, group.Key, historyRows, chunk, cancellationToken);
                }
                catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
                {
                    logger.LogDebug(
                        "PostgreSQL History shard {Table} does not exist yet; ShardingCore EF fallback will create/use it.",
                        group.Key);
                    return false;
                }
            }
        }

        return true;
    }

    internal static int NormalizeCopyRows(int configured)
        => Math.Clamp(configured <= 0 ? DefaultCopyRows : configured, MinCopyRows, MaxCopyRows);

    private static async Task CopyChunkDirectAsync(
        NpgsqlConnection connection,
        string table,
        IReadOnlyList<TelemetryData> rows,
        IReadOnlyList<int> rowIndices,
        CancellationToken cancellationToken)
    {
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await CopyRowsAsync(connection, table, rows, rowIndices, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task CopyChunkIdempotentAsync(
        NpgsqlConnection connection,
        string table,
        IReadOnlyList<TelemetryData> rows,
        IReadOnlyList<int> rowIndices,
        CancellationToken cancellationToken)
    {
        var tempTable = $"tmp_telemetry_history_{Guid.NewGuid():N}";
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await using (var create = new NpgsqlCommand(
                $"CREATE TEMP TABLE {Quote(tempTable)} (LIKE {Quote(table)} INCLUDING DEFAULTS) ON COMMIT DROP;",
                connection,
                transaction))
            {
                await create.ExecuteNonQueryAsync(cancellationToken);
            }

            await CopyRowsAsync(connection, tempTable, rows, rowIndices, cancellationToken);

            var quotedColumns = string.Join(",", Columns.Select(Quote));
            await using var merge = new NpgsqlCommand(
                $"INSERT INTO {Quote(table)} ({quotedColumns}) SELECT {quotedColumns} FROM {Quote(tempTable)} " +
                $"ON CONFLICT ({Quote(nameof(TelemetryData.DeviceId))},{Quote(nameof(TelemetryData.KeyName))},{Quote(nameof(TelemetryData.DateTime))}) DO NOTHING;",
                connection,
                transaction);
            await merge.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private static async Task CopyRowsAsync(
        NpgsqlConnection connection,
        string table,
        IReadOnlyList<TelemetryData> rows,
        IReadOnlyList<int> rowIndices,
        CancellationToken cancellationToken)
    {
        var quotedColumns = string.Join(",", Columns.Select(Quote));
        await using var importer = await connection.BeginBinaryImportAsync(
            $"COPY {Quote(table)} ({quotedColumns}) FROM STDIN (FORMAT BINARY)",
            cancellationToken);

        foreach (var rowIndex in rowIndices)
        {
            var row = rows[rowIndex];
            await importer.StartRowAsync(cancellationToken);
            await importer.WriteAsync(row.DeviceId, NpgsqlDbType.Uuid, cancellationToken);
            await importer.WriteAsync(row.KeyName, NpgsqlDbType.Text, cancellationToken);
            await importer.WriteAsync(NormalizeDateTime(row.DateTime), NpgsqlDbType.TimestampTz, cancellationToken);
            await importer.WriteAsync((int)row.DataSide, NpgsqlDbType.Integer, cancellationToken);
            await importer.WriteAsync((int)row.Type, NpgsqlDbType.Integer, cancellationToken);
            await WriteNullableAsync(importer, row.Value_Boolean, NpgsqlDbType.Boolean, cancellationToken);
            await WriteNullableAsync(importer, row.Value_String, NpgsqlDbType.Text, cancellationToken);
            await WriteNullableAsync(importer, row.Value_Long, NpgsqlDbType.Bigint, cancellationToken);
            if (row.Value_DateTime.HasValue)
                await importer.WriteAsync(NormalizeDateTime(row.Value_DateTime.Value), NpgsqlDbType.TimestampTz, cancellationToken);
            else
                await importer.WriteNullAsync(cancellationToken);
            await WriteNullableAsync(importer, row.Value_Double, NpgsqlDbType.Double, cancellationToken);
            await WriteNullableAsync(importer, row.Value_Json, NpgsqlDbType.Jsonb, cancellationToken);
            await WriteNullableAsync(importer, row.Value_XML, NpgsqlDbType.Xml, cancellationToken);
            await WriteNullableAsync(importer, row.Value_Binary, NpgsqlDbType.Bytea, cancellationToken);
        }

        await importer.CompleteAsync(cancellationToken);
    }

    private static async Task WriteNullableAsync<T>(
        NpgsqlBinaryImporter importer,
        T? value,
        NpgsqlDbType type,
        CancellationToken cancellationToken)
    {
        if (value is null)
            await importer.WriteNullAsync(cancellationToken);
        else
            await importer.WriteAsync(value, type, cancellationToken);
    }

    private static DateTime NormalizeDateTime(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private static Dictionary<string, int[]> BuildHistoryRowIndices(IReadOnlyList<TelemetryData> rows)
    {
        var counts = new Dictionary<int, int>();
        for (var index = 0; index < rows.Count; index++)
        {
            var key = checked(rows[index].DateTime.Year * 100 + rows[index].DateTime.Month);
            counts[key] = counts.TryGetValue(key, out var count) ? count + 1 : 1;
        }

        var arrays = new Dictionary<int, int[]>(counts.Count);
        var offsets = new Dictionary<int, int>(counts.Count);
        foreach (var (key, count) in counts)
        {
            arrays[key] = new int[count];
            offsets[key] = 0;
        }

        for (var index = 0; index < rows.Count; index++)
        {
            var key = checked(rows[index].DateTime.Year * 100 + rows[index].DateTime.Month);
            var offset = offsets[key];
            arrays[key][offset] = index;
            offsets[key] = offset + 1;
        }

        var result = new Dictionary<string, int[]>(arrays.Count, StringComparer.Ordinal);
        foreach (var (key, indices) in arrays)
            result[$"TelemetryData_{key:D6}"] = indices;
        return result;
    }

    private static int CompareHistoryKey(TelemetryData left, TelemetryData right)
    {
        var deviceCompare = left.DeviceId.CompareTo(right.DeviceId);
        if (deviceCompare != 0)
            return deviceCompare;
        var keyCompare = StringComparer.Ordinal.Compare(left.KeyName, right.KeyName);
        return keyCompare != 0 ? keyCompare : left.DateTime.CompareTo(right.DateTime);
    }

    private static string Quote(string identifier)
        => $"\"{identifier.Replace("\"", "\"\"")}\"";
}
