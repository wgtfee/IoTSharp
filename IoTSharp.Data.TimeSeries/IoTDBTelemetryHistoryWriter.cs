using Apache.IoTDB;
using Apache.IoTDB.Data;
using Apache.IoTDB.DataStructure;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace IoTSharp.Storage;

/// <summary>
/// High-throughput IoTDB History writer using native Tablet / InsertTablets APIs.
/// Rows are grouped by device and stable measurement schema so each tablet stays dense.
/// </summary>
public sealed class IoTDBTelemetryHistoryWriter
{
    private readonly SessionPool _session;
    private readonly ILogger<IoTDBTelemetryHistoryWriter> _logger;
    private readonly string _storageGroupName;
    private readonly int _tabletRows;
    private readonly int _tabletsPerWrite;
    private readonly int _maxValuesPerWrite;
    private readonly bool _isConfigured;
    private readonly SemaphoreSlim _openLock = new(1, 1);

    public IoTDBTelemetryHistoryWriter(
        IoTDBConnection ioTDB,
        IOptions<AppSettings> options,
        ILogger<IoTDBTelemetryHistoryWriter> logger)
    {
        _session = ioTDB.SessionPool;
        _logger = logger;

        var settings = options.Value;
        _tabletRows = Math.Clamp(settings.TelemetryIoTDBTabletRows, 1_000, 100_000);
        _tabletsPerWrite = Math.Clamp(settings.TelemetryIoTDBTabletsPerWrite, 1, 256);
        _maxValuesPerWrite = Math.Clamp(settings.TelemetryIoTDBMaxValuesPerWrite, 10_000, 5_000_000);

        string? connectionString = null;
        _isConfigured = settings.ConnectionStrings?.TryGetValue("TelemetryStorage", out connectionString) == true
            && !string.IsNullOrWhiteSpace(connectionString);
        _storageGroupName = ResolveStorageGroupName(connectionString);
    }

    public bool IsConfigured => _isConfigured && !string.IsNullOrWhiteSpace(_storageGroupName);
    public int TabletRows => _tabletRows;
    public int TabletsPerWrite => _tabletsPerWrite;
    public int MaxValuesPerWrite => _maxValuesPerWrite;

    public async Task<TelemetryBatchStoreResult> WriteMessagesAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
            return new TelemetryBatchStoreResult(true, [], 0);

