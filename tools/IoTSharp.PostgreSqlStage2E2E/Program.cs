using System.Diagnostics;
using System.Text.Json;
using System.Xml;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.TimeSeries;
using IoTSharp.EventBus;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Npgsql;
using DataType = IoTSharp.Contracts.DataType;

const string ConnectionVariable = "IOTSHARP_POSTGRES_E2E_CONNECTION";
const int MillionRows = 1_000_000;
var testMonth = new DateTime(2099, 12, 1, 0, 0, 0, DateTimeKind.Utc);

try
{
    if (args.Contains("--help", StringComparer.OrdinalIgnoreCase) || args.Contains("-h", StringComparer.OrdinalIgnoreCase))
    {
        Console.WriteLine("IoTSharp PostgreSQL Stage-2 E2E runner");
        Console.WriteLine("  --local-only                         Validate capability boundaries without a database.");
        Console.WriteLine("  --connection <connection-string>    Run the real PostgreSQL E2E suite.");
        Console.WriteLine("  --outage-seconds <seconds>           Simulated provider outage before durable backlog recovery (default 2).");
        Console.WriteLine("  --soak-only --soak-seconds <n>       Run bounded storage soak only (supports 3600/14400/86400).");
        Console.WriteLine("  --soak-batch-rows <n>                Rows per soak write (default 10000).");
        Console.WriteLine("  --soak-window-rows <n>               Verify then truncate at this window size (default 1000000).");
        Console.WriteLine("  --report-seconds <n>                 Soak progress interval (default 5).");
        Console.WriteLine($"  Or set {ConnectionVariable}; otherwise the runner loads IoTSharp/appsettings.PostgreSql.json.");
        return 0;
    }

    if (args.Contains("--local-only", StringComparer.OrdinalIgnoreCase))
    {
        RunLocalChecks();
        RunConfigurationChecks();
        await RunLocalSpoolRestartAsync();
        Console.WriteLine("POSTGRES_STAGE2_LOCAL_PASS sqlserver_monthly=true postgres_monthly=true daily=false missing_connection=false copy_rows=50000 configuration_modes=pass spool_restart=pass");
        return 0;
    }

    var connectionString = ReadConnectionString(args)
        ?? throw new InvalidOperationException($"Pass --connection <value>, set {ConnectionVariable}, or configure IoTSharp/appsettings.PostgreSql.json.");

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
    await RunDurableRestartAsync(connectionString);
    await RunOutageRecoveryAsync(connectionString, TimeSpan.FromSeconds(ReadIntArg(args, "--outage-seconds", 2, 1, 3600)));
    Console.WriteLine("POSTGRES_STAGE2_E2E_PASS native_types=8 duplicate_replay=idempotent million_rows=1000000 durable_restart=pass outage_recovery=pass");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"POSTGRES_STAGE2_E2E_FAIL type={ex.GetType().Name} message={ex.Message}");
    Console.Error.WriteLine(ex);
    return 1;
}

void RunLocalChecks()
{
    using var services = new ServiceCollection().BuildServiceProvider();
    var scopeFactory = services.GetRequiredService<IServiceScopeFactory>();

    var sqlMonthly = CreateSettings("Server=localhost;Database=IoTSharp;User Id=test;Password=test", DataBaseType.SqlServer, ShardingByDateMode.PerMonth);
    var sqlDaily = CreateSettings("Server=localhost;Database=IoTSharp;User Id=test;Password=test", DataBaseType.SqlServer, ShardingByDateMode.PerDay);
    var pgMonthly = CreateSettings("Host=localhost;Database=IoTSharp;Username=test;Password=test", DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);
    var pgDaily = CreateSettings("Host=localhost;Database=IoTSharp;Username=test;Password=test", DataBaseType.PostgreSql, ShardingByDateMode.PerDay);
    var pgMissing = CreateSettings(string.Empty, DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);

    Check(CreateStorage(sqlMonthly, scopeFactory).SupportsTelemetryHistoryRowReplay, "SQL Server monthly replay capability must be enabled.");
    Check(!CreateStorage(sqlDaily, scopeFactory).SupportsTelemetryHistoryRowReplay, "SQL Server daily replay capability must be disabled.");
    Check(CreateStorage(pgMonthly, scopeFactory).SupportsTelemetryHistoryRowReplay, "PostgreSQL monthly replay capability must be enabled.");
    Check(!CreateStorage(pgDaily, scopeFactory).SupportsTelemetryHistoryRowReplay, "PostgreSQL daily replay capability must be disabled.");
    Check(!CreateStorage(pgMissing, scopeFactory).SupportsTelemetryHistoryRowReplay, "PostgreSQL without TelemetryStorage connection must be disabled.");
    Check(pgMonthly.TelemetryPostgreSqlCopyRows == 50_000, "PostgreSQL COPY default must remain 50,000 rows.");
}

