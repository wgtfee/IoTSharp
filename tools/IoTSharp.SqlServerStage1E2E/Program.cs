using System.Diagnostics;
using System.Text.Json;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using DataType = IoTSharp.Contracts.DataType;
const string ConnectionVariable = "IOTSHARP_SQLSERVER_E2E_CONNECTION";
const int MillionRows = 1_000_000;
var testMonth = new DateTime(2099, 12, 1, 0, 0, 0, DateTimeKind.Utc);
try
{
    if (args.Contains("--help", StringComparer.OrdinalIgnoreCase) || args.Contains("-h", StringComparer.OrdinalIgnoreCase))
    {
        Console.WriteLine("IoTSharp SQL Server Stage-1 E2E runner");
        Console.WriteLine("  --local-only                         Validate SQL Server replay capability without a database.");
        Console.WriteLine("  --connection <connection-string>    Run against an explicit SQL Server connection.");
        Console.WriteLine("  --soak-only --soak-seconds <n>       Run bounded soak (3600/14400/86400 supported).");
        Console.WriteLine("  --soak-batch-rows <n>                Rows per soak write (default 10000).");
        Console.WriteLine("  --soak-window-rows <n>               Verify then truncate at this size (default 1000000).");
        Console.WriteLine("  --report-seconds <n>                 Progress interval (default 5).");
        Console.WriteLine($"  Or set {ConnectionVariable}; otherwise IoTSharp/appsettings.SQLServer.json is used.");
        return 0;
    }
    if (args.Contains("--local-only", StringComparer.OrdinalIgnoreCase))
    {
        RunLocalChecks();
        Console.WriteLine("SQLSERVER_STAGE1_LOCAL_PASS monthly_replay=true daily_replay=false missing_connection=false transaction_rows=50000");
        return 0;
    }
    var connectionString = ReadConnectionString(args)
        ?? throw new InvalidOperationException($"Pass --connection <value>, set {ConnectionVariable}, or configure IoTSharp/appsettings.SQLServer.json.");
    if (args.Contains("--soak-only", StringComparer.OrdinalIgnoreCase))
    {
        await RunSoakAsync(
            connectionString,
            TimeSpan.FromSeconds(ReadIntArg(args, "--soak-seconds", 10, 1, 604800)),
            ReadIntArg(args, "--soak-batch-rows", 10_000, 100, 100_000),
            ReadIntArg(args, "--soak-window-rows", 1_000_000, 10_000, 10_000_000),
            ReadIntArg(args, "--report-seconds", 5, 1, 3600));
        return 0;
    }
    await RunNativeTypesAndDuplicateReplayAsync(connectionString);
    await RunMillionRowsAsync(connectionString);
    Console.WriteLine("SQLSERVER_STAGE1_E2E_PASS native_types=8 duplicate_replay=idempotent million_rows=1000000");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"SQLSERVER_STAGE1_E2E_FAIL type={ex.GetType().Name} message={ex.Message}");
    Console.Error.WriteLine(ex);
    return 1;
}
void RunLocalChecks()
{
    using var services = new ServiceCollection().BuildServiceProvider();
    var scopeFactory = services.GetRequiredService<IServiceScopeFactory>();
    var monthly = CreateSettings("Server=localhost;Database=IoTSharp;User Id=test;Password=test", ShardingByDateMode.PerMonth);
    var daily = CreateSettings("Server=localhost;Database=IoTSharp;User Id=test;Password=test", ShardingByDateMode.PerDay);
    var missing = CreateSettings(string.Empty, ShardingByDateMode.PerMonth);
    Check(CreateStorage(monthly, scopeFactory).SupportsTelemetryHistoryRowReplay, "SQL Server monthly replay capability must be enabled.");
    Check(!CreateStorage(daily, scopeFactory).SupportsTelemetryHistoryRowReplay, "SQL Server daily replay capability must be disabled.");
    Check(!CreateStorage(missing, scopeFactory).SupportsTelemetryHistoryRowReplay, "SQL Server without TelemetryStorage connection must be disabled.");
    Check(monthly.TelemetryHistoryTransactionRows == 50_000, "SQL Server runner transaction rows must be 50,000.");
}
async Task RunNativeTypesAndDuplicateReplayAsync(string connectionString)
{
    await using var database = await IsolatedSqlServerDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreateSqlServerStorage(database.WriterConnectionString);
    var deviceId = Guid.NewGuid();
    var timestamp = testMonth.AddSeconds(1);
    var rows = CreateNativeRows(deviceId, timestamp);
    var first = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Check(first.Result, "SQL Server native-type write failed.");
    var second = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Check(second.Result, "SQL Server duplicate replay failed.");
    var count = await database.CountAsync();
    Check(count == 8, $"Expected 8 rows after duplicate replay, found {count}.");
    Console.WriteLine("SQLSERVER_STAGE1_TYPES_PASS rows=8 duplicate_count=8 native_types=boolean,string,long,datetime,double,json,xml,binary");
}
async Task RunMillionRowsAsync(string connectionString)
{
    await using var database = await IsolatedSqlServerDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreateSqlServerStorage(database.WriterConnectionString);
    var deviceId = Guid.NewGuid();
    var rows = new List<TelemetryData>(MillionRows);
    for (var index = 0; index < MillionRows; index++)
    {
        var ordinal = index + 1L;
        rows.Add(new TelemetryData
        {
            DeviceId = deviceId,
            KeyName = "stage1-million-double",
            DateTime = testMonth.AddTicks(ordinal),
            DataSide = DataSide.ClientSide,
            Type = DataType.Double,
            Value_Double = ordinal * 0.001d
        });
    }
    var stopwatch = Stopwatch.StartNew();
    var result = await storage.StoreTelemetryHistoryRowsAsync(rows, MillionRows);
    Check(result.Result, "SQL Server million-row write failed.");
    var stored = await database.CountAsync();
    stopwatch.Stop();
    Check(stored == MillionRows, $"SQL Server million-row count mismatch. Expected={MillionRows}, Actual={stored}.");
    Console.WriteLine(
        $"SQLSERVER_STAGE1_MILLION_PASS rows={stored} elapsed_ms={stopwatch.Elapsed.TotalMilliseconds:F0} " +
        $"rows_per_sec={MillionRows / Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d):F0} transaction_rows=50000");
}
async Task RunSoakAsync(
    string connectionString,
    TimeSpan duration,
    int batchRows,
    int windowLimitRows,
    int reportSeconds)
{
    await using var database = await IsolatedSqlServerDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreateSqlServerStorage(database.WriterConnectionString);
    var soakDeviceId = Guid.NewGuid();
    var process = Process.GetCurrentProcess();
    process.Refresh();
    var startedCpu = process.TotalProcessorTime;
    var startedGen0 = GC.CollectionCount(0);
    var startedGen1 = GC.CollectionCount(1);
    var startedGen2 = GC.CollectionCount(2);
    long peakWorkingSet = process.WorkingSet64;
    long peakManagedHeap = GC.GetGCMemoryInfo().HeapSizeBytes;
    var peakHandles = process.HandleCount;
    long totalRows = 0;
    long windowRows = 0;
    var verifiedWindows = 0;
    long batchRetries = 0;
    double maxBatchMilliseconds = 0;
    double maxCountMilliseconds = 0;
    double maxTruncateMilliseconds = 0;
    double finalVerifyMilliseconds = 0;
    var stopwatch = Stopwatch.StartNew();
    var nextReport = TimeSpan.FromSeconds(reportSeconds);
    void SampleResources()
    {
        process.Refresh();
        peakWorkingSet = Math.Max(peakWorkingSet, process.WorkingSet64);
        peakManagedHeap = Math.Max(peakManagedHeap, GC.GetGCMemoryInfo().HeapSizeBytes);
        peakHandles = Math.Max(peakHandles, process.HandleCount);
    }
    async Task VerifyAndResetWindowAsync()
    {
        var countWatch = Stopwatch.StartNew();
        var actual = await database.CountAsync();
        countWatch.Stop();
        maxCountMilliseconds = Math.Max(maxCountMilliseconds, countWatch.Elapsed.TotalMilliseconds);
        Check(actual == windowRows, $"SQL Server soak window count mismatch. Expected={windowRows}, Actual={actual}");
        var truncateWatch = Stopwatch.StartNew();
        await database.TruncateAsync();
        truncateWatch.Stop();
        maxTruncateMilliseconds = Math.Max(maxTruncateMilliseconds, truncateWatch.Elapsed.TotalMilliseconds);
        verifiedWindows++;
        windowRows = 0;
    }
    while (stopwatch.Elapsed < duration)
    {
        var remainingInWindow = windowLimitRows - windowRows;
        if (remainingInWindow <= 0)
        {
            await VerifyAndResetWindowAsync();
            continue;
        }
        var currentBatch = (int)Math.Min(batchRows, remainingInWindow);
        var rows = new List<TelemetryData>(currentBatch);
        for (var index = 0; index < currentBatch; index++)
        {
            var ordinal = totalRows + index + 1L;
            rows.Add(new TelemetryData
            {
                DeviceId = soakDeviceId,
                KeyName = "stage1-soak-double",
                DateTime = testMonth.AddTicks(ordinal),
                DataSide = DataSide.ClientSide,
                Type = DataType.Double,
                Value_Double = ordinal * 0.001d
            });
        }
        TelemetryBatchStoreResult? result = null;
        var batchWatch = Stopwatch.StartNew();
        const int maxAttempts = 4;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            result = await storage.StoreTelemetryHistoryRowsAsync(rows, currentBatch);
            if (result.Result)
                break;
            if (attempt < maxAttempts)
            {
                batchRetries++;
                var delay = TimeSpan.FromSeconds(attempt);
                Console.Error.WriteLine(
                    $"SQLSERVER_STAGE1_SOAK_RETRY total_rows={totalRows} batch_rows={currentBatch} attempt={attempt} delay_ms={delay.TotalMilliseconds:F0}");
                await Task.Delay(delay);
            }
        }
        batchWatch.Stop();
        maxBatchMilliseconds = Math.Max(maxBatchMilliseconds, batchWatch.Elapsed.TotalMilliseconds);
        Check(result?.Result == true, $"SQL Server soak batch failed after {totalRows} rows and {maxAttempts} attempts.");
        totalRows += currentBatch;
        windowRows += currentBatch;
        SampleResources();
        if (windowRows >= windowLimitRows)
            await VerifyAndResetWindowAsync();
        if (stopwatch.Elapsed >= nextReport)
        {
            var elapsedSeconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
            var cpu = (process.TotalProcessorTime - startedCpu).TotalMilliseconds
                      / Math.Max(1d, stopwatch.Elapsed.TotalMilliseconds)
                      / Math.Max(1, Environment.ProcessorCount) * 100d;
            Console.WriteLine(
                $"SQLSERVER_STAGE1_SOAK_REPORT elapsed_seconds={elapsedSeconds:F0} total_rows={totalRows} rows_per_sec={totalRows / elapsedSeconds:F0} " +
                $"window_rows={windowRows} peak_working_set_mb={peakWorkingSet / 1024d / 1024d:F1} peak_managed_heap_mb={peakManagedHeap / 1024d / 1024d:F1} " +
                $"peak_handles={peakHandles} avg_cpu_pct={cpu:F1} batch_retries={batchRetries} max_batch_ms={maxBatchMilliseconds:F0} " +
                $"max_count_ms={maxCountMilliseconds:F0} max_truncate_ms={maxTruncateMilliseconds:F0}");
            nextReport += TimeSpan.FromSeconds(reportSeconds);
        }
    }
    if (windowRows > 0)
    {
        var finalVerifyWatch = Stopwatch.StartNew();
        var actual = await database.CountAsync();
        finalVerifyWatch.Stop();
        finalVerifyMilliseconds = finalVerifyWatch.Elapsed.TotalMilliseconds;
        maxCountMilliseconds = Math.Max(maxCountMilliseconds, finalVerifyMilliseconds);
        Check(actual == windowRows, $"SQL Server final soak window count mismatch. Expected={windowRows}, Actual={actual}");
    }
    stopwatch.Stop();
    SampleResources();
    var seconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    var averageCpu = (process.TotalProcessorTime - startedCpu).TotalMilliseconds
                     / Math.Max(1d, stopwatch.Elapsed.TotalMilliseconds)
                     / Math.Max(1, Environment.ProcessorCount) * 100d;
    var overshootSeconds = Math.Max(0d, stopwatch.Elapsed.TotalSeconds - duration.TotalSeconds);
    Console.WriteLine(
        $"SQLSERVER_STAGE1_SOAK_PASS duration_seconds={stopwatch.Elapsed.TotalSeconds:F0} total_rows={totalRows} verified_windows={verifiedWindows} " +
        $"avg_rows_per_sec={totalRows / seconds:F0} peak_working_set_mb={peakWorkingSet / 1024d / 1024d:F1} " +
        $"peak_managed_heap_mb={peakManagedHeap / 1024d / 1024d:F1} peak_handles={peakHandles} avg_cpu_pct={averageCpu:F1} " +
        $"gen0={GC.CollectionCount(0) - startedGen0} gen1={GC.CollectionCount(1) - startedGen1} gen2={GC.CollectionCount(2) - startedGen2} " +
        $"batch_retries={batchRetries} max_batch_ms={maxBatchMilliseconds:F0} max_count_ms={maxCountMilliseconds:F0} " +
        $"max_truncate_ms={maxTruncateMilliseconds:F0} final_verify_ms={finalVerifyMilliseconds:F0} overshoot_seconds={overshootSeconds:F0}");
}
ShardingStorage CreateSqlServerStorage(string connectionString)
{
    var services = new ServiceCollection().BuildServiceProvider();
    return CreateStorage(
        CreateSettings(connectionString, ShardingByDateMode.PerMonth),
        services.GetRequiredService<IServiceScopeFactory>());
}
static ShardingStorage CreateStorage(AppSettings settings, IServiceScopeFactory scopeFactory)
    => new(new Stage1ConsoleLogger<ShardingStorage>(), scopeFactory, Options.Create(settings));
