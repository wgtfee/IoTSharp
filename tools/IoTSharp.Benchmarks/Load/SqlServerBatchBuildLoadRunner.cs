using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace IoTSharp.Benchmarks.Load;

internal static class SqlServerBatchBuildLoadRunner
{
    public static int Run(string[] args)
    {
        var points = ReadInt(args, "--points", 1_000_000);
        var pointsPerMessage = ReadInt(args, "--points-per-message", 100);
        var mode = ReadString(args, "--mode", "both").ToLowerInvariant();
        var messageCount = (points + pointsPerMessage - 1) / pointsPerMessage;
        var deviceCount = Math.Min(ReadInt(args, "--device-count", messageCount), messageCount);
        VerifyStorageSemantics();
        VerifySqlCommandShape();
        var messages = BuildMessages(points, pointsPerMessage, deviceCount);
        var actualPoints = 0L;
        foreach (var message in messages)
            actualPoints += message.MsgBody.Count;

        if (mode is "materialized" or "both")
        {
            _ = SqlServerTelemetryBatchBuilder.Build(messages, DateTime.UtcNow);
            var measurement = Measure(() => SqlServerTelemetryBatchBuilder.Build(messages, DateTime.UtcNow));
            Print("materialized", actualPoints, messages.Count, pointsPerMessage,
                measurement.Value.HistoryRows.Count, measurement.Value.LatestRows.Count, measurement);
        }

        if (mode is "storage" or "both")
        {
            _ = SqlServerTelemetryBatchBuilder.BuildForStorage(messages, DateTime.UtcNow);
            var measurement = Measure(() => SqlServerTelemetryBatchBuilder.BuildForStorage(messages, DateTime.UtcNow));
            Print("storage", actualPoints, messages.Count, pointsPerMessage,
                measurement.Value.HistoryRows.Count, measurement.Value.LatestSourceIndices.Count, measurement);
            var readerMeasurement = Measure(() => ScanReaders(measurement.Value));
            PrintReader(actualPoints, measurement.Value.HistoryRows.Count + measurement.Value.LatestSourceIndices.Count, readerMeasurement);
        }

        Console.WriteLine($"deviceCount={deviceCount:N0}");
        Console.WriteLine("semanticChecks=storage-dedup/latest/decimal/char/json-null/sql-command-shape OK");
        Console.WriteLine("SQLSERVER_BATCH_BUILD_LOAD_OK");
        return 0;
    }

