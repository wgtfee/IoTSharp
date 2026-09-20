using System.Diagnostics;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Web;
using System.Xml;
using InfluxDB.Client;
using InfluxDB.Client.Core.Flux.Domain;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.ObjectPool;
using Microsoft.Extensions.Options;
using DataType = IoTSharp.Contracts.DataType;

const string ConnectionVariable = "IOTSHARP_INFLUX_E2E_CONNECTION";
const int MillionValues = 1_000_000;
const int BenchmarkValues = 100_000;
int[] BenchmarkBatchSizes = [10_000, 25_000, 50_000, 100_000];

try
{
    if (args.Contains("--help", StringComparer.OrdinalIgnoreCase) || args.Contains("-h", StringComparer.OrdinalIgnoreCase))
    {
        Console.WriteLine("IoTSharp InfluxDB Stage-3 E2E runner");
        Console.WriteLine("  --local-only                         Run capability/Line Protocol/spool checks without a database.");
        Console.WriteLine("  --connection <connection-string>    Run the real InfluxDB E2E suite.");
        Console.WriteLine("  --cli-config <name> --bucket <name> Read url/org/token from ~/.influxdbv2/configs without exposing the token.");
        Console.WriteLine("  --outage-seconds <seconds>           Simulated provider outage before durable backlog recovery (default 2).");
        Console.WriteLine("  --soak-only --soak-seconds <n>       Run bounded storage soak only (supports 3600/14400/86400).");
        Console.WriteLine("  --soak-batch-values <n>              Values per soak write (default 10000).");
        Console.WriteLine("  --soak-window-values <n>             Verify then delete at this window size (default 1000000).");
        Console.WriteLine("  --report-seconds <n>                 Soak progress interval (default 5).");
        Console.WriteLine($"  Or set {ConnectionVariable} and run without --connection.");
        return 0;
    }

    if (args.Contains("--local-only", StringComparer.OrdinalIgnoreCase))
    {
        await RunLocalChecksAsync();
        return 0;
    }

    var cliConfigName = ReadArg(args, "--cli-config");
    var connectionString = ReadArg(args, "--connection") ?? Environment.GetEnvironmentVariable(ConnectionVariable);
    InfluxConnection connection;
    if (!string.IsNullOrWhiteSpace(cliConfigName))
    {
        var bucket = ReadArg(args, "--bucket");
        Ensure(!string.IsNullOrWhiteSpace(bucket), "--bucket is required with --cli-config.");
        connection = ReadCliConfig(cliConfigName!, bucket!);
        connectionString = connection.ToConnectionString();
    }
    else
    {
        Ensure(!string.IsNullOrWhiteSpace(connectionString), $"Pass --connection <value>, --cli-config <name> --bucket <name>, or set {ConnectionVariable}.");
        connection = ParseConnection(connectionString!);
    }

    using var pool = CreatePool(connection);
    if (args.Contains("--soak-only", StringComparer.OrdinalIgnoreCase))
    {
        await RunSoakAsync(
            connectionString!,
            connection,
            pool,
            TimeSpan.FromSeconds(ReadIntArg(args, "--soak-seconds", 10, 1, 604800)),
            ReadIntArg(args, "--soak-batch-values", 10_000, 100, 100_000),
            ReadIntArg(args, "--soak-window-values", 1_000_000, 10_000, 10_000_000),
            ReadIntArg(args, "--report-seconds", 5, 1, 3600));
        return 0;
    }
    await RunNativeTypesAndDuplicateReplayAsync(connectionString!, connection, pool);
    var fastestBatch = await RunBatchBenchmarksAsync(connectionString!, connection, pool);
    await RunMillionValuesAsync(connectionString!, connection, pool, fastestBatch);
    await RunDurableRestartAsync(connectionString!, connection, pool, fastestBatch);
    await RunOutageRecoveryAsync(
        connectionString!,
        connection,
        pool,
        fastestBatch,
        TimeSpan.FromSeconds(ReadIntArg(args, "--outage-seconds", 2, 1, 3600)));
    await ReportCardinalityAsync(connection, pool.Client);

    Console.WriteLine($"INFLUX_STAGE3_E2E_PASS native_types=8 duplicate_replay=idempotent million_values={MillionValues} durable_restart=pass outage_recovery=pass fastest_batch={fastestBatch} gzip={pool.Client.IsGzipEnabled().ToString().ToLowerInvariant()}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"INFLUX_STAGE3_E2E_FAIL type={ex.GetType().Name} message={ex.Message}");
    Console.Error.WriteLine(ex);
    return 1;
}

async Task RunLocalChecksAsync()
{
    const string dummy = "http://127.0.0.1:8086/?org=iotsharp-stage3&bucket=iotsharp-stage3&token=dummy";
    var connection = ParseConnection(dummy);
    using var pool = CreatePool(connection);
    var settings = CreateSettings(dummy, 5_000);
    var options = Options.Create(settings);
    var writer = new InfluxTelemetryHistoryWriter(pool, options, NullLogger<InfluxTelemetryHistoryWriter>.Instance);
    var storage = new InfluxDBStorage(NullLogger<InfluxDBStorage>.Instance, options, pool, writer);

    Ensure(new AppSettings().TelemetryInfluxBatchValues == 25_000, "Influx production default batch value count must be 25,000 after Stage-3 A/B verification.");
    Ensure(writer.IsConfigured, "Configured Influx writer must advertise valid configuration.");
    Ensure(writer.BatchValues == 5_000, "Explicit Influx batch override must be honored.");
    Ensure(storage.SupportsTelemetryHistoryRowReplay, "Influx storage must advertise materialized row replay.");

    var missingOrgSettings = CreateSettings("http://127.0.0.1:8086/?bucket=iotsharp-stage3&token=dummy", 5_000);
    var missingOrgWriter = new InfluxTelemetryHistoryWriter(pool, Options.Create(missingOrgSettings), NullLogger<InfluxTelemetryHistoryWriter>.Instance);
    Ensure(!missingOrgWriter.IsConfigured, "Influx replay capability must be disabled without org.");

    var timestamp = DateTime.UtcNow.AddMinutes(-1);
    var deviceId = Guid.NewGuid();
    var rows = CreateNativeRows(deviceId, timestamp);
    var records = rows.Select(InfluxTelemetryHistoryWriter.BuildRowRecord).ToArray();
    Ensure(records.All(record => record is not null), "All 8 native rows must produce Line Protocol.");
    Ensure(records.All(record => record!.StartsWith($"TelemetryData,DeviceId={deviceId:D} ", StringComparison.Ordinal)), "DeviceId must remain the only telemetry tag prefix.");
    Ensure(records.All(record => !record!.Contains(",KeyName=", StringComparison.Ordinal)), "KeyName must not become a tag.");

    var escaped = new TelemetryData
    {
        DeviceId = deviceId,
        KeyName = "escape key,=\\",
        DateTime = timestamp,
        Type = DataType.String,
        Value_String = "quote\" slash\\ value"
    };
    var escapedRecord = InfluxTelemetryHistoryWriter.BuildRowRecord(escaped)!;
    Ensure(escapedRecord.Contains("escape\\ key\\,\\=\\\\=\"quote\\\" slash\\\\ value\"", StringComparison.Ordinal), "Influx field-key/string escaping regression.");

    var payload = string.Join('\n', records!);
    var ratio = GzipRatio(payload);
    Ensure(ratio > 0 && ratio < 1, "Expected representative Line Protocol payload to compress with gzip.");

    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage3-influx-local", Guid.NewGuid().ToString("N"));
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
        var process1 = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        var first = await process1.EnqueueAsync([message]);
        Ensure(first.RowCount == 8 && !first.Deduplicated, "Initial Influx durable spool enqueue must contain 8 rows.");
        var duplicate = await process1.EnqueueAsync([message]);
        Ensure(duplicate.Deduplicated, "Identical durable spool enqueue must deduplicate by content hash.");

        var process2 = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        await process2.RecoverAsync();
        var recovered = await process2.PeekOldestAsync();
        Ensure(recovered is not null && recovered.Rows.Count == 8, "Restarted spool must recover exactly 8 materialized rows.");
        await process2.AckAsync(recovered!);
        Ensure(process2.GetBacklogSnapshot().PendingBatches == 0, "ACK must clear recovered spool backlog.");
    }
    finally
    {
        TryDeleteDirectory(spoolDirectory);
    }

    Console.WriteLine($"INFLUX_STAGE3_LOCAL_PASS replay=true default_batch_values=25000 override_batch_values=5000 native_types=8 deviceid_tag_only=true spool_restart=pass gzip_sample_ratio={ratio:F3}");
}

