using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Data;
using System.Runtime.InteropServices;

namespace IoTSharp.Storage;

/// <summary>
/// SQL Server optimized single-table telemetry storage.
/// History and latest values are staged with SqlBulkCopy and committed in one transaction.
/// </summary>
public sealed class SqlServerStorage : EFStorage
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

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<EFStorage> _logger;

    public SqlServerStorage(
        ILogger<EFStorage> logger,
        IServiceScopeFactory scopeFactory,
        IOptions<AppSettings> options)
        : base(logger, scopeFactory, options)
    {
        _logger = logger;
        _scopeFactory = scopeFactory;
    }

    public override async Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
        {
            return new TelemetryBatchStoreResult(true, [], 0);
        }

        var batch = SqlServerTelemetryBatchBuilder.BuildForStorage(messages, DateTime.UtcNow);
        if (batch.HistoryRows.Count == 0)
        {
            return new TelemetryBatchStoreResult(true, [], messages.Count);
        }

        try
        {
            var historyRows = batch.HistoryRows;
            var latestRowIndices = batch.LatestSourceIndices;

            using var scope = _scopeFactory.CreateScope();
            await using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (dbContext.Database.GetDbConnection() is not SqlConnection connection)
            {
                _logger.LogWarning("SqlServerStorage received a non-SQL Server DbConnection; falling back to EFStorage.");
                return await base.StoreTelemetryBatchAsync(messages);
            }

            if (connection.State != ConnectionState.Open)
            {
                await connection.OpenAsync();
            }

            // The history/latest existence checks already take UPDLOCK + HOLDLOCK on their
            // unique keys. Keep the ambient transaction at ReadCommitted so unrelated
            // gateway partitions can commit concurrently instead of serializing the entire batch.
            await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            try
            {
                var historyTable = GetQualifiedTableName<TelemetryData>(dbContext);
                var latestTable = GetQualifiedTableName<TelemetryLatest>(dbContext);

                const string tempHistory = "#TelemetryHistoryBatch";
                const string tempLatest = "#TelemetryLatestBatch";
                await CreateTempTablesAsync(
                    connection,
                    transaction,
                    tempHistory,
                    historyTable,
                    tempLatest,
                    latestTable);

                using (var historyReader = new TelemetryBulkDataReader(historyRows, includeCatalog: false))
                {
                    await BulkCopyAsync(connection, transaction, tempHistory, historyReader, historyRows.Count, HistoryColumns);
                }

                if (latestRowIndices.Count > 0)
                {
                    using var latestReader = new TelemetryBulkDataReader(
                        historyRows,
                        includeCatalog: true,
                        rowIndices: latestRowIndices,
                        catalogOverride: DataCatalog.TelemetryLatest,
                        dateTimeOverride: batch.LatestTimestampUtc);
                    await BulkCopyAsync(connection, transaction, tempLatest, latestReader, latestRowIndices.Count, LatestColumns);
                }

                await ApplyTelemetryBatchAsync(
                    connection,
                    transaction,
                    tempHistory,
                    historyTable,
                    tempLatest,
                    latestTable);

                await transaction.CommitAsync();
                _logger.LogDebug(
                    "SQL Server telemetry batch committed. Messages={MessageCount}, HistoryRows={HistoryRows}, LatestRows={LatestRows}",
                    messages.Count,
                    historyRows.Count,
                    latestRowIndices.Count);
                return new TelemetryBatchStoreResult(true, [], messages.Count);
            }
            catch
            {
                await transaction.RollbackAsync();
                throw;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SQL Server telemetry batch failed. MessageCount={MessageCount}", messages.Count);
            return new TelemetryBatchStoreResult(false, [], messages.Count);
        }
    }

    private static async Task CreateTempTablesAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        string tempHistory,
        string historyTable,
        string tempLatest,
        string latestTable)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = BuildCreateTempTablesCommandText(tempHistory, historyTable, tempLatest, latestTable);
        await command.ExecuteNonQueryAsync();
    }

    private static async Task BulkCopyAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        string destinationTable,
        IDataReader data,
        int rowCount,
        IReadOnlyCollection<string> columns)
    {
        using var bulkCopy = new SqlBulkCopy(connection, SqlBulkCopyOptions.TableLock, transaction)
        {
            DestinationTableName = destinationTable,
            BatchSize = Math.Clamp(rowCount, 1, 5000),
            BulkCopyTimeout = 60,
            EnableStreaming = true
        };
        foreach (var column in columns)
        {
            bulkCopy.ColumnMappings.Add(column, column);
        }

        await bulkCopy.WriteToServerAsync(data);
    }

    private static async Task ApplyTelemetryBatchAsync(
        SqlConnection connection,
        SqlTransaction transaction,
        string tempHistory,
        string historyTable,
        string tempLatest,
        string latestTable)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = BuildApplyTelemetryBatchCommandText(tempHistory, historyTable, tempLatest, latestTable);
        await command.ExecuteNonQueryAsync();
    }

    internal static string BuildCreateTempTablesCommandText(
        string tempHistory,
        string historyTable,
        string tempLatest,
        string latestTable)
        => $"""
            SELECT TOP (0) {ColumnList(HistoryColumns)} INTO {tempHistory} FROM {historyTable};
            SELECT TOP (0) {ColumnList(LatestColumns)} INTO {tempLatest} FROM {latestTable};
            """;

    internal static string BuildApplyTelemetryBatchCommandText(
        string tempHistory,
        string historyTable,
        string tempLatest,
        string latestTable)
    {
        var updateAssignments = string.Join(", ", LatestMutableColumns.Select(column => $"t.{Quote(column)} = s.{Quote(column)}"));
        return $"""
            INSERT INTO {historyTable} ({ColumnList(HistoryColumns)})
            SELECT {PrefixedColumnList("s", HistoryColumns)}
            FROM {tempHistory} AS s
            WHERE NOT EXISTS
            (
                SELECT 1
                FROM {historyTable} AS t WITH (UPDLOCK, HOLDLOCK)
                WHERE t.[DeviceId] = s.[DeviceId]
                  AND t.[KeyName] = s.[KeyName]
                  AND t.[DateTime] = s.[DateTime]
            );

            UPDATE t WITH (UPDLOCK, HOLDLOCK)
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
                FROM {latestTable} AS t WITH (UPDLOCK, HOLDLOCK)
                WHERE t.[Catalog] = s.[Catalog]
                  AND t.[DeviceId] = s.[DeviceId]
                  AND t.[KeyName] = s.[KeyName]
            );
            """;
    }

    internal sealed class TelemetryBulkDataReader : IDataReader
    {
        private static readonly object[] BoxedDataTypes =
        [
            (int)DataType.Boolean, (int)DataType.String, (int)DataType.Long, (int)DataType.Double,
            (int)DataType.Json, (int)DataType.XML, (int)DataType.Binary, (int)DataType.DateTime
        ];

        private static readonly string[] ValueColumns =
        [
            nameof(IDataStorage.DeviceId), nameof(IDataStorage.KeyName), nameof(IDataStorage.DateTime),
            nameof(IDataStorage.DataSide), nameof(IDataStorage.Type), nameof(IDataStorage.Value_Boolean),
            nameof(IDataStorage.Value_String), nameof(IDataStorage.Value_Long), nameof(IDataStorage.Value_DateTime),
            nameof(IDataStorage.Value_Double), nameof(IDataStorage.Value_Json), nameof(IDataStorage.Value_XML),
            nameof(IDataStorage.Value_Binary)
        ];

        private static readonly Type[] ValueTypes =
        [
            typeof(Guid), typeof(string), typeof(DateTime), typeof(int), typeof(int), typeof(bool),
            typeof(string), typeof(long), typeof(DateTime), typeof(double), typeof(string), typeof(string), typeof(byte[])
        ];

        private readonly IReadOnlyList<SqlServerTelemetryRow>? _rows;
        private readonly IReadOnlyList<TelemetryData>? _telemetryRows;
        private readonly IReadOnlyList<int>? _rowIndices;
        private readonly bool _includeCatalog;
        private readonly object? _catalogOverrideValue;
        private readonly object? _dateTimeOverrideValue;
        private int _index = -1;
        private bool _closed;

        public TelemetryBulkDataReader(
            IReadOnlyList<SqlServerTelemetryRow> rows,
            bool includeCatalog,
            IReadOnlyList<int>? rowIndices = null,
            DataCatalog? catalogOverride = null,
            DateTime? dateTimeOverride = null)
        {
            _rows = rows;
            _rowIndices = rowIndices;
            _includeCatalog = includeCatalog;
            _catalogOverrideValue = catalogOverride.HasValue ? (object)(int)catalogOverride.Value : null;
            _dateTimeOverrideValue = dateTimeOverride.HasValue ? (object)dateTimeOverride.Value : null;
        }

        public TelemetryBulkDataReader(
            IReadOnlyList<TelemetryData> rows,
            bool includeCatalog,
            IReadOnlyList<int>? rowIndices = null,
            DataCatalog? catalogOverride = null,
            DateTime? dateTimeOverride = null)
        {
            _telemetryRows = rows;
            _rowIndices = rowIndices;
            _includeCatalog = includeCatalog;
            _catalogOverrideValue = catalogOverride.HasValue ? (object)(int)catalogOverride.Value : null;
            _dateTimeOverrideValue = dateTimeOverride.HasValue ? (object)dateTimeOverride.Value : null;
        }

        public int FieldCount => ValueColumns.Length + (_includeCatalog ? 1 : 0);
        public object this[int i] => GetValue(i);
        public object this[string name] => GetValue(GetOrdinal(name));
        public int Depth => 0;
        public bool IsClosed => _closed;
        public int RecordsAffected => -1;

        public bool Read()
        {
            var count = _rowIndices?.Count ?? _telemetryRows?.Count ?? _rows?.Count ?? 0;
            if (_closed || _index + 1 >= count)
                return false;
            _index++;
            return true;
        }

        public string GetName(int i)
        {
            if (_includeCatalog)
                return i == 0 ? nameof(DataStorage.Catalog) : ValueColumns[i - 1];
            return ValueColumns[i];
        }

        public int GetOrdinal(string name)
        {
            if (_includeCatalog && string.Equals(name, nameof(DataStorage.Catalog), StringComparison.OrdinalIgnoreCase))
                return 0;
            for (var i = 0; i < ValueColumns.Length; i++)
            {
                if (string.Equals(ValueColumns[i], name, StringComparison.OrdinalIgnoreCase))
                    return i + (_includeCatalog ? 1 : 0);
            }
            throw new IndexOutOfRangeException(name);
        }

        public Type GetFieldType(int i)
        {
            if (_includeCatalog)
                return i == 0 ? typeof(int) : ValueTypes[i - 1];
            return ValueTypes[i];
        }

        public string GetDataTypeName(int i) => GetFieldType(i).Name;

        public object GetValue(int i)
        {
            var count = _rowIndices?.Count ?? _telemetryRows?.Count ?? _rows?.Count ?? 0;
            if (_index < 0 || _index >= count)
                throw new InvalidOperationException("Reader is not positioned on a row.");

            var rowIndex = _rowIndices is null ? _index : _rowIndices[_index];
            if (_includeCatalog)
            {
                if (i == 0)
                    return _catalogOverrideValue ?? (object)(int)DataCatalog.None;
                i--;
            }

            if (_telemetryRows is not null)
                return GetTelemetryValue(_telemetryRows[rowIndex], i);

            var value = _rows![rowIndex];

            return i switch
            {
                0 => value.DeviceIdValue,
                1 => value.KeyName,
                2 => _dateTimeOverrideValue ?? value.DateTimeValue,
                3 => value.DataSideValue,
                4 => BoxedDataTypes[(int)value.Type],
                5 => GetTypedValue(value, DataType.Boolean),
                6 => GetTypedValue(value, DataType.String),
                7 => GetTypedValue(value, DataType.Long),
                8 => GetTypedValue(value, DataType.DateTime),
                9 => GetTypedValue(value, DataType.Double),
                10 => GetTypedValue(value, DataType.Json),
                11 => GetTypedValue(value, DataType.XML),
                12 => GetTypedValue(value, DataType.Binary),
                _ => throw new IndexOutOfRangeException()
            };
        }

        private object GetTelemetryValue(TelemetryData value, int i)
        {
            return i switch
            {
                0 => value.DeviceId,
                1 => value.KeyName,
                2 => _dateTimeOverrideValue ?? value.DateTime,
                3 => (int)value.DataSide,
                4 => BoxedDataTypes[(int)value.Type],
                5 => value.Value_Boolean.HasValue ? value.Value_Boolean.Value : DBNull.Value,
                6 => value.Value_String ?? (object)DBNull.Value,
                7 => value.Value_Long.HasValue ? value.Value_Long.Value : DBNull.Value,
                8 => value.Value_DateTime.HasValue ? value.Value_DateTime.Value : DBNull.Value,
                9 => value.Value_Double.HasValue ? value.Value_Double.Value : DBNull.Value,
                10 => value.Value_Json ?? (object)DBNull.Value,
                11 => value.Value_XML ?? (object)DBNull.Value,
                12 => value.Value_Binary ?? (object)DBNull.Value,
                _ => throw new IndexOutOfRangeException()
            };
        }

        private static object GetTypedValue(in SqlServerTelemetryRow row, DataType expectedType)
        {
            if (!row.HasValue || row.Type != expectedType || row.Value is null)
                return DBNull.Value;

            var value = row.Value;
            if (value is System.Text.Json.JsonElement element)
            {
                return expectedType switch
                {
                    DataType.Boolean => element.GetBoolean(),
                    DataType.String => element.GetString() ?? (object)DBNull.Value,
                    DataType.Double => element.GetDouble(),
                    DataType.Json => element.GetRawText(),
                    _ => DBNull.Value
                };
            }

            return expectedType switch
            {
                DataType.Boolean => value is bool ? value : Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture),
                DataType.String => value is string ? value : value is char character ? character.ToString() : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? (object)DBNull.Value,
                DataType.Long => value is long ? value : Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture),
                DataType.DateTime => value is DateTime ? value : Convert.ToDateTime(value, System.Globalization.CultureInfo.InvariantCulture),
                DataType.Double => value is double ? value : Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture),
                DataType.Json => JsonObjectSerializer.Serialize(value),
                DataType.XML => value is System.Xml.XmlDocument xml ? xml.InnerXml : DBNull.Value,
                DataType.Binary => value is byte[] bytes ? bytes : DBNull.Value,
                _ => DBNull.Value
            };
        }

        public int GetValues(object[] values)
        {
            var count = Math.Min(values.Length, FieldCount);
            for (var i = 0; i < count; i++)
                values[i] = GetValue(i);
            return count;
        }

        public bool IsDBNull(int i) => GetValue(i) is DBNull;
        public bool NextResult() => false;
        public DataTable? GetSchemaTable() => null;
        public void Close() => _closed = true;
        public void Dispose() => Close();
        public IDataReader GetData(int i) => throw new NotSupportedException();
        public bool GetBoolean(int i) => (bool)GetValue(i);
        public byte GetByte(int i) => (byte)GetValue(i);
        public long GetBytes(int i, long fieldOffset, byte[]? buffer, int bufferoffset, int length)
        {
            var data = (byte[])GetValue(i);
            var available = Math.Max(0, data.Length - (int)fieldOffset);
            var count = Math.Min(length, available);
            if (buffer != null && count > 0)
                Array.Copy(data, fieldOffset, buffer, bufferoffset, count);
            return count;
        }
        public char GetChar(int i) => (char)GetValue(i);
        public long GetChars(int i, long fieldoffset, char[]? buffer, int bufferoffset, int length)
        {
            var data = GetString(i).ToCharArray();
            var available = Math.Max(0, data.Length - (int)fieldoffset);
            var count = Math.Min(length, available);
            if (buffer != null && count > 0)
                Array.Copy(data, fieldoffset, buffer, bufferoffset, count);
            return count;
        }
        public Guid GetGuid(int i) => (Guid)GetValue(i);
        public short GetInt16(int i) => Convert.ToInt16(GetValue(i));
        public int GetInt32(int i) => Convert.ToInt32(GetValue(i));
        public long GetInt64(int i) => Convert.ToInt64(GetValue(i));
        public float GetFloat(int i) => Convert.ToSingle(GetValue(i));
        public double GetDouble(int i) => Convert.ToDouble(GetValue(i));
        public string GetString(int i) => (string)GetValue(i);
        public decimal GetDecimal(int i) => Convert.ToDecimal(GetValue(i));
        public DateTime GetDateTime(int i) => (DateTime)GetValue(i);
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