        var rows = Materialize(messages);
        return await WriteRowsCoreAsync(rows, messages.Count);
    }

    public Task<TelemetryBatchStoreResult> WriteRowsAsync(
        IReadOnlyCollection<TelemetryData> rows,
        int messageCount)
        => WriteRowsCoreAsync(rows, messageCount);

    private async Task<TelemetryBatchStoreResult> WriteRowsCoreAsync(
        IReadOnlyCollection<TelemetryData> rows,
        int messageCount)
    {
        if (rows.Count == 0)
            return new TelemetryBatchStoreResult(true, [], messageCount);

        try
        {
            EnsureConfigured();
            await EnsureOpenAsync();

            var batch = new List<Tablet>(_tabletsPerWrite);
            var batchValues = 0;
            var tabletCount = 0;

            foreach (var tablet in BuildTablets(rows, _storageGroupName, _tabletRows))
            {
                var tabletValues = checked(tablet.RowNumber * tablet.ColNumber);
                if (batch.Count > 0
                    && (batch.Count >= _tabletsPerWrite
                        || batchValues + tabletValues > _maxValuesPerWrite))
                {
                    await FlushTabletsAsync(batch);
                    batchValues = 0;
                }

                batch.Add(tablet);
                batchValues += tabletValues;
                tabletCount++;

                if (batch.Count >= _tabletsPerWrite || batchValues >= _maxValuesPerWrite)
                {
                    await FlushTabletsAsync(batch);
                    batchValues = 0;
                }
            }

            if (batch.Count > 0)
                await FlushTabletsAsync(batch);

            _logger.LogInformation(
                "IoTDB Tablet History write completed. Messages={Messages}, Rows={Rows}, Tablets={Tablets}, TabletRows={TabletRows}, TabletsPerWrite={TabletsPerWrite}, MaxValuesPerWrite={MaxValuesPerWrite}",
                messageCount,
                rows.Count,
                tabletCount,
                _tabletRows,
                _tabletsPerWrite,
                _maxValuesPerWrite);

            return new TelemetryBatchStoreResult(true, AsList(rows), messageCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "IoTDB Tablet History write failed. Messages={Messages}, Rows={Rows}, TabletRows={TabletRows}, TabletsPerWrite={TabletsPerWrite}, MaxValuesPerWrite={MaxValuesPerWrite}",
                messageCount,
                rows.Count,
                _tabletRows,
                _tabletsPerWrite,
                _maxValuesPerWrite);
            return new TelemetryBatchStoreResult(false, AsList(rows), messageCount);
        }
    }

    private async Task FlushTabletsAsync(List<Tablet> batch)
    {
        var status = await _session.InsertTabletsAsync(batch);
        if (status != 0)
            throw new InvalidOperationException($"IoTDB InsertTabletsAsync returned status {status}.");
        batch.Clear();
    }

    internal static List<TelemetryData> Materialize(IReadOnlyCollection<PlayloadData> messages)
    {
        var rows = new List<TelemetryData>();

        foreach (var message in messages)
        {
            foreach (var item in message.MsgBody)
            {
                if (item.Value is null)
                    continue;

                var row = new TelemetryData
                {
                    DateTime = message.ts,
                    DeviceId = message.DeviceId,
                    KeyName = item.Key,
                    DataSide = message.DataSide,
                    Value_DateTime = DateTime.UnixEpoch
                };
                row.FillKVToMe(item);

                if (TryGetTabletValue(row, out _, out _))
                    rows.Add(row);
            }
        }

        return rows;
    }

    internal static IEnumerable<Tablet> BuildTablets(
        IReadOnlyCollection<TelemetryData> rows,
        string storageGroupName,
        int tabletRows)
    {
        var maxRows = Math.Clamp(tabletRows, 1, 100_000);

        foreach (var deviceGroup in rows.GroupBy(row => row.DeviceId))
        {
            var devicePath = $"root.{storageGroupName}.{deviceGroup.Key:N}";
            var deviceRows = deviceGroup.ToList();
            IEnumerable<TelemetryData> orderedRows = IsNonDecreasingByTimestamp(deviceRows)
                ? deviceRows
                : deviceRows.OrderBy(row => ToUnixMilliseconds(row.DateTime));

            var builders = new Dictionary<string, TabletAccumulator>(StringComparer.Ordinal);
            var frameRows = new Dictionary<string, TelemetryData>(StringComparer.Ordinal);
            long? currentTimestamp = null;

            foreach (var row in orderedRows)
            {
                var timestamp = ToUnixMilliseconds(row.DateTime);
                if (currentTimestamp.HasValue && timestamp != currentTimestamp.Value)
                {
                    var ready = AddFrame(devicePath, currentTimestamp.Value, frameRows.Values, builders, maxRows);
                    if (ready is not null)
                        yield return ready;
                    frameRows.Clear();
                }

                currentTimestamp = timestamp;
                frameRows[row.KeyName] = row;
            }

            if (currentTimestamp.HasValue && frameRows.Count > 0)
            {
                var ready = AddFrame(devicePath, currentTimestamp.Value, frameRows.Values, builders, maxRows);
                if (ready is not null)
                    yield return ready;
            }

            foreach (var builder in builders.Values)
            {
                if (builder.RowCount > 0)
                    yield return builder.Build(devicePath);
            }
        }
    }

    private static bool IsNonDecreasingByTimestamp(IReadOnlyList<TelemetryData> rows)
    {
        if (rows.Count < 2)
            return true;

        var previous = ToUnixMilliseconds(rows[0].DateTime);
        for (var index = 1; index < rows.Count; index++)
        {
            var current = ToUnixMilliseconds(rows[index].DateTime);
            if (current < previous)
                return false;
            previous = current;
        }
        return true;
    }

    private static Tablet? AddFrame(
        string devicePath,
        long timestamp,
        IEnumerable<TelemetryData> rows,
        Dictionary<string, TabletAccumulator> builders,
        int maxRows)
    {
        var frame = BuildFrame(timestamp, rows);
        if (frame.Cells.Count == 0)
            return null;

        if (!builders.TryGetValue(frame.Signature, out var builder))
        {
            builder = new TabletAccumulator(frame.Cells);
            builders.Add(frame.Signature, builder);
        }

        builder.Add(frame.Timestamp, frame.Cells);
        if (builder.RowCount < maxRows)
            return null;

        builders.Remove(frame.Signature);
        return builder.Build(devicePath);
    }

    private static TabletFrame BuildFrame(long timestamp, IEnumerable<TelemetryData> rows)
    {
        var cells = rows
            .GroupBy(row => row.KeyName, StringComparer.Ordinal)
            .Select(group => group.Last())
            .Select(row =>
            {
                if (!TryGetTabletValue(row, out var dataType, out var value))
                    return null;
                return new TabletCell(row.KeyName, dataType, value!);
            })
            .Where(cell => cell is not null)
            .Select(cell => cell!)
            .OrderBy(cell => cell.Key, StringComparer.Ordinal)
            .ToList();

        var signature = string.Join(
            "\u001f",
            cells.Select(cell => $"{cell.Key}\u001e{(int)cell.DataType}"));

        return new TabletFrame(timestamp, signature, cells);
    }

    internal static bool TryGetTabletValue(
        TelemetryData row,
        out TSDataType dataType,
        out object? value)
    {
        dataType = TSDataType.NONE;
        value = null;

        switch (row.Type)
        {
            case DataType.Boolean when row.Value_Boolean.HasValue:
                dataType = TSDataType.BOOLEAN;
                value = row.Value_Boolean.Value;
                return true;
            case DataType.String when row.Value_String is not null:
                dataType = TSDataType.STRING;
                value = row.Value_String;
                return true;
            case DataType.Long when row.Value_Long.HasValue:
                dataType = TSDataType.INT64;
                value = row.Value_Long.Value;
                return true;
            case DataType.Double when row.Value_Double.HasValue && double.IsFinite(row.Value_Double.Value):
                dataType = TSDataType.DOUBLE;
                value = row.Value_Double.Value;
                return true;
            case DataType.Json when row.Value_Json is not null:
                dataType = TSDataType.STRING;
                value = row.Value_Json;
                return true;
            case DataType.XML when row.Value_XML is not null:
                dataType = TSDataType.STRING;
                value = row.Value_XML;
                return true;
            case DataType.Binary when row.Value_Binary is not null:
                dataType = TSDataType.BLOB;
                value = row.Value_Binary;
                return true;
            case DataType.DateTime when row.Value_DateTime.HasValue:
                dataType = TSDataType.DATE;
                value = row.Value_DateTime.Value;
                return true;
            default:
                return false;
        }
    }

    private async Task EnsureOpenAsync()
    {
        if (_session.IsOpen())
            return;

        await _openLock.WaitAsync();
        try
        {
            if (!_session.IsOpen())
                await _session.Open();
        }
        finally
        {
            _openLock.Release();
        }
    }

    private void EnsureConfigured()
    {
        if (!IsConfigured)
            throw new InvalidOperationException(
                "IoTDB telemetry History writer requires ConnectionStrings:TelemetryStorage.");
    }

    private static string ResolveStorageGroupName(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
            return "iotsharp";

        foreach (var item in connectionString.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var pair = item.Split('=', 2, StringSplitOptions.TrimEntries);
            if (pair.Length == 2
                && pair[0].Equals("DefaultGroupName", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(pair[1]))
                return pair[1];
        }

        return "iotsharp";
    }

    private static long ToUnixMilliseconds(DateTime value)
    {
        var utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
    }

    private static List<TelemetryData> AsList(IReadOnlyCollection<TelemetryData> rows)
        => rows as List<TelemetryData> ?? rows.ToList();

    private sealed class TabletAccumulator
    {
        private readonly List<string> _measurements;
        private readonly List<TSDataType> _dataTypes;
        private readonly List<List<object>> _values = [];
        private readonly List<long> _timestamps = [];

        public TabletAccumulator(IReadOnlyList<TabletCell> cells)
        {
            _measurements = cells.Select(cell => cell.Key).ToList();
            _dataTypes = cells.Select(cell => cell.DataType).ToList();
        }

        public int RowCount => _timestamps.Count;

        public void Add(long timestamp, IReadOnlyList<TabletCell> cells)
        {
            _timestamps.Add(timestamp);
            _values.Add(cells.Select(cell => cell.Value).ToList());
        }

        public Tablet Build(string devicePath)
            => new(devicePath, _measurements, _dataTypes, _values, _timestamps);
    }

    private sealed record TabletCell(string Key, TSDataType DataType, object Value);
    private sealed record TabletFrame(long Timestamp, string Signature, List<TabletCell> Cells);
}