async Task RunSoakAsync(
    string connectionString,
    InfluxConnection connection,
    SingleClientPool pool,
    TimeSpan duration,
    int batchValues,
    int windowLimitValues,
    int reportSeconds)
{
    var storage = CreateStorage(connectionString, pool, batchValues);
    var process = Process.GetCurrentProcess();
    process.Refresh();
    var startedCpu = process.TotalProcessorTime;
    var startedGen0 = GC.CollectionCount(0);
    var startedGen1 = GC.CollectionCount(1);
    var startedGen2 = GC.CollectionCount(2);
    long peakWorkingSet = process.WorkingSet64;
    long peakManagedHeap = GC.GetGCMemoryInfo().HeapSizeBytes;
    var peakHandles = process.HandleCount;
    long totalValues = 0;
    long windowValues = 0;
    var verifiedWindows = 0;
    long batchRetries = 0;
    double maxBatchMilliseconds = 0;
    double maxCountMilliseconds = 0;
    double maxDeleteMilliseconds = 0;
    double finalVerifyMilliseconds = 0;
    var deviceId = Guid.NewGuid();
    var windowStart = DateTime.UtcNow.AddHours(-6);
    var lastTimestamp = windowStart;
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
        var actual = await CountValuesAsync(
            connection,
            pool.Client,
            deviceId,
            windowStart.AddSeconds(-1),
            lastTimestamp.AddSeconds(1));
        countWatch.Stop();
        maxCountMilliseconds = Math.Max(maxCountMilliseconds, countWatch.Elapsed.TotalMilliseconds);
        Ensure(actual == windowValues, $"Influx soak window count mismatch. Expected={windowValues} Actual={actual}");

        var predicate = $"_measurement=\"TelemetryData\" AND DeviceId=\"{deviceId:D}\"";
        var deleteWatch = Stopwatch.StartNew();
        await pool.Client.GetDeleteApi().Delete(
            windowStart.AddSeconds(-1),
            lastTimestamp.AddSeconds(1),
            predicate,
            connection.Bucket,
            connection.Org);
        deleteWatch.Stop();
        maxDeleteMilliseconds = Math.Max(maxDeleteMilliseconds, deleteWatch.Elapsed.TotalMilliseconds);

        verifiedWindows++;
        windowValues = 0;
        deviceId = Guid.NewGuid();
        windowStart = DateTime.UtcNow.AddHours(-6);
        lastTimestamp = windowStart;
    }

    while (stopwatch.Elapsed < duration)
    {
        var remainingInWindow = windowLimitValues - windowValues;
        if (remainingInWindow <= 0)
        {
            await VerifyAndResetWindowAsync();
            continue;
        }

        var currentBatch = (int)Math.Min(batchValues, remainingInWindow);
        var rows = new List<TelemetryData>(currentBatch);
        for (var index = 0; index < currentBatch; index++)
        {
            var ordinal = windowValues + index + 1L;
            var timestamp = windowStart.AddTicks(ordinal);
            lastTimestamp = timestamp;
            rows.Add(new TelemetryData
            {
                DeviceId = deviceId,
                KeyName = "stage3-soak-double",
                DateTime = timestamp,
                DataSide = DataSide.ClientSide,
                Type = DataType.Double,
                Value_Double = totalValues + index + 1d
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
                    $"INFLUX_STAGE3_SOAK_RETRY total_values={totalValues} batch_values={currentBatch} attempt={attempt} delay_ms={delay.TotalMilliseconds:F0}");
                await Task.Delay(delay);
            }
        }
        batchWatch.Stop();
        maxBatchMilliseconds = Math.Max(maxBatchMilliseconds, batchWatch.Elapsed.TotalMilliseconds);
        Ensure(result?.Result == true, $"Influx soak batch failed after {totalValues} values and {maxAttempts} attempts.");
        totalValues += currentBatch;
        windowValues += currentBatch;
        SampleResources();

        if (windowValues >= windowLimitValues)
            await VerifyAndResetWindowAsync();

        if (stopwatch.Elapsed >= nextReport)
        {
            var elapsedSeconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
            var cpu = (process.TotalProcessorTime - startedCpu).TotalMilliseconds
                      / Math.Max(1d, stopwatch.Elapsed.TotalMilliseconds)
                      / Math.Max(1, Environment.ProcessorCount) * 100d;
            Console.WriteLine(
                $"INFLUX_STAGE3_SOAK_REPORT elapsed_seconds={elapsedSeconds:F0} total_values={totalValues} values_per_sec={totalValues / elapsedSeconds:F0} " +
                $"window_values={windowValues} peak_working_set_mb={peakWorkingSet / 1024d / 1024d:F1} peak_managed_heap_mb={peakManagedHeap / 1024d / 1024d:F1} " +
                $"peak_handles={peakHandles} avg_cpu_pct={cpu:F1} batch_retries={batchRetries} max_batch_ms={maxBatchMilliseconds:F0} " +
                $"max_count_ms={maxCountMilliseconds:F0} max_delete_ms={maxDeleteMilliseconds:F0}");
            nextReport += TimeSpan.FromSeconds(reportSeconds);
        }
    }

    if (windowValues > 0)
    {
        var finalVerifyWatch = Stopwatch.StartNew();
        await VerifyAndResetWindowAsync();
        finalVerifyWatch.Stop();
        finalVerifyMilliseconds = finalVerifyWatch.Elapsed.TotalMilliseconds;
    }

    stopwatch.Stop();
    SampleResources();
    var seconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    var averageCpu = (process.TotalProcessorTime - startedCpu).TotalMilliseconds
                     / Math.Max(1d, stopwatch.Elapsed.TotalMilliseconds)
                     / Math.Max(1, Environment.ProcessorCount) * 100d;
    var overshootSeconds = Math.Max(0d, stopwatch.Elapsed.TotalSeconds - duration.TotalSeconds);
    Console.WriteLine(
        $"INFLUX_STAGE3_SOAK_PASS duration_seconds={stopwatch.Elapsed.TotalSeconds:F0} total_values={totalValues} verified_windows={verifiedWindows} " +
        $"avg_values_per_sec={totalValues / seconds:F0} peak_working_set_mb={peakWorkingSet / 1024d / 1024d:F1} " +
        $"peak_managed_heap_mb={peakManagedHeap / 1024d / 1024d:F1} peak_handles={peakHandles} avg_cpu_pct={averageCpu:F1} " +
        $"gen0={GC.CollectionCount(0) - startedGen0} gen1={GC.CollectionCount(1) - startedGen1} gen2={GC.CollectionCount(2) - startedGen2} " +
        $"batch_retries={batchRetries} max_batch_ms={maxBatchMilliseconds:F0} max_count_ms={maxCountMilliseconds:F0} " +
        $"max_delete_ms={maxDeleteMilliseconds:F0} final_verify_ms={finalVerifyMilliseconds:F0} overshoot_seconds={overshootSeconds:F0}");
}

