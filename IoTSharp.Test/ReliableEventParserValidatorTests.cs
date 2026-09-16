using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.Ingestion;
using System;
using System.Text;
using Xunit;

namespace IoTSharp.Test;

public sealed class ReliableEventParserValidatorTests
{
    private static readonly Device Gateway = new()
    {
        Id = Guid.Parse("22222222-2222-2222-2222-222222222222"),
        Name = "GW001",
        DeviceType = DeviceType.Gateway
    };

    [Fact]
    public void Validate_AcceptsAlarmAndCreatesStableSemanticHash()
    {
        var first = Validate("""{"version":1,"gatewayId":"GW001","eventId":"evt-1","type":"Alarm","deviceId":"PLC01","occurredAt":1789440000000,"payload":{"alarmType":"HighTemp","alarmDetail":"hot","serverity":2}}""");
        var second = Validate("""{"version":1,"gatewayId":"GW001","eventId":"evt-1","type":"alarm","deviceId":"plc01","occurredAt":1789440000000,"payload":{"serverity":2,"alarmDetail":"hot","alarmType":"HighTemp"}}""");

        Assert.True(first.Success, first.Error);
        Assert.True(second.Success, second.Error);
        Assert.Equal(first.PayloadHash, second.PayloadHash);
    }

    [Fact]
    public void Validate_RejectsOversizedPayload()
    {
        var options = Options();
        options.MaxPayloadBytes = 1024;
        var result = ReliableEventParserValidator.Validate(new byte[1025], "GW001", Gateway, options);
        Assert.False(result.Success);
        Assert.Equal(ReliableEventValidationFailure.TooLarge, result.Failure);
    }

    [Fact]
    public void Validate_RejectsUnsupportedVersion()
    {
        var result = Validate("""{"version":2,"gatewayId":"GW001","eventId":"evt-1","type":"Alarm","deviceId":"PLC01","occurredAt":1789440000000,"payload":{"alarmType":"A"}}""");
        Assert.False(result.Success);
        Assert.Equal(ReliableEventValidationFailure.Unsupported, result.Failure);
    }

    [Fact]
    public void Validate_RejectsGatewayImpersonation()
    {
        var result = Validate("""{"version":1,"gatewayId":"GW002","eventId":"evt-1","type":"Alarm","deviceId":"PLC01","occurredAt":1789440000000,"payload":{"alarmType":"A"}}""");
        Assert.False(result.Success);
        Assert.Equal(ReliableEventValidationFailure.Unauthorized, result.Failure);
    }

    [Fact]
    public void Validate_RejectsUnsupportedEventType()
    {
        var result = Validate("""{"version":1,"gatewayId":"GW001","eventId":"evt-1","type":"CommandResult","deviceId":"PLC01","occurredAt":1789440000000,"payload":{"ok":true}}""");
        Assert.False(result.Success);
        Assert.Equal(ReliableEventValidationFailure.Unsupported, result.Failure);
    }

    private static ReliableEventValidationResult Validate(string json)
        => ReliableEventParserValidator.Validate(Encoding.UTF8.GetBytes(json), "GW001", Gateway, Options());

    private static ReliableEventOptions Options() => new() { Version = 1, MaxPayloadBytes = 256 * 1024 };
}