internal sealed record SqlServerTelemetryBatch(
    List<TelemetryData> HistoryRows,
    List<TelemetryLatest> LatestRows);

internal sealed record SqlServerTelemetryWriteBatch(
    List<SqlServerTelemetryRow> HistoryRows,
    List<int> LatestSourceIndices,
    DateTime LatestTimestampUtc);

internal struct SqlServerTelemetryRow
{
    public object DeviceIdValue { get; set; }
    public string KeyName { get; set; }
    public object DateTimeValue { get; set; }
    public object DataSideValue { get; set; }
    public DataType Type { get; set; }
    public object Value { get; set; }
    public bool HasValue { get; set; }
}

internal static class SqlServerTelemetryBatchBuilder
{
    internal static SqlServerTelemetryBatch Build(
        IReadOnlyCollection<PlayloadData> messages,
        DateTime latestTimestampUtc)
    {
        var source = BuildMaterializedSourceRows(messages);
        var latestRows = new List<TelemetryLatest>(source.LatestSourceRows.Count);
        foreach (var item in source.LatestSourceRows)
        {
            latestRows.Add(ToLatest(item, latestTimestampUtc));
        }

        return new SqlServerTelemetryBatch(source.HistoryRows, latestRows);
    }

    internal static SqlServerTelemetryWriteBatch BuildForStorage(
        IReadOnlyCollection<PlayloadData> messages,
        DateTime latestTimestampUtc)
    {
        var estimatedPoints = 0;
        var maxPointsPerMessage = 0;
        var devices = new HashSet<Guid>();
        foreach (var message in messages)
        {
            var count = message.MsgBody?.Count ?? 0;
            estimatedPoints += count;
            maxPointsPerMessage = Math.Max(maxPointsPerMessage, count);
            devices.Add(message.DeviceId);
        }

        var estimatedLatest = Math.Min(estimatedPoints, devices.Count * maxPointsPerMessage);

        var historyRows = new List<SqlServerTelemetryRow>(estimatedPoints);
        var historyIndexByKey = new Dictionary<(Guid DeviceId, string KeyName, DateTime Timestamp), int>(estimatedPoints);
        var latestPositionByKey = new Dictionary<(Guid DeviceId, string KeyName), int>(estimatedLatest);
        var latestSourceIndices = new List<int>(estimatedLatest);

        foreach (var message in messages)
        {
            if (message.MsgBody is null)
            {
                continue;
            }

            object deviceIdValue = message.DeviceId;
            object dateTimeValue = message.ts;
            object dataSideValue = (int)message.DataSide;

            foreach (var pair in message.MsgBody)
            {
                if (pair.Key is null || pair.Value is null)
                {
                    continue;
                }

                var row = CreateStorageRow(pair, deviceIdValue, dateTimeValue, dataSideValue);
                var historyKey = (message.DeviceId, pair.Key, message.ts);
                ref var historyIndex = ref CollectionsMarshal.GetValueRefOrAddDefault(
                    historyIndexByKey,
                    historyKey,
                    out var historyExists);
                if (historyExists)
                {
                    historyRows[historyIndex] = row;
                }
                else
                {
                    historyIndex = historyRows.Count;
                    historyRows.Add(row);
                }

                var latestKey = (message.DeviceId, pair.Key);
                ref var latestPosition = ref CollectionsMarshal.GetValueRefOrAddDefault(
                    latestPositionByKey,
                    latestKey,
                    out var latestExists);
                if (latestExists)
                {
                    latestSourceIndices[latestPosition] = historyIndex;
                }
                else
                {
                    latestPosition = latestSourceIndices.Count;
                    latestSourceIndices.Add(historyIndex);
                }
            }
        }

        return new SqlServerTelemetryWriteBatch(historyRows, latestSourceIndices, latestTimestampUtc);
    }

