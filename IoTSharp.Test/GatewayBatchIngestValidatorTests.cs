using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.Ingestion;
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using Xunit;

namespace IoTSharp.Test;

public sealed class GatewayBatchIngestValidatorTests
{
    [Fact]
    public void ToTelemetryValues_RemainsReadableAfterSourceEnvelopeCanBeCollected()
    {
        var values = ConvertValuesAndReleaseEnvelope();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);

        var value = Assert.IsType<JsonElement>(values["a"]);
        Assert.Equal(1, value.GetInt32());
    }

    private static Dictionary<string, object> ConvertValuesAndReleaseEnvelope()
    {
        var result = Validate("""{"version":1,"gatewayId":"GW001","batchId":1,"timestamp":1789440000000,"devices":[{"deviceId":"PLC01","values":{"a":1}}]}""");
        Assert.True(result.Success, result.Error);
        return GatewayBatchIngestValidator.ToTelemetryValues(result.Batch!.Devices[0]);
    }
    private static readonly Guid GatewayGuid = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Device SessionGateway = new()
    {
        Id = GatewayGuid,
        Name = "GW001",
        DeviceType = DeviceType.Gateway
    };

    [Fact]
    public void Validate_AcceptsV1BatchAndPreservesJsonValues()
    {
        var json = """
        {"version":1,"gatewayId":"GW001","batchId":12,"timestamp":1789440000000,"devices":[
          {"deviceId":"PLC01","values":{"temperature":23.5,"running":true,"pallets":[12,23,0] }},
          {"deviceId":"PLC02","values":{"speed":1200}}
        ]}
        """;

        var result = Validate(json);

        Assert.True(result.Success, result.Error);
        Assert.Equal(2, result.Batch!.Devices.Count);
        Assert.Equal(4, result.PointCount);
        var values = GatewayBatchIngestValidator.ToTelemetryValues(result.Batch.Devices[0]);
        Assert.Same(result.Batch.Devices[0].Values, values);
        Assert.True(values.ContainsKey("pallets"));
        Assert.Equal("[12,23,0]", ((System.Text.Json.JsonElement)values["pallets"]).GetRawText());
    }

    [Fact]
    public void Validate_RejectsPayloadOverByteLimit()
    {
        var options = Options(maxBytes: 1024);
        var payload = new byte[1025];
        var result = GatewayBatchIngestValidator.Validate(payload, "GW001", SessionGateway, options);
        Assert.False(result.Success);
        Assert.Contains("exceeds", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Validate_RejectsUnsupportedVersion()
    {
        var result = Validate("""{"version":2,"gatewayId":"GW001","batchId":1,"timestamp":1789440000000,"devices":[{"deviceId":"PLC01","values":{"a":1}}]}""");
        Assert.False(result.Success);
        Assert.Contains("version", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Validate_RejectsGatewayImpersonation()
    {
        var result = Validate("""{"version":1,"gatewayId":"GW002","batchId":1,"timestamp":1789440000000,"devices":[{"deviceId":"PLC01","values":{"a":1}}]}""");
        Assert.False(result.Success);
        Assert.Contains("gatewayId", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Validate_RejectsTooManyPoints()
    {
        var options = Options(maxPoints: 2);
        var json = """{"version":1,"gatewayId":"GW001","batchId":1,"timestamp":1789440000000,"devices":[{"deviceId":"PLC01","values":{"a":1,"b":2,"c":3}}]}""";
        var result = GatewayBatchIngestValidator.Validate(Encoding.UTF8.GetBytes(json), "GW001", SessionGateway, options);
        Assert.False(result.Success);
        Assert.Contains("points", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Validate_RejectsDuplicateDeviceInV1()
    {
        var result = Validate("""{"version":1,"gatewayId":"GW001","batchId":1,"timestamp":1789440000000,"devices":[{"deviceId":"PLC01","values":{"a":1}},{"deviceId":"plc01","values":{"b":2}}]}""");
        Assert.False(result.Success);
        Assert.Contains("Duplicate", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Validate_AllowsGatewayGuidInRoute()
    {
        var json = $"{{\"version\":1,\"gatewayId\":\"{GatewayGuid:D}\",\"batchId\":1,\"timestamp\":1789440000000,\"devices\":[{{\"deviceId\":\"PLC01\",\"values\":{{\"a\":1}}}}]}}";
        var result = GatewayBatchIngestValidator.Validate(Encoding.UTF8.GetBytes(json), GatewayGuid.ToString("D"), SessionGateway, Options());
        Assert.True(result.Success, result.Error);
    }

    private static GatewayBatchValidationResult Validate(string json)
        => GatewayBatchIngestValidator.Validate(Encoding.UTF8.GetBytes(json), "GW001", SessionGateway, Options());

    private static GatewayBatchIngestOptions Options(int maxBytes = 512 * 1024, int maxPoints = 2000) => new()
    {
        Version = 1,
        MaxBatchBytes = maxBytes,
        MaxBatchPoints = maxPoints,
        MaxDevicesPerBatch = 500
    };
}