void RunConfigurationChecks()
{
    var relationalOnly = CreateSettings(
        "Host=localhost;Database=IoTSharp;Username=test;Password=test",
        DataBaseType.PostgreSql,
        ShardingByDateMode.PerMonth);
    relationalOnly.TelemetryMode = TelemetryPersistenceMode.RelationalOnly;
    relationalOnly.TelemetryLatestStorage = TelemetryLatestStorageMode.SameAsHistory;
    relationalOnly.TelemetryHistorySpool = new TelemetryHistorySpoolSetting { Enabled = true };
    ValidateTelemetryConfiguration(relationalOnly);

    var splitStorage = new AppSettings
    {
        DataBase = DataBaseType.PostgreSql,
        TelemetryStorage = TelemetryStorage.InfluxDB,
        TelemetryHistoryStorage = TelemetryStorage.InfluxDB,
        TelemetryMode = TelemetryPersistenceMode.RelationalWithTimeSeries,
        TelemetryLatestStorage = TelemetryLatestStorageMode.Relational,
        TelemetryHistorySpool = new TelemetryHistorySpoolSetting { Enabled = true },
        ConnectionStrings = new Dictionary<string, string>
        {
            ["IoTSharp"] = "Host=localhost;Database=IoTSharp;Username=test;Password=test",
            ["TelemetryStorage"] = "http://127.0.0.1:8086/?org=iotsharp&bucket=iotsharp&token=dummy"
        }
    };
    ValidateTelemetryConfiguration(splitStorage);

    var invalidSpool = CreateSettings(
        "Host=localhost;Database=IoTSharp;Username=test;Password=test",
        DataBaseType.PostgreSql,
        ShardingByDateMode.PerDay);
    invalidSpool.TelemetryMode = TelemetryPersistenceMode.RelationalOnly;
    invalidSpool.TelemetryHistorySpool = new TelemetryHistorySpoolSetting { Enabled = true };

    var rejected = false;
    try
    {
        ValidateTelemetryConfiguration(invalidSpool);
    }
    catch (InvalidOperationException ex) when (ex.Message.Contains("cannot safely replay materialized rows", StringComparison.Ordinal))
    {
        rejected = true;
    }

    Check(rejected, "Startup configuration validation must reject durable spool on PostgreSQL daily sharding.");
}

void ValidateTelemetryConfiguration(AppSettings settings)
{
    var services = new ServiceCollection();
    var healthChecks = services.AddHealthChecks();
    services.AddTelemetryStorage(settings, healthChecks);
}