static AppSettings CreateSettings(string connectionString, ShardingByDateMode mode)
{
    var connections = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    if (!string.IsNullOrWhiteSpace(connectionString))
        connections["TelemetryStorage"] = connectionString;
    return new AppSettings
    {
        DataBase = DataBaseType.SqlServer,
        TelemetryStorage = TelemetryStorage.Sharding,
        TelemetryHistoryStorage = TelemetryStorage.Sharding,
        ShardingByDateMode = mode,
        TelemetryHistoryTransactionRows = 50_000,
        ConnectionStrings = connections
    };
}
static IReadOnlyList<TelemetryData> CreateNativeRows(Guid deviceId, DateTime timestamp)
    =>
    [
        Row(deviceId, "stage1-bool", timestamp, DataType.Boolean, boolean: true),
        Row(deviceId, "stage1-string", timestamp, DataType.String, text: "stage1-string-value"),
        Row(deviceId, "stage1-long", timestamp, DataType.Long, number: 9_223_372_036_854_000L),
        Row(deviceId, "stage1-datetime", timestamp, DataType.DateTime, dateTime: timestamp.AddMinutes(3)),
        Row(deviceId, "stage1-double", timestamp, DataType.Double, floating: 12345.6789d),
        Row(deviceId, "stage1-json", timestamp, DataType.Json, json: "{\"stage\":1,\"ok\":true}"),
        Row(deviceId, "stage1-xml", timestamp, DataType.XML, xml: "<stage1><ok>true</ok></stage1>"),
        Row(deviceId, "stage1-binary", timestamp, DataType.Binary, binary: [0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF])
    ];
