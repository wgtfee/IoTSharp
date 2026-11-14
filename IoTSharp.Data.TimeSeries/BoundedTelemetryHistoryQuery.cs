using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;

namespace IoTSharp.Storage;

/// <summary>
/// Optional read-only historical capability for background PdM.
/// IMPORTANT: limit must be pushed into the backend query (TOP/LIMIT/Flux limit).
/// A provider that cannot guarantee the limit/cancellation must not implement it.
/// Existing IStorage read/write contracts are unaffected.
/// </summary>
public interface IBoundedTelemetryHistoryStorage
{
    Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
        Guid deviceId,
        IReadOnlyList<string> keys,
        DateTime beginUtc,
        DateTime endUtc,
        int maxRows,
        CancellationToken cancellationToken);
}

public sealed class TelemetryHistoryLimitExceededException : InvalidOperationException
{
    public TelemetryHistoryLimitExceededException()
        : base("PdM history row budget exceeded; no truncated/partial window may be scored.") { }
}

/// <summary>Shared fail-closed validation, deterministic ordering and LIMIT+1 detection.</summary>
public static class BoundedTelemetryHistoryQuery
{
    public static string[] Validate(
        Guid deviceId, IReadOnlyList<string> keys,
        DateTime beginUtc, DateTime endUtc, int maxRows)
    {
        if (deviceId == Guid.Empty)
            throw new ArgumentException("Device id must not be empty", nameof(deviceId));
        ArgumentNullException.ThrowIfNull(keys);
        if (keys.Count is < 1 or > 33 ||
            keys.Any(k => string.IsNullOrWhiteSpace(k) || k.Length > 128 ||
                k.Any(c => !(char.IsLetterOrDigit(c) || c is '_' or '-' or '.' or '/' or ':'))) ||
            keys.Distinct(StringComparer.Ordinal).Count() != keys.Count)
            throw new ArgumentException("PdM must request only distinct, explicit safe telemetry keys", nameof(keys));
        if (beginUtc.Kind != DateTimeKind.Utc || endUtc.Kind != DateTimeKind.Utc ||
            beginUtc >= endUtc || endUtc - beginUtc > TimeSpan.FromMinutes(60))
            throw new ArgumentException("PdM requires a bounded half-open UTC history window");
        if (maxRows is < 1 or > 100_000)
            throw new ArgumentOutOfRangeException(nameof(maxRows));
        return keys.ToArray();
    }

    /// <summary>Pure composable EF expression. Take(maxRows+1) translates to TOP/LIMIT by Provider.</summary>
    public static IQueryable<TelemetryData> Build(
        IQueryable<TelemetryData> telemetry,
        Guid deviceId, IReadOnlyList<string> keys,
        DateTime beginUtc, DateTime endUtc, int maxRows)
    {
        var selected = Validate(deviceId, keys, beginUtc, endUtc, maxRows);
        return telemetry.Where(t => t.DeviceId == deviceId &&
                                    t.DateTime >= beginUtc && t.DateTime < endUtc &&
                                    selected.Contains(t.KeyName))
            .OrderBy(t => t.DateTime)
            .ThenBy(t => t.KeyName)
            .Take(maxRows + 1)
            // Only materialize numeric/bool telemetry. Binary, JSON, XML and text
            // payloads can be huge; fetching them would defeat a row-count budget.
            .Select(t => new TelemetryData
            {
                DeviceId = t.DeviceId,
                KeyName = t.KeyName,
                DateTime = t.DateTime,
                Type = t.Type,
                Value_Boolean = t.Value_Boolean,
                Value_Long = t.Value_Long,
                Value_Double = t.Value_Double
            });
    }

    public static List<TelemetryDataDto> CompleteOrThrow(List<TelemetryDataDto> values, int maxRows)
    {
        ArgumentNullException.ThrowIfNull(values);
        if (values.Count > maxRows) throw new TelemetryHistoryLimitExceededException();
        return values;
    }
}