async Task RunLocalSpoolRestartAsync()
{
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage2-pg-local-spool", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(spoolDirectory);
    try
    {
        var settings = CreateSettings("Host=localhost;Database=IoTSharp;Username=test;Password=test", DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);
        settings.TelemetryHistorySpool = new TelemetryHistorySpoolSetting
        {
            Enabled = true,
            Directory = spoolDirectory,
            RetryDelayMilliseconds = 50,
            IdleDelayMilliseconds = 25
        };

        var message = CreateNativeMessage(Guid.NewGuid(), testMonth.AddSeconds(3));
        var first = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        var enqueue = await first.EnqueueAsync([message]);
        Check(enqueue.RowCount == 8 && !enqueue.Deduplicated, "Local spool enqueue did not materialize exactly 8 rows.");
        Check(first.GetBacklogSnapshot().PendingBatches == 1, "Local spool backlog must be 1 before restart.");

        var restarted = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        await restarted.RecoverAsync();
        var recovered = await restarted.PeekOldestAsync();
        Check(recovered is not null && recovered.Rows.Count == 8, "Local spool restart did not recover exactly 8 rows.");
        Check(restarted.GetBacklogSnapshot().PendingBatches == 1, "Local spool backlog must remain 1 before ACK.");
        await restarted.AckAsync(recovered!);
        Check(restarted.GetBacklogSnapshot().PendingBatches == 0, "Local spool ACK did not clear backlog.");
        Check(await restarted.PeekOldestAsync() is null, "Local spool queue is not empty after ACK.");
    }
    finally
    {
        try { Directory.Delete(spoolDirectory, recursive: true); } catch { }
    }
}

async Task RunSoakAsync(
    string connectionString,
    TimeSpan duration,
    int batchRows,
    int windowLimitRows,
    int reportSeconds)
{
    await using var database = await IsolatedDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreatePostgreSqlStorage(database.WriterConnectionString);
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
        Check(actual == windowRows, $"PostgreSQL soak window count mismatch. Expected={windowRows}, Actual={actual}");

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
                KeyName = "stage2-soak-double",
                DateTime = testMonth.AddTicks(ordinal * 10L),
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
                    $"POSTGRES_STAGE2_SOAK_RETRY total_rows={totalRows} batch_rows={currentBatch} attempt={attempt} delay_ms={delay.TotalMilliseconds:F0}");
                await Task.Delay(delay);
            }
        }
        batchWatch.Stop();
        maxBatchMilliseconds = Math.Max(maxBatchMilliseconds, batchWatch.Elapsed.TotalMilliseconds);
        Check(result?.Result == true, $"PostgreSQL soak batch failed after {totalRows} rows and {maxAttempts} attempts.");
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
                $"POSTGRES_STAGE2_SOAK_REPORT elapsed_seconds={elapsedSeconds:F0} total_rows={totalRows} rows_per_sec={totalRows / elapsedSeconds:F0} " +
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
        Check(actual == windowRows, $"PostgreSQL final soak window count mismatch. Expected={windowRows}, Actual={actual}");
    }

    stopwatch.Stop();
    SampleResources();
    var seconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    var averageCpu = (process.TotalProcessorTime - startedCpu).TotalMilliseconds
                     / Math.Max(1d, stopwatch.Elapsed.TotalMilliseconds)
                     / Math.Max(1, Environment.ProcessorCount) * 100d;
    var overshootSeconds = Math.Max(0d, stopwatch.Elapsed.TotalSeconds - duration.TotalSeconds);
    Console.WriteLine(
        $"POSTGRES_STAGE2_SOAK_PASS duration_seconds={stopwatch.Elapsed.TotalSeconds:F0} total_rows={totalRows} verified_windows={verifiedWindows} " +
        $"avg_rows_per_sec={totalRows / seconds:F0} peak_working_set_mb={peakWorkingSet / 1024d / 1024d:F1} " +
        $"peak_managed_heap_mb={peakManagedHeap / 1024d / 1024d:F1} peak_handles={peakHandles} avg_cpu_pct={averageCpu:F1} " +
        $"gen0={GC.CollectionCount(0) - startedGen0} gen1={GC.CollectionCount(1) - startedGen1} gen2={GC.CollectionCount(2) - startedGen2} " +
        $"batch_retries={batchRetries} max_batch_ms={maxBatchMilliseconds:F0} max_count_ms={maxCountMilliseconds:F0} " +
        $"max_truncate_ms={maxTruncateMilliseconds:F0} final_verify_ms={finalVerifyMilliseconds:F0} overshoot_seconds={overshootSeconds:F0}");
}

