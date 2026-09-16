using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Storage;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace IoTSharp.Test;

public sealed class ShardingTelemetryBatchBuilderTests
{
    [Fact]
    public void Build_PreservesEveryHistorySample_AndKeepsLastLatestValue()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 16, 2, 10, 53, DateTimeKind.Utc);
        var messages = new[]
        {
            Payload(deviceId, timestamp, 1),
            Payload(deviceId, timestamp.AddTicks(1), 2),
            Payload(deviceId, timestamp.AddTicks(2), 3)
        };

        var batch = ShardingTelemetryBatchBuilder.Build(messages);

        Assert.Equal(3, batch.HistoryRows.Count);
        Assert.Equal(new[] { 1L, 2L, 3L }, batch.HistoryRows.Select(row => row.Value_Long).ToArray());
        var latest = Assert.Single(batch.LatestValues);
        Assert.Equal(3, Convert.ToInt32(latest.Value));
        Assert.Equal(timestamp.AddTicks(2), latest.Timestamp);
        Assert.Equal(DataSide.ClientSide, latest.DataSide);
    }

    [Fact]
    public void Build_DoesNotDeduplicateHistory_WhenSourceTimestampMatches()
    {
        var deviceId = Guid.NewGuid();
        var timestamp = new DateTime(2026, 9, 16, 2, 10, 53, DateTimeKind.Utc);

        var batch = ShardingTelemetryBatchBuilder.Build(new[]
        {
            Payload(deviceId, timestamp, 10),
            Payload(deviceId, timestamp, 11)
        });

        Assert.Equal(2, batch.HistoryRows.Count);
        Assert.Equal(new[] { 10L, 11L }, batch.HistoryRows.Select(row => row.Value_Long).ToArray());
        Assert.Equal(11, Convert.ToInt32(Assert.Single(batch.LatestValues).Value));
    }

    private static PlayloadData Payload(Guid deviceId, DateTime timestamp, int value) => new()
    {
        DeviceId = deviceId,
        ts = timestamp,
        DataCatalog = DataCatalog.TelemetryData,
        DataSide = DataSide.ClientSide,
        MsgBody = new Dictionary<string, object> { ["p0"] = value }
    };
}
