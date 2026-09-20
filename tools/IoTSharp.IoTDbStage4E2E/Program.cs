using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Xml;
using Apache.IoTDB;
using Apache.IoTDB.Data;
using Apache.IoTDB.DataStructure;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Storage;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using DataType = IoTSharp.Contracts.DataType;

const string ConnectionVariable = "IOTSHARP_IOTDB_E2E_CONNECTION";
const int MillionValues = 1_000_000;
const int MillionChunkValues = 100_000;

try
{
    if (args.Contains("--help", StringComparer.OrdinalIgnoreCase) || args.Contains("-h", StringComparer.OrdinalIgnoreCase))
    {
        Console.WriteLine("IoTSharp IoTDB Stage-4 E2E runner");
        Console.WriteLine("  --local-only                         Run Tablet/type/spool checks without a database.");
        Console.WriteLine("  --connection <connection-string>    Run the real IoTDB E2E suite.");
        Console.WriteLine($"  Or set {ConnectionVariable} and run without --connection.");
        return 0;
    }

    if (args.Contains("--local-only", StringComparer.OrdinalIgnoreCase))
    {
        await RunLocalChecksAsync();
        return 0;
    }

    var connectionString = ReadArg(args, "--connection") ?? Environment.GetEnvironmentVariable(ConnectionVariable);
    Ensure(!string.IsNullOrWhiteSpace(connectionString),
        $"Pass --connection <value> or set {ConnectionVariable}.");

    await RunRealE2EAsync(connectionString!);
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"IOTDB_STAGE4_E2E_FAIL type={ex.GetType().Name} message={ex.Message}");
    Console.Error.WriteLine(ex);
    return 1;
}

