using IoTSharp.Contracts;
using IoTSharp.Data;
using System;
using System.Buffers;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace IoTSharp.Services.Ingestion;

public sealed class ReliableEventOptions
{
    public const string SectionName = "ReliableEventIngest";
    public int Version { get; set; } = 1;
    public int MaxPayloadBytes { get; set; } = 256 * 1024;
}

public sealed class ReliableEventEnvelope
{
    public int Version { get; init; }
    public string GatewayId { get; init; } = string.Empty;
    public string EventId { get; init; } = string.Empty;
    public string Type { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public DateTime OccurredAt { get; init; }
    public JsonElement Payload { get; init; }
}

public sealed class ReliableEventAck
{
    public int Version { get; init; } = 1;
    public string GatewayId { get; init; } = string.Empty;
    public string EventId { get; init; } = string.Empty;
    public bool Success { get; init; }
    public bool Duplicate { get; init; }
    public long Timestamp { get; init; }
    public string Message { get; init; } = string.Empty;
}

internal enum ReliableEventValidationFailure
{
    None,
    Malformed,
    Unauthorized,
    Unsupported,
    TooLarge
}

internal sealed record ReliableEventValidationResult(
    bool Success,
    string Error,
    ReliableEventValidationFailure Failure,
    ReliableEventEnvelope Event,
    string PayloadHash)
{
    public static ReliableEventValidationResult Fail(string error, ReliableEventValidationFailure failure)
        => new(false, error, failure, null, string.Empty);
}

internal static class ReliableEventParserValidator
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    internal static ReliableEventValidationResult Validate(
        ReadOnlyMemory<byte> payload,
        string routeGatewayId,
        Device sessionDevice,
        ReliableEventOptions options)
    {
        ArgumentNullException.ThrowIfNull(sessionDevice);
        ArgumentNullException.ThrowIfNull(options);

        var maxBytes = Math.Max(1024, options.MaxPayloadBytes);
        var expectedVersion = Math.Max(1, options.Version);
        if (payload.Length == 0)
            return ReliableEventValidationResult.Fail("Reliable event payload is empty.", ReliableEventValidationFailure.Malformed);
        if (payload.Length > maxBytes)
            return ReliableEventValidationResult.Fail($"Reliable event payload exceeds {maxBytes} bytes.", ReliableEventValidationFailure.TooLarge);
        if (sessionDevice.DeviceType != DeviceType.Gateway)
            return ReliableEventValidationResult.Fail("MQTT session is not a gateway device.", ReliableEventValidationFailure.Unauthorized);
        if (string.IsNullOrWhiteSpace(routeGatewayId) || !MatchesSessionGateway(routeGatewayId, sessionDevice))
            return ReliableEventValidationResult.Fail("Route gatewayId does not match authenticated MQTT gateway.", ReliableEventValidationFailure.Unauthorized);

        RawEnvelope raw;
        try
        {
            raw = JsonSerializer.Deserialize<RawEnvelope>(payload.Span, JsonOptions);
        }
        catch (JsonException ex)
        {
            return ReliableEventValidationResult.Fail($"Reliable event JSON is invalid: {ex.Message}", ReliableEventValidationFailure.Malformed);
        }

        if (raw is null)
            return ReliableEventValidationResult.Fail("Reliable event JSON is empty.", ReliableEventValidationFailure.Malformed);
        if (raw.Version != expectedVersion)
            return ReliableEventValidationResult.Fail($"Unsupported reliable event version {raw.Version}; expected {expectedVersion}.", ReliableEventValidationFailure.Unsupported);
        if (string.IsNullOrWhiteSpace(raw.GatewayId))
            return ReliableEventValidationResult.Fail("gatewayId is required.", ReliableEventValidationFailure.Malformed);
        if (!string.Equals(routeGatewayId, raw.GatewayId, StringComparison.OrdinalIgnoreCase))
            return ReliableEventValidationResult.Fail("Route gatewayId does not match payload gatewayId.", ReliableEventValidationFailure.Unauthorized);
        if (string.IsNullOrWhiteSpace(raw.EventId) || raw.EventId.Length > 128)
            return ReliableEventValidationResult.Fail("eventId is required and must not exceed 128 characters.", ReliableEventValidationFailure.Malformed);
        if (string.IsNullOrWhiteSpace(raw.Type) || raw.Type.Length > 64)
            return ReliableEventValidationResult.Fail("type is required and must not exceed 64 characters.", ReliableEventValidationFailure.Malformed);
        if (!string.Equals(raw.Type, "Alarm", StringComparison.OrdinalIgnoreCase))
            return ReliableEventValidationResult.Fail($"Unsupported reliable event type '{raw.Type}'.", ReliableEventValidationFailure.Unsupported);
        if (string.IsNullOrWhiteSpace(raw.DeviceId) || raw.DeviceId.Length > 256)
            return ReliableEventValidationResult.Fail("deviceId is required and must not exceed 256 characters.", ReliableEventValidationFailure.Malformed);
        if (raw.Payload.ValueKind != JsonValueKind.Object)
            return ReliableEventValidationResult.Fail("payload must be a JSON object.", ReliableEventValidationFailure.Malformed);
        if (!TryParseOccurredAt(raw.OccurredAt, out var occurredAt))
            return ReliableEventValidationResult.Fail("occurredAt must be a valid UTC/offset timestamp or Unix milliseconds.", ReliableEventValidationFailure.Malformed);

        var envelope = new ReliableEventEnvelope
        {
            Version = raw.Version,
            GatewayId = raw.GatewayId.Trim(),
            EventId = raw.EventId.Trim(),
            Type = raw.Type.Trim(),
            DeviceId = raw.DeviceId.Trim(),
            OccurredAt = occurredAt,
            Payload = raw.Payload.Clone()
        };
        return new ReliableEventValidationResult(true, string.Empty, ReliableEventValidationFailure.None, envelope, ComputeSemanticHash(envelope));
    }