async Task RunNativeTypesAndDuplicateReplayAsync(string connectionString, InfluxConnection connection, SingleClientPool pool)
{
    var timestamp = DateTime.UtcNow.AddMinutes(-4);
    var deviceId = Guid.NewGuid();
    var rows = CreateNativeRows(deviceId, timestamp);
    var storage = CreateStorage(connectionString, pool, 10_000);

    var first = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Ensure(first.Result, "Influx native-type materialized write failed.");
    var count1 = await CountValuesAsync(connection, pool.Client, deviceId, timestamp.AddSeconds(-1), timestamp.AddSeconds(2));
    Ensure(count1 == 8, $"Expected 8 Influx field values after first replay, actual={count1}.");

    var second = await storage.StoreTelemetryHistoryRowsAsync(rows, 1);
    Ensure(second.Result, "Influx duplicate materialized replay failed.");
    var count2 = await CountValuesAsync(connection, pool.Client, deviceId, timestamp.AddSeconds(-1), timestamp.AddSeconds(2));
    Ensure(count2 == 8, $"Influx duplicate replay was not idempotent. Expected=8 Actual={count2}.");

    var values = await ReadValuesAsync(connection, pool.Client, deviceId, timestamp.AddSeconds(-1), timestamp.AddSeconds(2));
    Ensure(values.Count == 8, $"Expected 8 typed fields, actual={values.Count}.");
    Ensure(Convert.ToBoolean(values["bool_value"], CultureInfo.InvariantCulture), "Boolean value mismatch.");
    Ensure(Convert.ToString(values["string_value"], CultureInfo.InvariantCulture) == "stage3-string", "String value mismatch.");
    Ensure(Convert.ToInt64(values["long_value"], CultureInfo.InvariantCulture) == 42L, "Long value mismatch.");
    Ensure(Math.Abs(Convert.ToDouble(values["double_value"], CultureInfo.InvariantCulture) - 12.5d) < 0.000001d, "Double value mismatch.");
    Ensure(Convert.ToString(values["json_value"], CultureInfo.InvariantCulture) == "{\"phase\":3}", "JSON value mismatch.");
    Ensure(Convert.ToString(values["xml_value"], CultureInfo.InvariantCulture) == "<stage3><value>ok</value></stage3>", "XML value mismatch.");
    Ensure(Convert.ToString(values["binary_value"], CultureInfo.InvariantCulture) == "0102FE", "Binary value mismatch.");
    var expectedDateMs = rows.Single(row => row.KeyName == "datetime_value").Value_DateTime!.Value.ToUniversalTime().Subtract(DateTime.UnixEpoch).TotalMilliseconds;
    Ensure(Math.Abs(Convert.ToDouble(values["datetime_value"], CultureInfo.InvariantCulture) - expectedDateMs) < 0.01d, "DateTime epoch-millisecond value mismatch.");

    Console.WriteLine("INFLUX_STAGE3_TYPES_PASS values=8 duplicate_count=8 types=boolean,string,long,double,json,xml,binary,datetime");
}