async Task RunLocalChecksAsync()
{
    const string dummyConnection =
        "DataSource=127.0.0.1;Username=root;Password=root;Port=6667;PoolSize=8;DefaultGroupName=stage4_local";

    var defaults = new AppSettings();
    Ensure(defaults.TelemetryIoTDBTabletRows == 10_000, "IoTDB default Tablet rows must be 10,000.");
    Ensure(defaults.TelemetryIoTDBTabletsPerWrite == 64, "IoTDB default Tablets-per-write must be 64.");
    Ensure(defaults.TelemetryIoTDBMaxValuesPerWrite == 250_000, "IoTDB default max values per RPC must be 250,000.");

    using var connection = new IoTDBConnection(StripCustomKey(dummyConnection, "DefaultGroupName"));
    var settings = CreateSettings(dummyConnection, 10_000, 64, 250_000);
    var writer = new IoTDBTelemetryHistoryWriter(
        connection,
        Options.Create(settings),
        NullLogger<IoTDBTelemetryHistoryWriter>.Instance);

    Ensure(writer.IsConfigured, "Configured IoTDB writer must advertise replay capability.");
    Ensure(writer.TabletRows == 10_000, "IoTDB TabletRows override mismatch.");
    Ensure(writer.TabletsPerWrite == 64, "IoTDB TabletsPerWrite override mismatch.");
    Ensure(writer.MaxValuesPerWrite == 250_000, "IoTDB MaxValuesPerWrite override mismatch.");

    var deviceId = Guid.NewGuid();
    var timestamp = DateTime.UtcNow.AddMinutes(-2);
    var rows = CreateNativeRows(deviceId, timestamp);

    var expectedTypes = new Dictionary<string, TSDataType>(StringComparer.Ordinal)
    {
        ["bool_value"] = TSDataType.BOOLEAN,
        ["string_value"] = TSDataType.STRING,
        ["long_value"] = TSDataType.INT64,
        ["double_value"] = TSDataType.DOUBLE,
        ["json_value"] = TSDataType.STRING,
        ["xml_value"] = TSDataType.STRING,
        ["binary_value"] = TSDataType.BLOB,
        ["datetime_value"] = TSDataType.DATE
    };

    foreach (var row in rows)
    {
        var mapping = InvokeTypeMapping(row);
        Ensure(mapping.Success, $"IoTDB type mapping rejected {row.KeyName}.");
        Ensure(mapping.DataType == expectedTypes[row.KeyName],
            $"IoTDB type mapping mismatch for {row.KeyName}. Expected={expectedTypes[row.KeyName]} Actual={mapping.DataType}");
    }

    var tablets = InvokeBuildTablets(rows, "stage4_local", 10_000);
    Ensure(tablets.Count == 1, $"Expected one dense native-type Tablet, actual={tablets.Count}.");
    var nativeTablet = tablets[0];
    Ensure(nativeTablet.RowNumber == 1, $"Expected one native Tablet row, actual={nativeTablet.RowNumber}.");
    Ensure(nativeTablet.ColNumber == 8, $"Expected eight native Tablet columns, actual={nativeTablet.ColNumber}.");
    Ensure(nativeTablet.Measurements.Count == 8, "Expected eight measurements in native Tablet.");
    _ = nativeTablet.GetBinaryValues();

    var groupingRows = new List<TelemetryData>();
    var groupingStart = timestamp.AddSeconds(5);
    var groupingDevices = new[] { Guid.NewGuid(), Guid.NewGuid() };
    foreach (var groupingDevice in groupingDevices)
    {
        for (var index = 0; index < 3; index++)
        {
            groupingRows.Add(new TelemetryData
            {
                DeviceId = groupingDevice,
                KeyName = "temperature",
                DateTime = groupingStart.AddMilliseconds(index),
                DataSide = DataSide.ClientSide,
                Type = DataType.Double,
                Value_Double = 20.0d + index
            });
        }
    }

    var groupedTablets = InvokeBuildTablets(groupingRows, "stage4_local", 2);
    Ensure(groupedTablets.Count == 4, $"Expected four device/chunk Tablets, actual={groupedTablets.Count}.");
    Ensure(groupedTablets.All(tablet => tablet.RowNumber is > 0 and <= 2), "Tablet row chunk bound regression.");
    Ensure(groupedTablets.Select(tablet => tablet.InsertTargetName).Distinct(StringComparer.Ordinal).Count() == 2,
        "Rows from two devices must remain in separate Tablets.");

    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage4-iotdb-local", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(spoolDirectory);
    try
    {
        settings.TelemetryHistorySpool = new TelemetryHistorySpoolSetting
        {
            Enabled = true,
            Directory = spoolDirectory,
            RetryDelayMilliseconds = 50,
            IdleDelayMilliseconds = 25
        };

        var message = CreateNativeMessage(deviceId, timestamp);
        var process1 = new TelemetryHistorySpool(
            new EventBusOption { AppSettings = settings },
            NullLogger<TelemetryHistorySpool>.Instance);
        var first = await process1.EnqueueAsync([message]);
        Ensure(first.RowCount == 8 && !first.Deduplicated,
            "Initial IoTDB durable spool enqueue must contain exactly 8 rows.");

        var duplicate = await process1.EnqueueAsync([message]);
        Ensure(duplicate.Deduplicated, "Identical IoTDB spool enqueue must deduplicate.");

        var process2 = new TelemetryHistorySpool(
            new EventBusOption { AppSettings = settings },
            NullLogger<TelemetryHistorySpool>.Instance);
        await process2.RecoverAsync();
        var recovered = await process2.PeekOldestAsync();
        Ensure(recovered is not null && recovered.Rows.Count == 8,
            "Restarted IoTDB spool must recover exactly 8 materialized rows.");
        await process2.AckAsync(recovered!);
        Ensure(process2.GetBacklogSnapshot().PendingBatches == 0,
            "ACK must clear IoTDB local recovered spool backlog.");
    }
    finally
    {
        TryDeleteDirectory(spoolDirectory);
    }

    Console.WriteLine(
        "IOTDB_STAGE4_LOCAL_PASS replay=true tablet_rows=10000 tablets_per_write=64 max_values_per_write=250000 native_types=8 device_grouping=pass spool_restart=pass binary_serialization=pass");
}

async Task RunRealE2EAsync(string rawConnectionString)
{
    var runSuffix = Guid.NewGuid().ToString("N")[..10];
    var configuredGroup = ReadCustomKey(rawConnectionString, "DefaultGroupName") ?? "iotsharp";
    var group = SanitizeGroup($"{configuredGroup}_stage4_{runSuffix}");
    var writerConnectionString = SetCustomKey(rawConnectionString, "DefaultGroupName", group);
    var nativeConnectionString = StripCustomKey(rawConnectionString, "DefaultGroupName");

    using var connection = new IoTDBConnection(nativeConnectionString);
    var pool = connection.SessionPool;
    await pool.Open();

    var databasePath = $"root.{group}";
    try
    {
        await pool.CreateDatabase(databasePath);

        var settings = CreateSettings(writerConnectionString, 10_000, 64, 250_000);
        var writer = new IoTDBTelemetryHistoryWriter(
            connection,
            Options.Create(settings),
            NullLogger<IoTDBTelemetryHistoryWriter>.Instance);
        Ensure(writer.IsConfigured, "IoTDB writer did not advertise replay capability.");

        await RunNativeTypesAndDuplicateReplayAsync(writer, pool, group);
        await RunMillionValuesAsync(writer, pool, group);
        await RunDurableRestartAsync(writer, pool, settings, group);

        Console.WriteLine(
            "IOTDB_STAGE4_E2E_PASS native_types=8 duplicate_replay=idempotent million_values=1000000 durable_restart=pass tablet_rows=10000 max_values_per_write=250000");
    }
    finally
    {
        try
        {
            await pool.DeleteDatabaseAsync(databasePath);
        }
        catch (Exception cleanupEx)
        {
            Console.Error.WriteLine($"IOTDB_STAGE4_CLEANUP_WARN database={databasePath} message={cleanupEx.Message}");
        }

        try
        {
            await pool.Close();
        }
        catch
        {
            // Process exit remains safe even if the server already closed the pool.
        }
    }
}