async Task RunNativeTypesAndDuplicateReplayAsync(string connectionString)
{
    await using var database = await IsolatedDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreatePostgreSqlStorage(database.WriterConnectionString);
    var deviceId = Guid.NewGuid();
    var timestamp = testMonth.AddSeconds(1);
    var rows = CreateNativeRows(deviceId, timestamp);

    var first = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Check(first.Result, "First native-type materialized-row write failed.");
    Check(await database.CountAsync() == 8, "Native-type write did not store exactly 8 rows.");

    var second = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Check(second.Result, "Duplicate materialized-row replay failed.");
    Check(await database.CountAsync() == 8, "Duplicate replay was not idempotent.");
    await database.AssertNativeValuesAsync(deviceId, timestamp);
    Console.WriteLine("POSTGRES_STAGE2_TYPES_PASS rows=8 duplicate_count=8 json=jsonb xml=xml binary=bytea");
}

async Task RunMillionRowsAsync(string connectionString)
{
    await using var database = await IsolatedDatabase.CreateAsync(connectionString, testMonth);
    var storage = CreatePostgreSqlStorage(database.WriterConnectionString);
    var deviceId = Guid.NewGuid();
    const string key = "stage2-million-double";
    var rows = new List<TelemetryData>(MillionRows);

    for (var index = 0; index < MillionRows; index++)
    {
        rows.Add(new TelemetryData
        {
            DeviceId = deviceId,
            KeyName = key,
            // PostgreSQL timestamps have microsecond precision, so keep each
            // generated primary-key timestamp at least one microsecond apart.
            DateTime = testMonth.AddTicks((index + 1L) * 10L),
            DataSide = DataSide.ClientSide,
            Type = DataType.Double,
            Value_Double = index * 0.001d
        });
    }

    var stopwatch = Stopwatch.StartNew();
    var result = await storage.StoreTelemetryHistoryRowsAsync(rows, MillionRows);
    stopwatch.Stop();
    Check(result.Result, "One-million-row materialized write failed.");
    var stored = await database.CountAsync();
    Check(stored == MillionRows, $"One-million-row count mismatch. Expected={MillionRows}, Actual={stored}");

    var rowsPerSecond = MillionRows / Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    Console.WriteLine($"POSTGRES_STAGE2_MILLION_PASS rows={stored} elapsed_ms={stopwatch.Elapsed.TotalMilliseconds:F0} rows_per_sec={rowsPerSecond:F0} copy_rows=50000");
}

async Task RunDurableRestartAsync(string connectionString)
{
    await using var database = await IsolatedDatabase.CreateAsync(connectionString, testMonth);
    var settings = CreateSettings(database.WriterConnectionString, DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage2-pg-spool", Guid.NewGuid().ToString("N"));
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

        var timestamp = testMonth.AddSeconds(2);
        var message = CreateNativeMessage(Guid.NewGuid(), timestamp);
        var process1Options = new EventBusOption { AppSettings = settings };
        var process1Spool = new TelemetryHistorySpool(process1Options, NullLogger<TelemetryHistorySpool>.Instance);
        var enqueue = await process1Spool.EnqueueAsync([message]);
        Check(!enqueue.Deduplicated, "First spool enqueue was unexpectedly deduplicated.");
        Check(enqueue.RowCount == 8, $"Expected 8 spooled rows, got {enqueue.RowCount}.");
        Check(process1Spool.GetBacklogSnapshot().PendingBatches == 1, "Process-1 spool backlog must be 1.");

        var process2Options = new EventBusOption { AppSettings = settings };
        var process2Spool = new TelemetryHistorySpool(process2Options, NullLogger<TelemetryHistorySpool>.Instance);
        await process2Spool.RecoverAsync();
        var recovered = await process2Spool.PeekOldestAsync();
        Check(recovered is not null, "Restarted spool did not recover the pending batch.");
        Check(recovered!.Rows.Count == 8, $"Recovered row count mismatch: {recovered.Rows.Count}.");
        Check(process2Spool.GetBacklogSnapshot().PendingBatches == 1, "Recovered backlog must remain 1 before ACK.");

        var storage = CreatePostgreSqlStorage(database.WriterConnectionString);
        Check(storage.SupportsTelemetryHistoryRowReplay, "PostgreSQL monthly storage did not advertise row replay capability.");
        var replay = await storage.StoreTelemetryHistoryRowsAsync(recovered.Rows, recovered.MessageCount);
        Check(replay.Result, "Recovered materialized-row replay failed.");
        Check(await database.CountAsync() == 8, "Recovered materialized rows did not persist exactly once.");

        await process2Spool.AckAsync(recovered);
        Check(process2Spool.GetBacklogSnapshot().PendingBatches == 0, "ACK did not clear durable backlog.");
        Check(await process2Spool.PeekOldestAsync() is null, "Queue was not empty after ACK.");
        Console.WriteLine("POSTGRES_STAGE2_RESTART_PASS spooled_rows=8 recovered_rows=8 persisted_rows=8 backlog_after_ack=0");
    }
    finally
    {
        try { Directory.Delete(spoolDirectory, recursive: true); } catch { }
    }
}