async Task<int> RunBatchBenchmarksAsync(string connectionString, InfluxConnection connection, SingleClientPool pool)
{
    var bestBatch = BenchmarkBatchSizes[0];
    var bestRate = 0d;
    var baseTime = DateTime.UtcNow.AddMinutes(-3);

    foreach (var batchSize in BenchmarkBatchSizes)
    {
        var deviceId = Guid.NewGuid();
        var rows = CreateDoubleRows(deviceId, $"batch_{batchSize}", BenchmarkValues, baseTime.AddMilliseconds(batchSize / 100));
        var storage = CreateStorage(connectionString, pool, batchSize);
        var stopwatch = Stopwatch.StartNew();
        var result = await storage.StoreTelemetryHistoryRowsAsync(rows, BenchmarkValues);
        stopwatch.Stop();
        Ensure(result.Result, $"Influx batch benchmark failed for batch={batchSize}.");
        var actual = await CountValuesAsync(connection, pool.Client, deviceId, rows[0].DateTime.AddSeconds(-1), rows[^1].DateTime.AddSeconds(1));
        Ensure(actual == BenchmarkValues, $"Influx batch benchmark count mismatch for batch={batchSize}. Expected={BenchmarkValues} Actual={actual}");
        var rate = BenchmarkValues / Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
        if (rate > bestRate)
        {
            bestRate = rate;
            bestBatch = batchSize;
        }
        Console.WriteLine($"INFLUX_STAGE3_BATCH batch_values={batchSize} values={actual} elapsed_ms={stopwatch.Elapsed.TotalMilliseconds:F0} values_per_sec={rate:F0}");
    }

    Console.WriteLine($"INFLUX_STAGE3_BATCH_BEST batch_values={bestBatch} values_per_sec={bestRate:F0}");
    return bestBatch;
}