async Task RunNativeTypesAndDuplicateReplayAsync(
    IoTDBTelemetryHistoryWriter writer,
    SessionPool pool,
    string group)
{
    var deviceId = Guid.NewGuid();
    var timestamp = DateTime.UtcNow.AddMinutes(-5);
    var rows = CreateNativeRows(deviceId, timestamp);

    var first = await writer.WriteRowsAsync(rows, 1);
    Ensure(first.Result, "IoTDB native-type materialized write failed.");
    var firstCount = await CountKeysAsync(pool, group, deviceId, rows.Select(row => row.KeyName));
    Ensure(firstCount == 8, $"Expected 8 IoTDB native values after first replay, actual={firstCount}.");

    var second = await writer.WriteRowsAsync(rows, 1);
    Ensure(second.Result, "IoTDB duplicate materialized replay failed.");
    var secondCount = await CountKeysAsync(pool, group, deviceId, rows.Select(row => row.KeyName));
    Ensure(secondCount == 8,
        $"IoTDB duplicate replay was not idempotent. Expected=8 Actual={secondCount}.");

    Console.WriteLine(
        "IOTDB_STAGE4_TYPES_PASS values=8 duplicate_count=8 types=boolean,string,long,double,json,xml,binary,datetime");
}

async Task RunMillionValuesAsync(
    IoTDBTelemetryHistoryWriter writer,
    SessionPool pool,
    string group)
{
    var deviceId = Guid.NewGuid();
    var baseTime = DateTime.UtcNow.AddMinutes(-25);
    var stopwatch = Stopwatch.StartNew();

    for (var offset = 0; offset < MillionValues; offset += MillionChunkValues)
    {
        var count = Math.Min(MillionChunkValues, MillionValues - offset);
        var rows = CreateDoubleRows(deviceId, "million_value", count, baseTime, offset);
        var result = await writer.WriteRowsAsync(rows, count);
        Ensure(result.Result, $"IoTDB million-value write failed at offset={offset}.");
    }

    stopwatch.Stop();
    var actual = await CountKeyAsync(pool, group, deviceId, "million_value");
    Ensure(actual == MillionValues,
        $"IoTDB one-million exact count mismatch. Expected={MillionValues} Actual={actual}");

    var rate = MillionValues / Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    Console.WriteLine(
        $"IOTDB_STAGE4_MILLION_PASS values={actual} chunk_values={MillionChunkValues} tablet_rows=10000 elapsed_ms={stopwatch.Elapsed.TotalMilliseconds:F0} values_per_sec={rate:F0} max_values_per_write=250000");
}

