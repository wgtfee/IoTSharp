using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace IoTSharp.Services.Ingestion;

public sealed class GatewayBatchIngestOptions
{
    public const string SectionName = "GatewayBatchIngest";

    public int Version { get; set; } = 1;
    public int MaxBatchBytes { get; set; } = 512 * 1024;
    public int MaxBatchPoints { get; set; } = 2000;
    public int MaxDevicesPerBatch { get; set; } = 500;
}

public sealed class GatewayTelemetryBatchEnvelope
{
    public int Version { get; set; }
    public string GatewayId { get; set; } = string.Empty;
    public long BatchId { get; set; }
    public long Timestamp { get; set; }
    public List<GatewayTelemetryBatchDevice> Devices { get; set; } = [];
}

public sealed class GatewayTelemetryBatchDevice
{
    public string DeviceId { get; set; } = string.Empty;
    public Dictionary<string, object> Values { get; set; } = [];
}

internal sealed record GatewayBatchValidationResult(
    bool Success,
    string Error,
    GatewayTelemetryBatchEnvelope? Batch,
    DateTime TimestampUtc,
    int PointCount)
{
    public static GatewayBatchValidationResult Fail(string error)
        => new(false, error, null, default, 0);
}

internal static class GatewayBatchIngestValidator
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    internal static GatewayBatchValidationResult Validate(
        ReadOnlyMemory<byte> payload,
        string routeGatewayId,
        Device sessionDevice,
        GatewayBatchIngestOptions options)
    {
        ArgumentNullException.ThrowIfNull(sessionDevice);
        ArgumentNullException.ThrowIfNull(options);

        var normalized = Normalize(options);
        if (payload.Length == 0)
            return GatewayBatchValidationResult.Fail("Batch payload is empty.");
        if (payload.Length > normalized.MaxBatchBytes)
            return GatewayBatchValidationResult.Fail($"Batch payload exceeds {normalized.MaxBatchBytes} bytes.");
        if (sessionDevice.DeviceType != DeviceType.Gateway)
            return GatewayBatchValidationResult.Fail("MQTT session is not a gateway device.");
        if (string.IsNullOrWhiteSpace(routeGatewayId))
            return GatewayBatchValidationResult.Fail("Route gatewayId is required.");
        if (!MatchesSessionGateway(routeGatewayId, sessionDevice))
            return GatewayBatchValidationResult.Fail("Route gatewayId does not match authenticated MQTT gateway.");

        GatewayTelemetryBatchEnvelope? batch;
        try
        {
            batch = JsonSerializer.Deserialize<GatewayTelemetryBatchEnvelope>(payload.Span, JsonOptions);
        }
        catch (JsonException ex)
        {
            return GatewayBatchValidationResult.Fail($"Batch JSON is invalid: {ex.Message}");
        }

        if (batch is null)
            return GatewayBatchValidationResult.Fail("Batch JSON is empty.");
        if (batch.Version != normalized.Version)
            return GatewayBatchValidationResult.Fail($"Unsupported batch version {batch.Version}; expected {normalized.Version}.");
        if (string.IsNullOrWhiteSpace(batch.GatewayId))
            return GatewayBatchValidationResult.Fail("Payload gatewayId is required.");
        if (!string.Equals(routeGatewayId, batch.GatewayId, StringComparison.OrdinalIgnoreCase))
            return GatewayBatchValidationResult.Fail("Route gatewayId does not match payload gatewayId.");
        if (batch.Devices is null || batch.Devices.Count == 0)
            return GatewayBatchValidationResult.Fail("Batch must contain at least one device.");
        if (batch.Devices.Count > normalized.MaxDevicesPerBatch)
            return GatewayBatchValidationResult.Fail($"Batch contains more than {normalized.MaxDevicesPerBatch} devices.");

        DateTime timestampUtc;
        try
        {
            timestampUtc = DateTimeOffset.FromUnixTimeMilliseconds(batch.Timestamp).UtcDateTime;
        }
        catch (ArgumentOutOfRangeException)
        {
            return GatewayBatchValidationResult.Fail("Batch timestamp is outside the supported Unix millisecond range.");
        }

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pointCount = 0;
        foreach (var device in batch.Devices)
        {
            if (string.IsNullOrWhiteSpace(device.DeviceId))
                return GatewayBatchValidationResult.Fail("Every batch device requires deviceId.");
            if (!names.Add(device.DeviceId))
                return GatewayBatchValidationResult.Fail($"Duplicate deviceId '{device.DeviceId}' is not allowed in batch V1.");
            if (device.Values is null || device.Values.Count == 0)
                return GatewayBatchValidationResult.Fail($"Device '{device.DeviceId}' has no telemetry values.");
            if (device.Values.Keys.Any(string.IsNullOrWhiteSpace))
                return GatewayBatchValidationResult.Fail($"Device '{device.DeviceId}' contains an empty telemetry key.");

            pointCount = checked(pointCount + device.Values.Count);
            if (pointCount > normalized.MaxBatchPoints)
                return GatewayBatchValidationResult.Fail($"Batch contains more than {normalized.MaxBatchPoints} telemetry points.");
        }

        return new GatewayBatchValidationResult(true, string.Empty, batch, timestampUtc, pointCount);
    }

    internal static Dictionary<string, object> ToTelemetryValues(GatewayTelemetryBatchDevice device)
        // V1 batch envelope is no longer used after controller fan-out. Transfer the already
        // deserialized dictionary directly to PlayloadData instead of allocating/copying it again.
        => device.Values;

    private static bool MatchesSessionGateway(string routeGatewayId, Device sessionDevice)
        => string.Equals(routeGatewayId, sessionDevice.Name, StringComparison.OrdinalIgnoreCase)
           || string.Equals(routeGatewayId, sessionDevice.Id.ToString("D"), StringComparison.OrdinalIgnoreCase)
           || string.Equals(routeGatewayId, sessionDevice.Id.ToString("N"), StringComparison.OrdinalIgnoreCase);

    private static GatewayBatchIngestOptions Normalize(GatewayBatchIngestOptions source) => new()
    {
        Version = Math.Max(1, source.Version),
        MaxBatchBytes = Math.Max(1024, source.MaxBatchBytes),
        MaxBatchPoints = Math.Max(1, source.MaxBatchPoints),
        MaxDevicesPerBatch = Math.Max(1, source.MaxDevicesPerBatch)
    };
}