async Task RunMillionValuesAsync(string connectionString, InfluxConnection connection, SingleClientPool pool, int batchSize)
{
    var deviceId = Guid.NewGuid();
    var baseTime = DateTime.UtcNow.AddMinutes(-2);
    var rows = CreateDoubleRows(deviceId, "million_value", MillionValues, baseTime);
    var storage = CreateStorage(connectionString, pool, batchSize);
    var stopwatch = Stopwatch.StartNew();
    var result = await storage.StoreTelemetryHistoryRowsAsync(rows, MillionValues);
    stopwatch.Stop();
    Ensure(result.Result, "Influx one-million-value write failed.");
    var actual = await CountValuesAsync(connection, pool.Client, deviceId, rows[0].DateTime.AddSeconds(-1), rows[^1].DateTime.AddSeconds(1));
    Ensure(actual == MillionValues, $"Influx one-million exact count mismatch. Expected={MillionValues} Actual={actual}");

    var samplePayload = string.Join('\n', rows.Take(10_000).Select(InfluxTelemetryHistoryWriter.BuildRowRecord));
    var gzipRatio = GzipRatio(samplePayload);
    var rate = MillionValues / Math.Max(stopwatch.Elapsed.TotalSeconds, 0.001d);
    Console.WriteLine($"INFLUX_STAGE3_MILLION_PASS values={actual} batch_values={batchSize} elapsed_ms={stopwatch.Elapsed.TotalMilliseconds:F0} values_per_sec={rate:F0} gzip={pool.Client.IsGzipEnabled().ToString().ToLowerInvariant()} gzip_sample_ratio={gzipRatio:F3} sample_payload_bytes={Encoding.UTF8.GetByteCount(samplePayload)}");
}

async Task RunDurableRestartAsync(string connectionString, InfluxConnection connection, SingleClientPool pool, int batchSize)
{
    var timestamp = DateTime.UtcNow.AddMinutes(-1);
    var deviceId = Guid.NewGuid();
    var settings = CreateSettings(connectionString, batchSize);
    var storage = CreateStorage(connectionString, pool, batchSize);
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage3-influx-spool", Guid.NewGuid().ToString("N"));
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
        var process1 = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        var enqueue = await process1.EnqueueAsync([message]);
        Ensure(enqueue.RowCount == 8, "Expected 8 durable rows before restart.");
        Ensure(process1.GetBacklogSnapshot().PendingBatches == 1, "Expected one pending durable batch before restart.");

        var process2 = new TelemetryHistorySpool(new EventBusOption { AppSettings = settings }, NullLogger<TelemetryHistorySpool>.Instance);
        await process2.RecoverAsync();
        var recovered = await process2.PeekOldestAsync();
        Ensure(recovered is not null && recovered.Rows.Count == 8, "Restart recovery did not materialize the expected 8 rows.");
        Ensure(storage.SupportsTelemetryHistoryRowReplay, "Influx storage did not advertise replay during durable recovery.");

        var replay = await storage.StoreTelemetryHistoryRowsAsync(recovered!.Rows, recovered.MessageCount);
        Ensure(replay.Result, "Influx durable History replay failed after restart.");
        await process2.AckAsync(recovered);
        Ensure(process2.GetBacklogSnapshot().PendingBatches == 0, "Influx durable backlog did not clear after ACK.");
        var actual = await CountValuesAsync(connection, pool.Client, deviceId, timestamp.AddSeconds(-1), timestamp.AddSeconds(2));
        Ensure(actual == 8, $"Influx durable restart count mismatch. Expected=8 Actual={actual}");
        Console.WriteLine("INFLUX_STAGE3_RESTART_PASS pending_before=1 recovered_rows=8 pending_after=0 persisted_values=8");
    }
    finally
    {
        TryDeleteDirectory(spoolDirectory);
    }
}