async Task RunDurableRestartAsync(
    IoTDBTelemetryHistoryWriter writer,
    SessionPool pool,
    AppSettings settings,
    string group)
{
    var deviceId = Guid.NewGuid();
    var timestamp = DateTime.UtcNow.AddMinutes(-2);
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage4-iotdb-spool", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(spoolDirectory);

    try
    {
        settings.TelemetryHistorySpool = new TelemetryHistorySpoolSetting
        {
            Enabled = true,
            Directory = spoolDirectory,
            RetryDelayMilliseconds = 50,
            IdleDelayMilliseconds = 25
        };

        var message = CreateNativeMessage(deviceId, timestamp);
        var process1 = new TelemetryHistorySpool(
            new EventBusOption { AppSettings = settings },
            NullLogger<TelemetryHistorySpool>.Instance);
        var enqueue = await process1.EnqueueAsync([message]);
        Ensure(enqueue.RowCount == 8, "Expected 8 IoTDB durable rows before restart.");
        Ensure(process1.GetBacklogSnapshot().PendingBatches == 1,
            "Expected one pending IoTDB durable batch before restart.");

        var process2 = new TelemetryHistorySpool(
            new EventBusOption { AppSettings = settings },
            NullLogger<TelemetryHistorySpool>.Instance);
        await process2.RecoverAsync();
        var recovered = await process2.PeekOldestAsync();
        Ensure(recovered is not null && recovered.Rows.Count == 8,
            "IoTDB restart recovery did not materialize the expected 8 rows.");

        var replay = await writer.WriteRowsAsync(recovered!.Rows, recovered.MessageCount);
        Ensure(replay.Result, "IoTDB durable History replay failed after restart.");
        await process2.AckAsync(recovered);
        Ensure(process2.GetBacklogSnapshot().PendingBatches == 0,
            "IoTDB durable backlog did not clear after ACK.");

        var persisted = await CountKeysAsync(pool, group, deviceId, recovered.Rows.Select(row => row.KeyName));
        Ensure(persisted == 8,
            $"IoTDB durable restart count mismatch. Expected=8 Actual={persisted}");

        Console.WriteLine(
            "IOTDB_STAGE4_RESTART_PASS pending_before=1 recovered_rows=8 pending_after=0 persisted_values=8");
    }
    finally
    {
        TryDeleteDirectory(spoolDirectory);
    }
}

(TypeMapping mapping, bool unused) Dummy() => (default, false);