async Task RunOutageRecoveryAsync(string connectionString, TimeSpan outageDuration)
{
    const int batchCount = 20;
    const int rowsPerBatch = 8;
    await using var database = await IsolatedDatabase.CreateAsync(connectionString, testMonth);
    var settings = CreateSettings(database.WriterConnectionString, DataBaseType.PostgreSql, ShardingByDateMode.PerMonth);
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage2-pg-outage", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(spoolDirectory);
    settings.TelemetryHistorySpool = new TelemetryHistorySpoolSetting
    {
        Enabled = true,
        Directory = spoolDirectory,
        RetryDelayMilliseconds = 50,
        IdleDelayMilliseconds = 25
    };

    try
    {
        var options = new EventBusOption { AppSettings = settings };
        var spool = new TelemetryHistorySpool(options, NullLogger<TelemetryHistorySpool>.Instance);
        var deviceId = Guid.NewGuid();
        for (var index = 0; index < batchCount; index++)
        {
            var enqueue = await spool.EnqueueAsync([CreateNativeMessage(deviceId, testMonth.AddSeconds(10).AddMilliseconds(index))]);
            Check(enqueue.RowCount == rowsPerBatch, $"Outage spool row mismatch at batch {index}.");
        }

        var before = spool.GetBacklogSnapshot();
        Check(before.PendingBatches == batchCount, $"Expected {batchCount} pending batches before recovery, got {before.PendingBatches}.");
        Check(before.PendingRows == batchCount * rowsPerBatch, $"Expected {batchCount * rowsPerBatch} pending rows before recovery, got {before.PendingRows}.");

        var realStorage = CreatePostgreSqlStorage(database.WriterConnectionString);
        var recoveringStorage = new TimedOutageStorage(realStorage, outageDuration);
        var dispatcher = new TelemetryHistoryPersistenceDispatcher(
            recoveringStorage,
            spool,
            options,
            NullLogger<TelemetryHistoryPersistenceDispatcher>.Instance);
        await dispatcher.StartAsync(CancellationToken.None);
        try
        {
            var deadline = DateTime.UtcNow + outageDuration + TimeSpan.FromSeconds(30);
            while (DateTime.UtcNow < deadline && spool.GetBacklogSnapshot().PendingBatches > 0)
                await Task.Delay(50);
        }
        finally
        {
            await dispatcher.StopAsync(CancellationToken.None);
        }

        var after = spool.GetBacklogSnapshot();
        var metrics = options.TelemetryPersistence.GetSnapshot();
        Check(after.PendingBatches == 0 && after.PendingRows == 0, "PostgreSQL outage backlog did not fully drain.");
        Check(await database.CountAsync() == batchCount * rowsPerBatch, "PostgreSQL outage recovery persisted an unexpected row count.");
        Check(metrics.RetriedBatches > 0, "PostgreSQL outage recovery did not record any retry.");
        Check(metrics.DrainedRows == batchCount * rowsPerBatch, $"PostgreSQL drained-row metric mismatch: {metrics.DrainedRows}.");
        Console.WriteLine($"POSTGRES_STAGE2_OUTAGE_RECOVERY_PASS outage_seconds={outageDuration.TotalSeconds:F0} pending_before={before.PendingBatches} pending_rows_before={before.PendingRows} retries={metrics.RetriedBatches} drained_rows={metrics.DrainedRows} pending_after=0");
    }
    finally
    {
        try { Directory.Delete(spoolDirectory, recursive: true); } catch { }
    }
}

