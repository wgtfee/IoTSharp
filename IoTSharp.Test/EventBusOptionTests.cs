using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.EventBus;
using Xunit;

namespace IoTSharp.Test;

public class EventBusOptionTests
{
    [Fact]
    public async Task RunRules_WhenNoHandlerRegistered_CompletesWithoutThrowing()
    {
        var option = new EventBusOption();

        await option.RunRules(Guid.NewGuid(), new object(), EventType.Telemetry);
    }

    [Fact]
    public async Task DispatchTelemetryRules_ByDefault_InvokesTelemetryThenTelemetryArray()
    {
        var option = new EventBusOption();
        var events = new List<EventType>();
        option.RunRules += (_, _, eventType) =>
        {
            events.Add(eventType);
            return Task.CompletedTask;
        };

        await option.DispatchTelemetryRules(Guid.NewGuid(), new object(), new object());

        Assert.Equal(new[] { EventType.Telemetry, EventType.TelemetryArray }, events);
    }
}