TypeMapping InvokeTypeMapping(TelemetryData row)
{
    var method = typeof(IoTDBTelemetryHistoryWriter).GetMethod(
        "TryGetTabletValue",
        BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new MissingMethodException(nameof(IoTDBTelemetryHistoryWriter), "TryGetTabletValue");

    object?[] values = [row, null, null];
    var success = (bool)(method.Invoke(null, values) ?? false);
    return new TypeMapping(success, success ? (TSDataType)values[1]! : TSDataType.NONE, values[2]);
}

List<Tablet> InvokeBuildTablets(
    IReadOnlyCollection<TelemetryData> rows,
    string group,
    int tabletRows)
{
    var method = typeof(IoTDBTelemetryHistoryWriter).GetMethod(
        "BuildTablets",
        BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new MissingMethodException(nameof(IoTDBTelemetryHistoryWriter), "BuildTablets");

    var result = method.Invoke(null, [rows, group, tabletRows])
        ?? throw new InvalidOperationException("BuildTablets returned null.");
    return ((IEnumerable<Tablet>)result).ToList();
}

async Task<long> CountKeysAsync(
    SessionPool pool,
    string group,
    Guid deviceId,
    IEnumerable<string> keys)
{
    long total = 0;
    foreach (var key in keys.Distinct(StringComparer.Ordinal))
        total += await CountKeyAsync(pool, group, deviceId, key);
    return total;
}

async Task<long> CountKeyAsync(
    SessionPool pool,
    string group,
    Guid deviceId,
    string key)
{
    var devicePath = $"root.{group}.{deviceId:N}";
    using var query = await pool.ExecuteQueryStatementAsync(
        $"select count({QuoteIdentifier(key)}) from {devicePath}");

    if (!query.HasNext())
        return 0;

    var row = query.Next();
    var value = row.Values.FirstOrDefault(item => item is not null
        && !string.Equals(Convert.ToString(item, CultureInfo.InvariantCulture), "NULL", StringComparison.OrdinalIgnoreCase));

    return value is null ? 0 : Convert.ToInt64(value, CultureInfo.InvariantCulture);
}

List<TelemetryData> CreateNativeRows(Guid deviceId, DateTime timestamp)
{
    var valueDate = new DateTime(2026, 9, 18, 8, 30, 15, DateTimeKind.Utc);
    return
    [
        new() { DeviceId = deviceId, KeyName = "bool_value", DateTime = timestamp, Type = DataType.Boolean, Value_Boolean = true },
        new() { DeviceId = deviceId, KeyName = "string_value", DateTime = timestamp, Type = DataType.String, Value_String = "stage4-string" },
        new() { DeviceId = deviceId, KeyName = "long_value", DateTime = timestamp, Type = DataType.Long, Value_Long = 42L },
        new() { DeviceId = deviceId, KeyName = "double_value", DateTime = timestamp, Type = DataType.Double, Value_Double = 12.5d },
        new() { DeviceId = deviceId, KeyName = "json_value", DateTime = timestamp, Type = DataType.Json, Value_Json = "{\"phase\":4}" },
        new() { DeviceId = deviceId, KeyName = "xml_value", DateTime = timestamp, Type = DataType.XML, Value_XML = "<stage4><value>ok</value></stage4>" },
        new() { DeviceId = deviceId, KeyName = "binary_value", DateTime = timestamp, Type = DataType.Binary, Value_Binary = [0x01, 0x02, 0xFE] },
        new() { DeviceId = deviceId, KeyName = "datetime_value", DateTime = timestamp, Type = DataType.DateTime, Value_DateTime = valueDate }
    ];
}

PlayloadData CreateNativeMessage(Guid deviceId, DateTime timestamp)
{
    using var json = JsonDocument.Parse("{\"phase\":4}");
    var jsonElement = json.RootElement.Clone();
    var xml = new XmlDocument();
    xml.LoadXml("<stage4><value>ok</value></stage4>");

    return new PlayloadData
    {
        DeviceId = deviceId,
        ts = timestamp,
        ServerIngestedAtUtc = DateTime.UtcNow,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object>
        {
            ["bool_value"] = true,
            ["string_value"] = "stage4-string",
            ["long_value"] = 42L,
            ["double_value"] = 12.5d,
            ["json_value"] = jsonElement,
            ["xml_value"] = xml,
            ["binary_value"] = new byte[] { 0x01, 0x02, 0xFE },
            ["datetime_value"] = new DateTime(2026, 9, 18, 8, 30, 15, DateTimeKind.Utc)
        }
    };
}

List<TelemetryData> CreateDoubleRows(
    Guid deviceId,
    string key,
    int count,
    DateTime baseTime,
    int globalOffset)
{
    var rows = new List<TelemetryData>(count);
    for (var index = 0; index < count; index++)
    {
        var absoluteIndex = globalOffset + index;
        rows.Add(new TelemetryData
        {
            DeviceId = deviceId,
            KeyName = key,
            DateTime = baseTime.AddMilliseconds(absoluteIndex),
            DataSide = DataSide.ClientSide,
            Type = DataType.Double,
            Value_Double = absoluteIndex * 0.001d
        });
    }

    return rows;
}

AppSettings CreateSettings(
    string connectionString,
    int tabletRows,
    int tabletsPerWrite,
    int maxValuesPerWrite)
    => new()
    {
        TelemetryIoTDBTabletRows = tabletRows,
        TelemetryIoTDBTabletsPerWrite = tabletsPerWrite,
        TelemetryIoTDBMaxValuesPerWrite = maxValuesPerWrite,
        ConnectionStrings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["TelemetryStorage"] = connectionString
        }
    };

string? ReadArg(string[] values, string name)
{
    for (var index = 0; index < values.Length; index++)
    {
        if (!string.Equals(values[index], name, StringComparison.OrdinalIgnoreCase))
            continue;
        if (index + 1 >= values.Length)
            throw new ArgumentException($"{name} requires a value.");
        return values[index + 1];
    }

    return null;
}

string StripCustomKey(string connectionString, string key)
    => string.Join(
        ';',
        connectionString
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(item =>
            {
                var pair = item.Split('=', 2, StringSplitOptions.TrimEntries);
                return pair.Length != 2 || !pair[0].Equals(key, StringComparison.OrdinalIgnoreCase);
            }));

string? ReadCustomKey(string connectionString, string key)
{
    foreach (var item in connectionString.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    {
        var pair = item.Split('=', 2, StringSplitOptions.TrimEntries);
        if (pair.Length == 2 && pair[0].Equals(key, StringComparison.OrdinalIgnoreCase))
            return pair[1];
    }

    return null;
}

string SetCustomKey(string connectionString, string key, string value)
{
    var stripped = StripCustomKey(connectionString, key);
    return string.IsNullOrWhiteSpace(stripped)
        ? $"{key}={value}"
        : $"{stripped};{key}={value}";
}

string SanitizeGroup(string value)
{
    var chars = value
        .Select(ch => char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_')
        .ToArray();
    var result = new string(chars).Trim('_');
    return string.IsNullOrWhiteSpace(result) ? $"iotsharp_stage4_{Guid.NewGuid():N}" : result;
}

string QuoteIdentifier(string value)
    => value;

void Ensure(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

void TryDeleteDirectory(string path)
{
    try
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
    }
    catch
    {
        // Local temp cleanup failure should not hide the E2E result.
    }
}

readonly record struct TypeMapping(bool Success, TSDataType DataType, object? Value);
