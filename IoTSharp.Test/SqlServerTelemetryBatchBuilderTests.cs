using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace IoTSharp.Test;

public sealed class SqlServerTelemetryBatchBuilderTests
{
    [Fact]
    public void Build_PreservesDistinctHistoryAndUsesLastValueForLatest()
    {
        var deviceId = Guid.NewGuid();
        var first = new DateTime(2026, 9, 15, 1, 0, 0, DateTimeKind.Utc);
        var second = first.AddSeconds(1);
        var latestTimestamp = first.AddMinutes(1);
        var messages = new[]
        {
            Message(deviceId, first, "temperature", 20L),
            Message(deviceId, second, "temperature", 21L)
        };

        var batch = SqlServerTelemetryBatchBuilder.Build(messages, latestTimestamp);

        Assert.Equal(2, batch.HistoryRows.Count);
        Assert.Equal(new long?[] { 20, 21 }, batch.HistoryRows.OrderBy(x => x.DateTime).Select(x => x.Value_Long).ToArray());
        var latest = Assert.Single(batch.LatestRows);
        Assert.Equal(21L, latest.Value_Long);
        Assert.Equal(latestTimestamp, latest.DateTime);
        Assert.Equal(DataCatalog.TelemetryLatest, latest.Catalog);
    }

    [Fact]
    public void Build_DeduplicatesExactHistoryPrimaryKeyAndKeepsLastValue()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 15, 2, 0, 0, DateTimeKind.Utc);
        var messages = new[]
        {
            Message(deviceId, timestamp, "counter", 1L),
            Message(deviceId, timestamp, "counter", 2L)
        };

        var batch = SqlServerTelemetryBatchBuilder.Build(messages, timestamp.AddSeconds(1));

        var history = Assert.Single(batch.HistoryRows);
        Assert.Equal(2L, history.Value_Long);
        Assert.Equal(2L, Assert.Single(batch.LatestRows).Value_Long);
    }

    [Fact]
    public void Build_PreservesJsonArrayAsJsonTelemetry()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = DateTime.UtcNow;
        using var document = JsonDocument.Parse("""[{"托盘号":"P001"},{"托盘号":"P002"}]""");
        var rawJson = document.RootElement.GetRawText();
        var message = Message(deviceId, timestamp, "托盘数组", document.RootElement.Clone());

        var batch = SqlServerTelemetryBatchBuilder.Build([message], timestamp.AddSeconds(1));

        var history = Assert.Single(batch.HistoryRows);
        Assert.Equal(DataType.Json, history.Type);
        Assert.Equal(rawJson, history.Value_Json);
        var latest = Assert.Single(batch.LatestRows);
        Assert.Equal(DataType.Json, latest.Type);
        Assert.Equal(rawJson, latest.Value_Json);
    }

    [Fact]
    public void Build_WhenLatestTypeChanges_DoesNotCarryOldTypedValue()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = DateTime.UtcNow;
        var messages = new[]
        {
            Message(deviceId, timestamp, "mixed", "old"),
            Message(deviceId, timestamp.AddMilliseconds(1), "mixed", 12.5d)
        };

        var batch = SqlServerTelemetryBatchBuilder.Build(messages, timestamp.AddSeconds(1));

        var latest = Assert.Single(batch.LatestRows);
        Assert.Equal(DataType.Double, latest.Type);
        Assert.Equal(12.5d, latest.Value_Double);
        Assert.Null(latest.Value_String);
        Assert.Null(latest.Value_Long);
        Assert.Null(latest.Value_Boolean);
    }

    [Fact]
    public void Build_CopiesBinaryAndDateTimeTypedValuesToLatestAfterDeduplication()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 15, 6, 0, 0, DateTimeKind.Utc);
        var latestTimestamp = timestamp.AddMinutes(1);
        var bytes = new byte[] { 1, 2, 3, 4 };
        var dateValue = timestamp.AddHours(-1);
        var message = new PlayloadData
        {
            DeviceId = deviceId,
            ts = timestamp,
            DataSide = DataSide.ClientSide,
            DataCatalog = DataCatalog.TelemetryData,
            MsgBody = new Dictionary<string, object>
            {
                ["binary"] = bytes,
                ["date"] = dateValue
            }
        };

        var batch = SqlServerTelemetryBatchBuilder.Build([message], latestTimestamp);
        var latest = batch.LatestRows.ToDictionary(item => item.KeyName);

        Assert.Equal(DataType.Binary, latest["binary"].Type);
        Assert.Same(bytes, latest["binary"].Value_Binary);
        Assert.Equal(DataType.DateTime, latest["date"].Type);
        Assert.Equal(dateValue, latest["date"].Value_DateTime);
        Assert.Equal(latestTimestamp, latest["date"].DateTime);
    }

    private static PlayloadData Message(Guid deviceId, DateTime timestamp, string key, object value) => new()
    {
        DeviceId = deviceId,
        ts = timestamp,
        DataSide = DataSide.ClientSide,
        DataCatalog = DataCatalog.TelemetryData,
        MsgBody = new Dictionary<string, object> { [key] = value }
    };
}