ShardingStorage CreatePostgreSqlStorage(string connectionString)
{
    var services = new ServiceCollection().BuildServiceProvider();
    return CreateStorage(CreateSettings(connectionString, DataBaseType.PostgreSql, ShardingByDateMode.PerMonth), services.GetRequiredService<IServiceScopeFactory>());
}

static ShardingStorage CreateStorage(AppSettings settings, IServiceScopeFactory scopeFactory)
    => new(new Stage2ConsoleLogger<ShardingStorage>(), scopeFactory, Options.Create(settings));

static AppSettings CreateSettings(string connectionString, DataBaseType database, ShardingByDateMode mode)
{
    var connections = new Dictionary<string, string>();
    if (!string.IsNullOrWhiteSpace(connectionString))
        connections["TelemetryStorage"] = connectionString;

    return new AppSettings
    {
        DataBase = database,
        TelemetryStorage = TelemetryStorage.Sharding,
        TelemetryHistoryStorage = TelemetryStorage.Sharding,
        ShardingByDateMode = mode,
        TelemetryPostgreSqlCopyRows = 50_000,
        ConnectionStrings = connections
    };
}

static IReadOnlyList<TelemetryData> CreateNativeRows(Guid deviceId, DateTime timestamp)
    =>
    [
        Row(deviceId, "stage2-bool", timestamp, DataType.Boolean, boolean: true),
        Row(deviceId, "stage2-string", timestamp, DataType.String, text: "stage2-string-value"),
        Row(deviceId, "stage2-long", timestamp, DataType.Long, number: 9_223_372_036_854_000L),
        Row(deviceId, "stage2-datetime", timestamp, DataType.DateTime, dateTime: timestamp.AddMinutes(3)),
        Row(deviceId, "stage2-double", timestamp, DataType.Double, floating: 12345.6789d),
        Row(deviceId, "stage2-json", timestamp, DataType.Json, json: "{\"stage\":2,\"ok\":true}"),
        Row(deviceId, "stage2-xml", timestamp, DataType.XML, xml: "<stage2><ok>true</ok></stage2>"),
        Row(deviceId, "stage2-binary", timestamp, DataType.Binary, binary: [0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF])
    ];

static TelemetryData Row(Guid deviceId, string key, DateTime timestamp, DataType type, bool? boolean = null,
    string? text = null, long? number = null, DateTime? dateTime = null, double? floating = null,
    string? json = null, string? xml = null, byte[]? binary = null)
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

static PlayloadData CreateNativeMessage(Guid deviceId, DateTime timestamp)
{
    using var json = JsonDocument.Parse("{\"stage\":2,\"restart\":true}");
    var xml = new XmlDocument();
    xml.LoadXml("<stage2><restart>true</restart></stage2>");
    return new PlayloadData
    {
        DeviceId = deviceId,
        ts = timestamp,
        ServerIngestedAtUtc = timestamp,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object>
        {
            ["spool-bool"] = true,
            ["spool-string"] = "restart-value",
            ["spool-long"] = 1234567890123L,
            ["spool-datetime"] = timestamp.AddMinutes(5),
            ["spool-double"] = 9876.54321d,
            ["spool-json"] = json.RootElement.Clone(),
            ["spool-xml"] = xml,
            ["spool-binary"] = new byte[] { 0x10, 0x20, 0x30, 0xFF }
        }
    };
}

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

    var configPath = Path.Combine(Environment.CurrentDirectory, "IoTSharp", "appsettings.PostgreSql.json");
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

sealed class Stage2ConsoleLogger<T> : ILogger<T>
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
            $"POSTGRES_STAGE2_LOG level={logLevel} event_id={eventId.Id} message={formatter(state, exception)}");
        if (exception is not null)
            Console.Error.WriteLine(exception);
    }
}