    private static Measurement<T> Measure<T>(Func<T> action)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var before = GC.GetTotalAllocatedBytes(true);
        var gen0 = GC.CollectionCount(0);
        var gen1 = GC.CollectionCount(1);
        var gen2 = GC.CollectionCount(2);
        var sw = Stopwatch.StartNew();
        var value = action();
        sw.Stop();
        return new Measurement<T>(value, sw.Elapsed,
            GC.GetTotalAllocatedBytes(true) - before,
            GC.CollectionCount(0) - gen0,
            GC.CollectionCount(1) - gen1,
            GC.CollectionCount(2) - gen2);
    }

    private static void Print<T>(string mode, long points, int messages, int pointsPerMessage,
        int historyRows, int latestRows, Measurement<T> measurement)
    {
        var seconds = Math.Max(0.000001, measurement.Elapsed.TotalSeconds);
        Console.WriteLine($"mode={mode} points={points:N0} messages={messages:N0} pointsPerMessage={pointsPerMessage:N0}");
        Console.WriteLine($"mode={mode} historyRows={historyRows:N0} latestRows={latestRows:N0}");
        Console.WriteLine($"mode={mode} elapsedMs={measurement.Elapsed.TotalMilliseconds:N1} pointsPerSec={points / seconds:N0}");
        Console.WriteLine($"mode={mode} allocatedMB={measurement.AllocatedBytes / 1024d / 1024d:N1} bytesPerPoint={measurement.AllocatedBytes / (double)points:N1}");
        Console.WriteLine($"mode={mode} gcGen0={measurement.Gen0} gcGen1={measurement.Gen1} gcGen2={measurement.Gen2}");
        GC.KeepAlive(measurement.Value);
    }

    private static long ScanReaders(SqlServerTelemetryWriteBatch batch)
    {
        var nonNullValues = 0L;
        using (var historyReader = new SqlServerStorage.TelemetryBulkDataReader(batch.HistoryRows, includeCatalog: false))
        {
            while (historyReader.Read())
            {
                for (var column = 0; column < historyReader.FieldCount; column++)
                    if (historyReader.GetValue(column) is not DBNull)
                        nonNullValues++;
            }
        }

        using (var latestReader = new SqlServerStorage.TelemetryBulkDataReader(
                   batch.HistoryRows,
                   includeCatalog: true,
                   rowIndices: batch.LatestSourceIndices,
                   catalogOverride: DataCatalog.TelemetryLatest,
                   dateTimeOverride: batch.LatestTimestampUtc))
        {
            while (latestReader.Read())
            {
                for (var column = 0; column < latestReader.FieldCount; column++)
                    if (latestReader.GetValue(column) is not DBNull)
                        nonNullValues++;
            }
        }

        return nonNullValues;
    }

    private static void PrintReader(long points, int rowsScanned, Measurement<long> measurement)
    {
        var seconds = Math.Max(0.000001, measurement.Elapsed.TotalSeconds);
        Console.WriteLine($"mode=reader rowsScanned={rowsScanned:N0} nonNullValues={measurement.Value:N0}");
        Console.WriteLine($"mode=reader elapsedMs={measurement.Elapsed.TotalMilliseconds:N1} sourcePointsPerSec={points / seconds:N0}");
        Console.WriteLine($"mode=reader allocatedMB={measurement.AllocatedBytes / 1024d / 1024d:N1} bytesPerSourcePoint={measurement.AllocatedBytes / (double)points:N1}");
        Console.WriteLine($"mode=reader gcGen0={measurement.Gen0} gcGen1={measurement.Gen1} gcGen2={measurement.Gen2}");
    }

    private static List<PlayloadData> BuildMessages(int totalPoints, int pointsPerMessage, int deviceCount)
    {
        var messageCount = (totalPoints + pointsPerMessage - 1) / pointsPerMessage;
        var messages = new List<PlayloadData>(messageCount);
        var deviceIds = new Guid[Math.Max(1, deviceCount)];
        for (var deviceIndex = 0; deviceIndex < deviceIds.Length; deviceIndex++)
            deviceIds[deviceIndex] = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 15, 8, 0, 0, DateTimeKind.Utc);
        for (var messageIndex = 0; messageIndex < messageCount; messageIndex++)
        {
            var body = new Dictionary<string, object>(pointsPerMessage, StringComparer.Ordinal);
            var remaining = totalPoints - messageIndex * pointsPerMessage;
            var count = Math.Min(pointsPerMessage, remaining);
            for (var pointIndex = 0; pointIndex < count; pointIndex++)
                body[$"P{pointIndex:D4}"] = (long)(messageIndex * pointsPerMessage + pointIndex);

            messages.Add(new PlayloadData
            {
                DeviceId = deviceIds[messageIndex % deviceIds.Length],
                ts = timestamp.AddMilliseconds(messageIndex),
                DataSide = DataSide.ClientSide,
                DataCatalog = DataCatalog.TelemetryData,
                MsgBody = body
            });
        }
        return messages;
    }

    private static void VerifyStorageSemantics()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 15, 9, 0, 0, DateTimeKind.Utc);
        var messages = new[]
        {
            Message(deviceId, timestamp, "counter", 1L),
            Message(deviceId, timestamp, "counter", 2L),
            Message(deviceId, timestamp.AddMilliseconds(1), "counter", 3L),
            Message(deviceId, timestamp.AddMilliseconds(2), "decimal", 1.25m),
            Message(deviceId, timestamp.AddMilliseconds(2), "char", 'A'),
            Message(deviceId, timestamp.AddMilliseconds(2), "json-null", JsonDocument.Parse("null").RootElement.Clone())
        };

        var batch = SqlServerTelemetryBatchBuilder.BuildForStorage(messages, timestamp.AddMinutes(1));
        var counterRows = batch.HistoryRows.FindAll(row => row.KeyName == "counter");
        if (counterRows.Count != 2
            || counterRows[0].Type != DataType.Long
            || Convert.ToInt64(counterRows[0].Value, CultureInfo.InvariantCulture) != 2L
            || Convert.ToInt64(counterRows[1].Value, CultureInfo.InvariantCulture) != 3L)
            throw new InvalidOperationException("SQL Server storage history dedup semantics changed.");

        var latestCounter = batch.HistoryRows[batch.LatestSourceIndices.Find(index => batch.HistoryRows[index].KeyName == "counter")];
        if (latestCounter.Type != DataType.Long || Convert.ToInt64(latestCounter.Value, CultureInfo.InvariantCulture) != 3L)
            throw new InvalidOperationException("SQL Server storage latest-value semantics changed.");

        var decimalRow = batch.HistoryRows.Find(row => row.KeyName == "decimal");
        if (decimalRow.Type != DataType.Double || Convert.ToDouble(decimalRow.Value, CultureInfo.InvariantCulture) != 1.25d)
            throw new InvalidOperationException("SQL Server storage decimal conversion failed.");

        var charRow = batch.HistoryRows.Find(row => row.KeyName == "char");
        if (charRow.Type != DataType.String || Convert.ToString(charRow.Value, CultureInfo.InvariantCulture) != "A")
            throw new InvalidOperationException("SQL Server storage char conversion failed.");

        var jsonNullRow = batch.HistoryRows.Find(row => row.KeyName == "json-null");
        if (jsonNullRow.Type != DataType.Boolean || jsonNullRow.HasValue)
            throw new InvalidOperationException("SQL Server storage JsonElement null semantics changed.");
    }

    private static void VerifySqlCommandShape()
    {
        var createSql = SqlServerStorage.BuildCreateTempTablesCommandText(
            "#History",
            "[TelemetryData]",
            "#Latest",
            "[DataStorage]");
        if (CountOccurrences(createSql, "SELECT TOP (0)") != 2
            || !createSql.Contains("INTO #History FROM [TelemetryData]", StringComparison.Ordinal)
            || !createSql.Contains("INTO #Latest FROM [DataStorage]", StringComparison.Ordinal))
            throw new InvalidOperationException("SQL Server temp-table command shape changed.");

        var applySql = SqlServerStorage.BuildApplyTelemetryBatchCommandText(
            "#History",
            "[TelemetryData]",
            "#Latest",
            "[DataStorage]");
        if (!applySql.Contains("INSERT INTO [TelemetryData]", StringComparison.Ordinal)
            || !applySql.Contains("UPDATE t WITH (UPDLOCK, HOLDLOCK)", StringComparison.Ordinal)
            || !applySql.Contains("INSERT INTO [DataStorage]", StringComparison.Ordinal)
            || CountOccurrences(applySql, "WITH (UPDLOCK, HOLDLOCK)") != 3
            || applySql.Contains("MERGE", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("SQL Server telemetry apply command shape changed.");
    }

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var start = 0;
        while ((start = source.IndexOf(value, start, StringComparison.Ordinal)) >= 0)
        {
            count++;
            start += value.Length;
        }
        return count;
    }

    private static PlayloadData Message(Guid deviceId, DateTime timestamp, string key, object value) => new()
    {
        DeviceId = deviceId,
        ts = timestamp,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object> { [key] = value }
    };

    private static int ReadInt(string[] args, string name, int fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase) && int.TryParse(args[i + 1], out var value) && value > 0)
                return value;
        return fallback;
    }

    private static string ReadString(string[] args, string name, string fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return fallback;
    }

    private readonly record struct Measurement<T>(T Value, TimeSpan Elapsed, long AllocatedBytes, int Gen0, int Gen1, int Gen2);
}
