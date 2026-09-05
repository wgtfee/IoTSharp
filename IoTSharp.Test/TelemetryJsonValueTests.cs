using IoTSharp.Contracts;
using IoTSharp.Data;
using System.Collections.Generic;
using System.Text.Json;
using Xunit;

namespace IoTSharp.Test
{
    public class TelemetryJsonValueTests
    {
        [Fact]
        public void FillKVToMeStoresJsonArrayAsJsonTelemetry()
        {
            using var document = JsonDocument.Parse("""
                [
                  { "托盘号": "P001", "占用": true },
                  { "托盘号": "P002", "占用": false }
                ]
                """);
            var telemetry = new TelemetryData();

            telemetry.FillKVToMe(new KeyValuePair<string, object>("托盘数组", document.RootElement.Clone()));

            Assert.Equal(DataType.Json, telemetry.Type);
            Assert.Null(telemetry.Value_Boolean);
            Assert.Equal(document.RootElement.GetRawText(), telemetry.Value_Json);
        }

        [Fact]
        public void FillKVToMeStoresJsonObjectAsJsonTelemetry()
        {
            using var document = JsonDocument.Parse("""{ "托盘号": "P001", "占用": true }""");
            var telemetry = new TelemetryData();

            telemetry.FillKVToMe(new KeyValuePair<string, object>("托盘状态", document.RootElement.Clone()));

            Assert.Equal(DataType.Json, telemetry.Type);
            Assert.Null(telemetry.Value_Boolean);
            Assert.Equal(document.RootElement.GetRawText(), telemetry.Value_Json);
        }
    }
}