static TelemetryData Row(
    Guid deviceId,
    string key,
    DateTime timestamp,
    DataType type,
    bool? boolean = null,
    string? text = null,
    long? number = null,
    DateTime? dateTime = null,
    double? floating = null,
    string? json = null,
    string? xml = null,
    byte[]? binary = null)
    => new()
    {
        DeviceId = deviceId,
        KeyName = key,
        DateTime = timestamp,
        DataSide = DataSide.ClientSide,
        Type = type,
        Value_Boolean = boolean,
        Value_String = text,
        Value_Long = number,
        Value_DateTime = dateTime,
        Value_Double = floating,
        Value_Json = json,
        Value_XML = xml,
        Value_Binary = binary
    };
static string? ReadConnectionString(string[] values)
{
    for (var index = 0; index < values.Length; index++)
    {
        if (!string.Equals(values[index], "--connection", StringComparison.OrdinalIgnoreCase))
            continue;
        if (index + 1 >= values.Length || string.IsNullOrWhiteSpace(values[index + 1]))
            throw new ArgumentException("--connection requires a connection string value.");
        return values[index + 1];
    }
    var environmentValue = Environment.GetEnvironmentVariable(ConnectionVariable);
    if (!string.IsNullOrWhiteSpace(environmentValue))
        return environmentValue;
    var configPath = Path.Combine(Environment.CurrentDirectory, "IoTSharp", "appsettings.SQLServer.json");
    if (!File.Exists(configPath))
        return null;
    using var document = JsonDocument.Parse(File.ReadAllText(configPath));
    if (!document.RootElement.TryGetProperty("ConnectionStrings", out var connectionStrings))
        return null;
    if (connectionStrings.TryGetProperty("TelemetryStorage", out var telemetryStorage))
    {
        var value = telemetryStorage.GetString();
        if (!string.IsNullOrWhiteSpace(value))
            return value;
    }
    if (connectionStrings.TryGetProperty("IoTSharp", out var ioTSharp))
    {
        var value = ioTSharp.GetString();
        if (!string.IsNullOrWhiteSpace(value))
            return value;
    }
    return null;
}
static int ReadIntArg(string[] values, string name, int defaultValue, int minValue, int maxValue)
{
    for (var index = 0; index < values.Length; index++)
    {
        if (!string.Equals(values[index], name, StringComparison.OrdinalIgnoreCase))
            continue;
        if (index + 1 >= values.Length || !int.TryParse(values[index + 1], out var parsed))
            throw new ArgumentException($"{name} requires an integer value.");
        return Math.Clamp(parsed, minValue, maxValue);
    }
    return defaultValue;
}
static void Check(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}
sealed class Stage1ConsoleLogger<T> : ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;
    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
            return;
        Console.Error.WriteLine(
            $"SQLSERVER_STAGE1_LOG level={logLevel} event_id={eventId.Id} message={formatter(state, exception)}");
        if (exception is not null)
            Console.Error.WriteLine(exception);
    }
}
sealed class IsolatedSqlServerDatabase : IAsyncDisposable
{
    private readonly string _masterConnectionString;
    private readonly string _databaseName;
    private readonly string _tableName;
    private IsolatedSqlServerDatabase(
        string masterConnectionString,
        string writerConnectionString,
        string databaseName,
        string tableName)
    {
        _masterConnectionString = masterConnectionString;
        WriterConnectionString = writerConnectionString;
        _databaseName = databaseName;
        _tableName = tableName;
    }
    internal string WriterConnectionString { get; }
    internal static async Task<IsolatedSqlServerDatabase> CreateAsync(string connectionString, DateTime month)
    {
        var databaseName = $"IoTSharpStage1_{Guid.NewGuid():N}";
        var tableName = $"TelemetryData_{month:yyyyMM}";
        var masterBuilder = new SqlConnectionStringBuilder(connectionString) { InitialCatalog = "master" };
        var writerBuilder = new SqlConnectionStringBuilder(connectionString) { InitialCatalog = databaseName };
        await using (var master = new SqlConnection(masterBuilder.ConnectionString))
        {
            await master.OpenAsync();
            await using var create = master.CreateCommand();
            create.CommandTimeout = 60;
            create.CommandText = $"CREATE DATABASE {Quote(databaseName)};";
            await create.ExecuteNonQueryAsync();
        }
        var database = new IsolatedSqlServerDatabase(
            masterBuilder.ConnectionString,
            writerBuilder.ConnectionString,
            databaseName,
            tableName);
        try
        {
            await database.CreateHistoryShardAsync();
            return database;
        }
        catch
        {
            await database.DisposeAsync();
            throw;
        }
    }
    internal async Task<long> CountAsync()
    {
        await using var connection = new SqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 60;
        command.CommandText = $"SELECT COUNT_BIG(*) FROM [dbo].{Quote(_tableName)};";
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }
    internal async Task TruncateAsync()
    {
        await using var connection = new SqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 60;
        command.CommandText = $"TRUNCATE TABLE [dbo].{Quote(_tableName)};";
        await command.ExecuteNonQueryAsync();
    }
    private async Task CreateHistoryShardAsync()
    {
        await using var connection = new SqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 60;
        command.CommandText = $"""
            CREATE TABLE [dbo].{Quote(_tableName)} (
                [DeviceId] uniqueidentifier NOT NULL,
                [KeyName] nvarchar(450) NOT NULL,
                [DateTime] datetime2 NOT NULL,
                [DataSide] int NOT NULL,
                [Type] int NOT NULL,
                [Value_Boolean] bit NULL,
                [Value_String] nvarchar(max) NULL,
                [Value_Long] bigint NULL,
                [Value_DateTime] datetime2 NULL,
                [Value_Double] float NULL,
                [Value_Json] nvarchar(max) NULL,
                [Value_XML] nvarchar(max) NULL,
                [Value_Binary] varbinary(max) NULL,
                CONSTRAINT {Quote($"PK_{_tableName}")} PRIMARY KEY CLUSTERED ([DeviceId], [KeyName], [DateTime])
            );
            CREATE INDEX {Quote($"IX_{_tableName}_DeviceId_DateTime")}
                ON [dbo].{Quote(_tableName)} ([DeviceId], [DateTime]);
            """;
        await command.ExecuteNonQueryAsync();
    }
    public async ValueTask DisposeAsync()
    {
        try
        {
            SqlConnection.ClearAllPools();
            await using var connection = new SqlConnection(_masterConnectionString);
            await connection.OpenAsync();
            await using var drop = connection.CreateCommand();
            drop.CommandTimeout = 60;
            drop.CommandText = $"""
                IF DB_ID(N'{EscapeLiteral(_databaseName)}') IS NOT NULL
                BEGIN
                    ALTER DATABASE {Quote(_databaseName)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                    DROP DATABASE {Quote(_databaseName)};
                END
                """;
            await drop.ExecuteNonQueryAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"SQLSERVER_STAGE1_CLEANUP_WARN database={_databaseName} message={ex.Message}");
        }
    }
    private static string Quote(string identifier)
        => $"[{identifier.Replace("]", "]]")}]";
    private static string EscapeLiteral(string value)
        => value.Replace("'", "''");
}