async Task RunOutageRecoveryAsync(
    string connectionString,
    InfluxConnection connection,
    SingleClientPool pool,
    int batchSize,
    TimeSpan outageDuration)
{
    const int batchCount = 20;
    const int rowsPerBatch = 8;
    var deviceId = Guid.NewGuid();
    var baseTime = DateTime.UtcNow.AddMinutes(-2);
    var settings = CreateSettings(connectionString, batchSize);
    var spoolDirectory = Path.Combine(Path.GetTempPath(), "iotsharp-stage3-influx-outage", Guid.NewGuid().ToString("N"));
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
        for (var index = 0; index < batchCount; index++)
        {
            var enqueue = await spool.EnqueueAsync([CreateNativeMessage(deviceId, baseTime.AddMilliseconds(index))]);
            Ensure(enqueue.RowCount == rowsPerBatch, $"Influx outage spool row mismatch at batch {index}.");
        }

        var before = spool.GetBacklogSnapshot();
        Ensure(before.PendingBatches == batchCount, $"Expected {batchCount} Influx pending batches before recovery, got {before.PendingBatches}.");
        Ensure(before.PendingRows == batchCount * rowsPerBatch, $"Expected {batchCount * rowsPerBatch} Influx pending rows before recovery, got {before.PendingRows}.");

        var realStorage = CreateStorage(connectionString, pool, batchSize);
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
        Ensure(after.PendingBatches == 0 && after.PendingRows == 0, "Influx outage backlog did not fully drain.");
        var actual = await CountValuesAsync(connection, pool.Client, deviceId, baseTime.AddSeconds(-1), baseTime.AddSeconds(2));
        Ensure(actual == batchCount * rowsPerBatch, $"Influx outage recovery count mismatch. Expected={batchCount * rowsPerBatch} Actual={actual}");
        Ensure(metrics.RetriedBatches > 0, "Influx outage recovery did not record any retry.");
        Ensure(metrics.DrainedRows == batchCount * rowsPerBatch, $"Influx drained-row metric mismatch: {metrics.DrainedRows}.");
        Console.WriteLine($"INFLUX_STAGE3_OUTAGE_RECOVERY_PASS outage_seconds={outageDuration.TotalSeconds:F0} pending_before={before.PendingBatches} pending_rows_before={before.PendingRows} retries={metrics.RetriedBatches} drained_rows={metrics.DrainedRows} pending_after=0");
    }
    finally
    {
        TryDeleteDirectory(spoolDirectory);
    }
}

async Task ReportCardinalityAsync(InfluxConnection connection, InfluxDBClient client)
{
    var flux = $"import \"influxdata/influxdb/schema\"\n"
        + $"schema.measurementTagKeys(bucket: \"{EscapeFlux(connection.Bucket)}\", measurement: \"TelemetryData\", start: -1h)";
    var tables = await client.GetQueryApi().QueryAsync(flux, connection.Org);
    var tagKeys = tables.SelectMany(table => table.Records)
        .Select(record => Convert.ToString(record.GetValue(), CultureInfo.InvariantCulture) ?? string.Empty)
        .Where(value => value.Length > 0)
        .Distinct(StringComparer.Ordinal)
        .OrderBy(value => value, StringComparer.Ordinal)
        .ToArray();
    Ensure(tagKeys.Contains("DeviceId", StringComparer.Ordinal), "DeviceId tag missing from Influx telemetry measurement.");
    Ensure(!tagKeys.Contains("KeyName", StringComparer.Ordinal), "KeyName must remain a field, not a tag.");
    var userTagKeys = tagKeys.Where(value => !value.StartsWith('_')).ToArray();
    Ensure(userTagKeys.SequenceEqual(["DeviceId"], StringComparer.Ordinal), $"Unexpected user telemetry tags: {string.Join(',', userTagKeys)}");

    var valuesFlux = $"import \"influxdata/influxdb/schema\"\n"
        + $"schema.measurementTagValues(bucket: \"{EscapeFlux(connection.Bucket)}\", measurement: \"TelemetryData\", tag: \"DeviceId\", start: -1h)";
    var valueTables = await client.GetQueryApi().QueryAsync(valuesFlux, connection.Org);
    var deviceTagValues = valueTables.SelectMany(table => table.Records)
        .Select(record => Convert.ToString(record.GetValue(), CultureInfo.InvariantCulture))
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Distinct(StringComparer.Ordinal)
        .Count();
    Console.WriteLine($"INFLUX_STAGE3_CARDINALITY user_tag_keys={string.Join(',', userTagKeys)} device_series={deviceTagValues} keyname_tag=false");
}