sealed class TimedOutageStorage : IStorage, ITelemetryHistoryRowStorage
{
    private readonly IStorage _innerStorage;
    private readonly ITelemetryHistoryRowStorage _innerHistory;
    private readonly DateTime _availableAtUtc;

    internal TimedOutageStorage(IStorage inner, TimeSpan outageDuration)
    {
        _innerStorage = inner;
        _innerHistory = inner as ITelemetryHistoryRowStorage
            ?? throw new ArgumentException("Inner storage must support materialized History replay.", nameof(inner));
        _availableAtUtc = DateTime.UtcNow + outageDuration;
    }

    public bool SupportsTelemetryHistoryRowReplay => true;

    public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(IReadOnlyCollection<TelemetryData> rows, int messageCount)
        => DateTime.UtcNow < _availableAtUtc
            ? Task.FromResult(new TelemetryBatchStoreResult(false, rows.ToList(), messageCount))
            : _innerHistory.StoreTelemetryHistoryRowsAsync(rows, messageCount);

    public Task<bool> CheckTelemetryStorage() => _innerStorage.CheckTelemetryStorage();
    public Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg) => _innerStorage.StoreTelemetryAsync(msg);
    public Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages) => _innerStorage.StoreTelemetryBatchAsync(messages);
    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId) => _innerStorage.GetTelemetryLatest(deviceId);
    public Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys) => _innerStorage.GetTelemetryLatest(deviceId, keys);
    public Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate)
        => _innerStorage.LoadTelemetryAsync(deviceId, keys, begin, end, every, aggregate);
}

sealed class IsolatedDatabase : IAsyncDisposable
{
    private readonly string _adminConnectionString;
    private readonly string _schema;
    private readonly string _table;

    private IsolatedDatabase(string adminConnectionString, string writerConnectionString, string schema, string table)
    {
        _adminConnectionString = adminConnectionString;
        WriterConnectionString = writerConnectionString;
        _schema = schema;
        _table = table;
    }

    internal string WriterConnectionString { get; }