    private static SqlServerTelemetryWriteBatchMaterialized BuildMaterializedSourceRows(
        IReadOnlyCollection<PlayloadData> messages)
    {
        var historyByKey = new Dictionary<(Guid DeviceId, string KeyName, DateTime Timestamp), TelemetryData>();
        var latestSourceByKey = new Dictionary<(Guid DeviceId, string KeyName), TelemetryData>();

        foreach (var message in messages)
        {
            foreach (var pair in message.MsgBody)
            {
                if (pair.Key is null || pair.Value is null)
                {
                    continue;
                }

                var history = new TelemetryData
                {
                    DeviceId = message.DeviceId,
                    KeyName = pair.Key,
                    DateTime = message.ts,
                    DataSide = message.DataSide
                };
                history.FillKVToMe(pair);
                historyByKey[(history.DeviceId, history.KeyName, history.DateTime)] = history;
                latestSourceByKey[(history.DeviceId, history.KeyName)] = history;
            }
        }

        return new SqlServerTelemetryWriteBatchMaterialized(
            new List<TelemetryData>(historyByKey.Values),
            new List<TelemetryData>(latestSourceByKey.Values));
    }

    private static SqlServerTelemetryRow CreateStorageRow(
        KeyValuePair<string, object> pair,
        object deviceIdValue,
        object dateTimeValue,
        object dataSideValue)
    {
        var row = new SqlServerTelemetryRow
        {
            DeviceIdValue = deviceIdValue,
            KeyName = pair.Key,
            DateTimeValue = dateTimeValue,
            DataSideValue = dataSideValue,
            Value = pair.Value
        };
        ClassifyStorageValue(ref row, pair.Value);
        return row;
    }