InfluxDBStorage CreateStorage(string connectionString, SingleClientPool pool, int batchValues)
{
    var settings = CreateSettings(connectionString, batchValues);
    var options = Options.Create(settings);
    var writer = new InfluxTelemetryHistoryWriter(pool, options, new Stage3ConsoleLogger<InfluxTelemetryHistoryWriter>());
    return new InfluxDBStorage(new Stage3ConsoleLogger<InfluxDBStorage>(), options, pool, writer);
}

AppSettings CreateSettings(string connectionString, int batchValues)
    => new()
    {
        TelemetryInfluxBatchValues = batchValues,
        TelemetryInfluxGzipEnabled = true,
        ConnectionStrings = new Dictionary<string, string>
        {
            ["TelemetryStorage"] = connectionString
        }
    };

SingleClientPool CreatePool(InfluxConnection connection)
{
    var builder = InfluxDBClientOptions.Builder.CreateNew().Url(connection.Url);
    if (!string.IsNullOrWhiteSpace(connection.Token))
        builder.AuthenticateToken(connection.Token);
    var client = new InfluxDBClient(builder.Build());
    return new SingleClientPool(client);
}

InfluxConnection ParseConnection(string connectionString)
{
    var uri = new Uri(connectionString);
    var query = HttpUtility.ParseQueryString(uri.Query);
    var org = query.Get("org") ?? string.Empty;
    var bucket = query.Get("bucket") ?? string.Empty;
    var token = query.Get("token") ?? string.Empty;
    Ensure(org.Length > 0, "Influx connection string requires org.");
    Ensure(bucket.Length > 0, "Influx connection string requires bucket.");
    return new InfluxConnection(uri.GetLeftPart(UriPartial.Authority), org, bucket, token);
}

InfluxConnection ReadCliConfig(string configName, string bucket)
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var path = Path.Combine(home, ".influxdbv2", "configs");
    Ensure(File.Exists(path), $"Influx CLI config file was not found: {path}");

    string? currentSection = null;
    string? url = null;
    string? org = null;
    string? token = null;
    foreach (var rawLine in File.ReadLines(path))
    {
        var line = rawLine.Trim();
        if (line.Length == 0 || line.StartsWith('#'))
            continue;
        if (line.StartsWith('[') && line.EndsWith(']'))
        {
            currentSection = line[1..^1].Trim();
            continue;
        }
        if (!string.Equals(currentSection, configName, StringComparison.Ordinal))
            continue;

        var equals = line.IndexOf('=');
        if (equals <= 0)
            continue;
        var key = line[..equals].Trim();
        var value = line[(equals + 1)..].Trim().Trim('"');
        switch (key)
        {
            case "url": url = value; break;
            case "org": org = value; break;
            case "token": token = value; break;
        }
    }

    Ensure(!string.IsNullOrWhiteSpace(url), $"Influx CLI config '{configName}' does not contain url.");
    Ensure(!string.IsNullOrWhiteSpace(org), $"Influx CLI config '{configName}' does not contain org.");
    Ensure(!string.IsNullOrWhiteSpace(token), $"Influx CLI config '{configName}' does not contain token.");
    return new InfluxConnection(url!, org!, bucket, token!);
}

List<TelemetryData> CreateNativeRows(Guid deviceId, DateTime timestamp)
{
    var valueDate = new DateTime(2026, 9, 17, 8, 30, 15, DateTimeKind.Utc);
    return
    [
        new() { DeviceId = deviceId, KeyName = "bool_value", DateTime = timestamp, Type = DataType.Boolean, Value_Boolean = true },
        new() { DeviceId = deviceId, KeyName = "string_value", DateTime = timestamp, Type = DataType.String, Value_String = "stage3-string" },
        new() { DeviceId = deviceId, KeyName = "long_value", DateTime = timestamp, Type = DataType.Long, Value_Long = 42L },
        new() { DeviceId = deviceId, KeyName = "double_value", DateTime = timestamp, Type = DataType.Double, Value_Double = 12.5d },
        new() { DeviceId = deviceId, KeyName = "json_value", DateTime = timestamp, Type = DataType.Json, Value_Json = "{\"phase\":3}" },
        new() { DeviceId = deviceId, KeyName = "xml_value", DateTime = timestamp, Type = DataType.XML, Value_XML = "<stage3><value>ok</value></stage3>" },
        new() { DeviceId = deviceId, KeyName = "binary_value", DateTime = timestamp, Type = DataType.Binary, Value_Binary = [0x01, 0x02, 0xFE] },
        new() { DeviceId = deviceId, KeyName = "datetime_value", DateTime = timestamp, Type = DataType.DateTime, Value_DateTime = valueDate }
    ];
}