    private static bool MatchesSessionGateway(string routeGatewayId, Device sessionDevice)
        => string.Equals(routeGatewayId, sessionDevice.Name, StringComparison.OrdinalIgnoreCase)
           || string.Equals(routeGatewayId, sessionDevice.Id.ToString("D"), StringComparison.OrdinalIgnoreCase)
           || string.Equals(routeGatewayId, sessionDevice.Id.ToString("N"), StringComparison.OrdinalIgnoreCase);

    private static bool TryParseOccurredAt(JsonElement value, out DateTime result)
    {
        result = default;
        try
        {
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var unixMs))
            {
                result = DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime;
                return true;
            }
            if (value.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
            {
                result = parsed.UtcDateTime;
                return true;
            }
        }
        catch (ArgumentOutOfRangeException)
        {
        }
        return false;
    }

    internal static string ComputeSemanticHash(ReliableEventEnvelope envelope)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", envelope.Version);
            writer.WriteString("gatewayId", envelope.GatewayId.ToUpperInvariant());
            writer.WriteString("eventId", envelope.EventId);
            writer.WriteString("type", envelope.Type.ToUpperInvariant());
            writer.WriteString("deviceId", envelope.DeviceId.ToUpperInvariant());
            writer.WriteString("occurredAt", envelope.OccurredAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            writer.WritePropertyName("payload");
            WriteCanonicalJson(writer, envelope.Payload);
            writer.WriteEndObject();
        }
        return Convert.ToHexString(SHA256.HashData(buffer.WrittenSpan));
    }

    private static void WriteCanonicalJson(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalJson(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray()) WriteCanonicalJson(writer, item);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(value.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(value.GetRawText(), skipInputValidation: true);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON kind {value.ValueKind} in reliable event payload.");
        }
    }

    private sealed class RawEnvelope
    {
        public int Version { get; set; }
        public string GatewayId { get; set; } = string.Empty;
        public string EventId { get; set; } = string.Empty;
        public string Type { get; set; } = string.Empty;
        public string DeviceId { get; set; } = string.Empty;
        public JsonElement OccurredAt { get; set; }
        public JsonElement Payload { get; set; }
    }
}