    internal static async Task<IsolatedDatabase> CreateAsync(string connectionString, DateTime month)
    {
        var schema = $"iotsharp_stage2_{Guid.NewGuid():N}";
        var table = $"TelemetryData_{month:yyyyMM}";
        var adminBuilder = new NpgsqlConnectionStringBuilder(connectionString);
        var writerBuilder = new NpgsqlConnectionStringBuilder(connectionString) { SearchPath = schema };
        await using (var admin = new NpgsqlConnection(adminBuilder.ConnectionString))
        {
            await admin.OpenAsync();
            await using var createSchema = new NpgsqlCommand($"CREATE SCHEMA {Quote(schema)};", admin);
            await createSchema.ExecuteNonQueryAsync();
        }

        var database = new IsolatedDatabase(adminBuilder.ConnectionString, writerBuilder.ConnectionString, schema, table);
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
        await using var connection = new NpgsqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"SELECT COUNT(*) FROM {Quote(_table)};", connection);
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }

    internal async Task TruncateAsync()
    {
        await using var connection = new NpgsqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"TRUNCATE TABLE {Quote(_table)};", connection);
        await command.ExecuteNonQueryAsync();
    }

    internal async Task AssertNativeValuesAsync(Guid deviceId, DateTime timestamp)
    {
        await using var connection = new NpgsqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(
            $"SELECT {Quote(nameof(TelemetryData.KeyName))}, {Quote(nameof(TelemetryData.Value_Boolean))}, " +
            $"{Quote(nameof(TelemetryData.Value_String))}, {Quote(nameof(TelemetryData.Value_Long))}, " +
            $"{Quote(nameof(TelemetryData.Value_DateTime))}, {Quote(nameof(TelemetryData.Value_Double))}, " +
            $"{Quote(nameof(TelemetryData.Value_Json))}::text, {Quote(nameof(TelemetryData.Value_XML))}::text, " +
            $"{Quote(nameof(TelemetryData.Value_Binary))} FROM {Quote(_table)} " +
            $"WHERE {Quote(nameof(TelemetryData.DeviceId))} = @device ORDER BY {Quote(nameof(TelemetryData.KeyName))};", connection);
        command.Parameters.AddWithValue("device", deviceId);

        var seen = new Dictionary<string, object?[]>(StringComparer.Ordinal);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var values = new object?[8];
            for (var index = 0; index < values.Length; index++)
                values[index] = reader.IsDBNull(index + 1) ? null : reader.GetValue(index + 1);
            seen[reader.GetString(0)] = values;
        }

        Ensure(seen.Count == 8, $"Expected 8 native values, found {seen.Count}.");
        Ensure((bool)seen["stage2-bool"][0]!, "Boolean value mismatch.");
        Ensure((string)seen["stage2-string"][1]! == "stage2-string-value", "String value mismatch.");
        Ensure(Convert.ToInt64(seen["stage2-long"][2]) == 9_223_372_036_854_000L, "Long value mismatch.");
        Ensure(((DateTime)seen["stage2-datetime"][3]!).ToUniversalTime() == timestamp.AddMinutes(3), "DateTime value mismatch.");
        Ensure(Math.Abs(Convert.ToDouble(seen["stage2-double"][4]) - 12345.6789d) < 0.000001d, "Double value mismatch.");
        using var json = JsonDocument.Parse((string)seen["stage2-json"][5]!);
        Ensure(json.RootElement.GetProperty("stage").GetInt32() == 2 && json.RootElement.GetProperty("ok").GetBoolean(), "JSON value mismatch.");
        Ensure(((string)seen["stage2-xml"][6]!).Contains("<stage2>", StringComparison.Ordinal), "XML value mismatch.");
        Ensure(((byte[])seen["stage2-binary"][7]!).SequenceEqual(new byte[] { 0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF }), "Binary value mismatch.");
    }

    private async Task CreateHistoryShardAsync()
    {
        await using var connection = new NpgsqlConnection(WriterConnectionString);
        await connection.OpenAsync();
        var sql = $"""
            CREATE TABLE {Quote(_table)} (
                {Quote(nameof(TelemetryData.DeviceId))} uuid NOT NULL,
                {Quote(nameof(TelemetryData.KeyName))} text NOT NULL,
                {Quote(nameof(TelemetryData.DateTime))} timestamp with time zone NOT NULL,
                {Quote(nameof(TelemetryData.DataSide))} integer NOT NULL,
                {Quote(nameof(TelemetryData.Type))} integer NOT NULL,
                {Quote(nameof(TelemetryData.Value_Boolean))} boolean NULL,
                {Quote(nameof(TelemetryData.Value_String))} text NULL,
                {Quote(nameof(TelemetryData.Value_Long))} bigint NULL,
                {Quote(nameof(TelemetryData.Value_DateTime))} timestamp with time zone NULL,
                {Quote(nameof(TelemetryData.Value_Double))} double precision NULL,
                {Quote(nameof(TelemetryData.Value_Json))} jsonb NULL,
                {Quote(nameof(TelemetryData.Value_XML))} xml NULL,
                {Quote(nameof(TelemetryData.Value_Binary))} bytea NULL,
                PRIMARY KEY ({Quote(nameof(TelemetryData.DeviceId))}, {Quote(nameof(TelemetryData.KeyName))}, {Quote(nameof(TelemetryData.DateTime))})
            );
            """;
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await using var connection = new NpgsqlConnection(_adminConnectionString);
            await connection.OpenAsync();
            await using var drop = new NpgsqlCommand($"DROP SCHEMA IF EXISTS {Quote(_schema)} CASCADE;", connection);
            await drop.ExecuteNonQueryAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"POSTGRES_STAGE2_CLEANUP_WARN schema={_schema} message={ex.Message}");
        }
    }

    private static string Quote(string identifier)
        => $"\"{identifier.Replace("\"", "\"\"")}\"";

    private static void Ensure(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
