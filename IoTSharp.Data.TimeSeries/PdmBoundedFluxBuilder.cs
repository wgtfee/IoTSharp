using System.Globalization;
using System.Text;
using IoTSharp.Contracts;

namespace IoTSharp.Storage;

/// <summary>Safe, deterministic query shape for capped Flux history reads.</summary>
public static class PdmBoundedFluxBuilder
{
    public static string Build(
        string bucket, Guid deviceId, IReadOnlyList<string> keys,
        DateTime beginUtc, DateTime endUtc, int maxRows)
    {
        var selected = BoundedTelemetryHistoryQuery.Validate(deviceId, keys, beginUtc, endUtc, maxRows);
        if (string.IsNullOrWhiteSpace(bucket) || bucket.Length > 128 ||
            bucket.Any(c => !(char.IsLetterOrDigit(c) || c is '_' or '-' or '.')))
            throw new ArgumentException("Influx bucket configuration contains unsafe characters.", nameof(bucket));

        static string Time(DateTime t) =>
            t.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

        // Flux limit() acts per table. Bound EACH input field table before merging;
        // then use a single global budget after group(). Without the first limit,
        // group() could accumulate an unbounded time window server-side.
        // Normalize mixed bool/int/float field types to string to avoid Flux schema collisions;
        // the reader strictly parses back numeric/bool and rejects other values.
        var fieldSet = string.Join(", ", selected.Select(k => $"\"{k}\""));
        var text = new StringBuilder(400);
        text.AppendLine($"from(bucket: \"{bucket}\")");
        text.AppendLine($"  |> range(start: time(v: \"{Time(beginUtc)}\"), stop: time(v: \"{Time(endUtc)}\"))");
        text.AppendLine("  |> filter(fn: (r) => r[\"_measurement\"] == \"TelemetryData\")");
        text.AppendLine($"  |> filter(fn: (r) => r[\"DeviceId\"] == \"{deviceId:D}\")");
        text.AppendLine($"  |> filter(fn: (r) => contains(value: r[\"_field\"], set: [{fieldSet}]))");
        text.AppendLine("  |> map(fn: (r) => ({ r with _value: string(v: r._value) }))");
        text.AppendLine($"  |> limit(n: {maxRows + 1})"); // per-series bound BEFORE group
        text.AppendLine("  |> group(columns: [])");
        text.AppendLine($"  |> limit(n: {maxRows + 1})"); // global budget AFTER group
        return text.ToString();
    }
}

