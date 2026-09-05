using IoTSharp.Contracts;
using Microsoft.Extensions.DependencyInjection;
using MQTTnet.AspNetCore.Routing.Testing;
using Xunit;

namespace IoTSharp.Test
{
    public class MqttRouteCompatibilityTests
    {
        [Fact]
        public void LowercaseDeviceTelemetryTopicMatchesControllerRoute()
        {
            using var host = MqttRoutingTestHost.Create(services =>
                services.AddIoTSharpMqttServer(new MqttBrokerSetting()));

            var match = host.Match("devices/包装线/telemetry");

            match.EnsureMatched();
            Assert.Equal("devices/{devname}/Telemetry", match.Template);
            Assert.Equal("包装线", match.GetRouteValue<string>("devname"));
        }
    }
}
