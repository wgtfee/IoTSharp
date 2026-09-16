using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Options;
using System;
using Xunit;

namespace IoTSharp.Test;

public sealed class GatewayActivitySignalGateTests
{
    [Fact]
    public void Gate_PublishesFirstSignalThenCoalescesInsideInterval()
    {
        var gate = Create();
        var id = Guid.NewGuid();
        var now = new DateTime(2026, 9, 15, 6, 0, 0, DateTimeKind.Utc);

        Assert.True(gate.ShouldPublish(id, 300, now));
        Assert.False(gate.ShouldPublish(id, 300, now.AddSeconds(29)));
        Assert.True(gate.ShouldPublish(id, 300, now.AddSeconds(30)));
    }

    [Fact]
    public void Gate_UsesShorterIntervalForShortTimeout()
    {
        var gate = Create();
        var id = Guid.NewGuid();
        var now = new DateTime(2026, 9, 15, 6, 0, 0, DateTimeKind.Utc);

        Assert.True(gate.ShouldPublish(id, 9, now));
        Assert.False(gate.ShouldPublish(id, 9, now.AddSeconds(2)));
        Assert.True(gate.ShouldPublish(id, 9, now.AddSeconds(3)));
    }

    [Fact]
    public void GetInterval_IsCappedByConfiguredMaximum()
    {
        var interval = GatewayActivitySignalGate.GetInterval(3600, new GatewayActivitySignalOptions
        {
            MinIntervalSeconds = 1,
            MaxIntervalSeconds = 20,
            TimeoutDivisor = 3
        });
        Assert.Equal(TimeSpan.FromSeconds(20), interval);
    }

    private static GatewayActivitySignalGate Create()
        => new(Options.Create(new GatewayActivitySignalOptions
        {
            MinIntervalSeconds = 1,
            MaxIntervalSeconds = 30,
            TimeoutDivisor = 3
        }));
}