PlayloadData CreateNativeMessage(Guid deviceId, DateTime timestamp)
{
    using var json = JsonDocument.Parse("{\"phase\":3}");
    var jsonElement = json.RootElement.Clone();
    var xml = new XmlDocument();
    xml.LoadXml("<stage3><value>ok</value></stage3>");
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
            ["string_value"] = "stage3-string",
            ["long_value"] = 42L,
            ["double_value"] = 12.5d,
            ["json_value"] = jsonElement,
            ["xml_value"] = xml,
            ["binary_value"] = new byte[] { 0x01, 0x02, 0xFE },
            ["datetime_value"] = new DateTime(2026, 9, 17, 8, 30, 15, DateTimeKind.Utc)
        }
    };
}

List<TelemetryData> CreateDoubleRows(Guid deviceId, string key, int count, DateTime baseTime)
{
    var rows = new List<TelemetryData>(count);
    for (var index = 0; index < count; index++)
    {
        rows.Add(new TelemetryData
        {
            DeviceId = deviceId,
            KeyName = key,
            DateTime = baseTime.AddTicks(index + 1L),
            DataSide = DataSide.ClientSide,
            Type = DataType.Double,
            Value_Double = index * 0.001d
        });
    }
    return rows;
}

async Task<long> CountValuesAsync(InfluxConnection connection, InfluxDBClient client, Guid deviceId, DateTime start, DateTime stop)
{
    var flux = $"from(bucket: \"{EscapeFlux(connection.Bucket)}\")\n"
        + $"  |> range(start: time(v: \"{start.ToUniversalTime():O}\"), stop: time(v: \"{stop.ToUniversalTime():O}\"))\n"
        + "  |> filter(fn: (r) => r[\"_measurement\"] == \"TelemetryData\")\n"
        + $"  |> filter(fn: (r) => r[\"DeviceId\"] == \"{deviceId:D}\")\n"
        + "  |> count()";
    var tables = await client.GetQueryApi().QueryAsync(flux, connection.Org);
    return tables.SelectMany(table => table.Records).Sum(record => Convert.ToInt64(record.GetValue(), CultureInfo.InvariantCulture));
}

async Task<Dictionary<string, object>> ReadValuesAsync(InfluxConnection connection, InfluxDBClient client, Guid deviceId, DateTime start, DateTime stop)
{
    var flux = $"from(bucket: \"{EscapeFlux(connection.Bucket)}\")\n"
        + $"  |> range(start: time(v: \"{start.ToUniversalTime():O}\"), stop: time(v: \"{stop.ToUniversalTime():O}\"))\n"
        + "  |> filter(fn: (r) => r[\"_measurement\"] == \"TelemetryData\")\n"
        + $"  |> filter(fn: (r) => r[\"DeviceId\"] == \"{deviceId:D}\")";
    var tables = await client.GetQueryApi().QueryAsync(flux, connection.Org);
    return tables.SelectMany(table => table.Records)
        .GroupBy(record => record.GetField(), StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.Last().GetValue(), StringComparer.Ordinal);
}

double GzipRatio(string payload)
{
    var source = Encoding.UTF8.GetBytes(payload);
    using var output = new MemoryStream();
    using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
        gzip.Write(source, 0, source.Length);
    return source.Length == 0 ? 0d : (double)output.Length / source.Length;
}

string EscapeFlux(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

string? ReadArg(string[] input, string name)
{
    for (var index = 0; index < input.Length - 1; index++)
        if (string.Equals(input[index], name, StringComparison.OrdinalIgnoreCase))
            return input[index + 1];
    return null;
}

int ReadIntArg(string[] input, string name, int defaultValue, int minValue, int maxValue)
{
    var value = ReadArg(input, name);
    if (string.IsNullOrWhiteSpace(value))
        return defaultValue;
    Ensure(int.TryParse(value, out var parsed), $"{name} requires an integer value.");
    return Math.Clamp(parsed, minValue, maxValue);
}

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
    }
}

sealed record InfluxConnection(string Url, string Org, string Bucket, string Token)
{
    public string ToConnectionString()
        => $"{Url.TrimEnd('/')}/?org={Uri.EscapeDataString(Org)}&bucket={Uri.EscapeDataString(Bucket)}&token={Uri.EscapeDataString(Token)}";
}

sealed class Stage3ConsoleLogger<T> : ILogger<T>
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
            $"INFLUX_STAGE3_LOG level={logLevel} event_id={eventId.Id} message={formatter(state, exception)}");
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

sealed class SingleClientPool(InfluxDBClient client) : ObjectPool<InfluxDBClient>, IDisposable
{
    public InfluxDBClient Client { get; } = client;
    public override InfluxDBClient Get() => Client;
    public override void Return(InfluxDBClient obj) { }
    public void Dispose() => Client.Dispose();
}