    private static void ClassifyStorageValue(ref SqlServerTelemetryRow row, object value)
    {
        switch (Type.GetTypeCode(value.GetType()))
        {
            case TypeCode.Boolean:
                row.Type = DataType.Boolean;
                row.HasValue = true;
                break;
            case TypeCode.Single:
            case TypeCode.Double:
            case TypeCode.Decimal:
                row.Type = DataType.Double;
                row.HasValue = true;
                break;
            case TypeCode.Int16:
            case TypeCode.Int32:
            case TypeCode.Int64:
            case TypeCode.UInt16:
            case TypeCode.UInt32:
            case TypeCode.UInt64:
            case TypeCode.Byte:
            case TypeCode.SByte:
                row.Type = DataType.Long;
                row.HasValue = true;
                break;
            case TypeCode.String:
            case TypeCode.Char:
                row.Type = DataType.String;
                row.HasValue = true;
                break;
            case TypeCode.DateTime:
                row.Type = DataType.DateTime;
                row.HasValue = true;
                break;
            case TypeCode.DBNull:
            case TypeCode.Empty:
                row.HasValue = false;
                break;
            case TypeCode.Object:
            default:
                ClassifyStorageObjectValue(ref row, value);
                break;
        }
    }

    private static void ClassifyStorageObjectValue(ref SqlServerTelemetryRow row, object value)
    {
        if (value is byte[])
        {
            row.Type = DataType.Binary;
            row.HasValue = true;
            return;
        }

        if (value is System.Xml.XmlDocument)
        {
            row.Type = DataType.XML;
            row.HasValue = true;
            return;
        }

        if (value is System.Text.Json.JsonElement element)
        {
            switch (element.ValueKind)
            {
                case System.Text.Json.JsonValueKind.Object:
                case System.Text.Json.JsonValueKind.Array:
                    row.Type = DataType.Json;
                    row.HasValue = true;
                    break;
                case System.Text.Json.JsonValueKind.String:
                    row.Type = DataType.String;
                    row.HasValue = true;
                    break;
                case System.Text.Json.JsonValueKind.Number:
                    row.Type = DataType.Double;
                    row.HasValue = true;
                    break;
                case System.Text.Json.JsonValueKind.True:
                case System.Text.Json.JsonValueKind.False:
                    row.Type = DataType.Boolean;
                    row.HasValue = true;
                    break;
                case System.Text.Json.JsonValueKind.Null:
                case System.Text.Json.JsonValueKind.Undefined:
                    row.HasValue = false;
                    break;
            }
            return;
        }

        row.Type = DataType.Json;
        row.HasValue = true;
    }

    private static TelemetryLatest ToLatest(TelemetryData source, DateTime latestTimestampUtc) => new()
    {
        Catalog = DataCatalog.TelemetryLatest,
        DeviceId = source.DeviceId,
        KeyName = source.KeyName,
        DateTime = latestTimestampUtc,
        DataSide = source.DataSide,
        Type = source.Type,
        Value_Boolean = source.Value_Boolean,
        Value_String = source.Value_String,
        Value_Long = source.Value_Long,
        Value_DateTime = source.Value_DateTime,
        Value_Double = source.Value_Double,
        Value_Json = source.Value_Json,
        Value_XML = source.Value_XML,
        Value_Binary = source.Value_Binary
    };

    private sealed record SqlServerTelemetryWriteBatchMaterialized(
        List<TelemetryData> HistoryRows,
        List<TelemetryData> LatestSourceRows);
}
