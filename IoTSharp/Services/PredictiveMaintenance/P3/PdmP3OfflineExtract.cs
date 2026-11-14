using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>
/// Provider capability for strictly bounded, cancellable, projection-only
/// historical telemetry reads. Implementations must enforce maxRows+1 in the DB.
/// Never adapt from unbounded IStorage.LoadTelemetryAsync.
/// </summary>
public interface IPdmP3BoundedTelemetrySource
{
    Task<IReadOnlyList<PdmP3RawTelemetryRow>> ReadBoundedAsync(
        Guid deviceId, string key, DateTimeOffset startInclusiveUtc,
        DateTimeOffset endExclusiveUtc, int maximumRows,
        CancellationToken cancellationToken);
}

/// <summary>Raw source row with explicit original UTC and quality metadata.</summary>
public sealed record PdmP3RawTelemetryRow(
    Guid DeviceId, string PointKey, DateTimeOffset EventTimeUtc,
    double Value, PdmP3SampleQuality Quality, string SourceRecordId);

/// <summary>
/// Explicitly verified per-device point mapping and operating mode supplied by
/// an authorized offline-import operator, not inferred from telemetry key text.
/// </summary>
public sealed record PdmP3OfflineExtractRequest(
    PdmDeviceProfile Profile, PdmPointPolicy PointPolicy,
    string OperatingMode, bool OperatingModeVerified,
    DateTimeOffset FromUtc, DateTimeOffset ToUtc,
    int MaximumRows = 4096);

public sealed record PdmP3OfflineExtractResult(
    bool Accepted, string Reason, PdmP3SeriesScope? Scope,
    IReadOnlyList<PdmP3Observation> Observations, bool IsReadOnly = true)
{
    public static PdmP3OfflineExtractResult Reject(string reason) =>
        new(false, reason, null, Array.Empty<PdmP3Observation>());
}

/// <summary>
/// Offline only; never registered as a production worker. Strict data-capability
/// contract and fail-closed overflow/UTC checks before any model inference.
/// </summary>
public sealed class PdmP3OfflineExtractService(IPdmP3BoundedTelemetrySource source)
{
    public async Task<PdmP3OfflineExtractResult> ExportAsync(
        PdmP3OfflineExtractRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Profile);
        ArgumentNullException.ThrowIfNull(request.PointPolicy);
        var profile = request.Profile;
        var policy = request.PointPolicy;
        if (!profile.Enabled || !profile.PointMappingsVerified ||
            !profile.RunStateVerified || !request.OperatingModeVerified ||
            profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty ||
            profile.DeviceId == Guid.Empty || profile.Id == Guid.Empty ||
            profile.Version < 1 || !policy.Enabled || policy.ProfileId != profile.Id ||
            string.IsNullOrWhiteSpace(policy.TelemetryKey) ||
            string.IsNullOrWhiteSpace(policy.Unit) ||
            policy.TelemetryKey.Length > 128 || policy.Unit.Length > 32 ||
            policy.TelemetryKey.Any(c => c is ',' or ';' || char.IsWhiteSpace(c)) ||
            string.IsNullOrWhiteSpace(request.OperatingMode) ||
            request.OperatingMode.Length > 64 ||
            string.Equals(request.OperatingMode, "Unknown", StringComparison.OrdinalIgnoreCase))
            return PdmP3OfflineExtractResult.Reject("设备点位、单位、状态或权限上下文尚未核验");
        if (request.MaximumRows is < 9 or > 4096 ||
            request.FromUtc.Offset != TimeSpan.Zero ||
            request.ToUtc.Offset != TimeSpan.Zero ||
            request.FromUtc.Year < 2000 ||
            request.ToUtc <= request.FromUtc ||
            request.ToUtc - request.FromUtc > TimeSpan.FromDays(7))
            return PdmP3OfflineExtractResult.Reject("离线 UTC 读取时间和行数边界无效");

        cancellationToken.ThrowIfCancellationRequested();
        // The provider MUST count one more than maxRows to detect truncation,
        // and MUST honor cancellation. Never accept a silently truncated result.
        IReadOnlyList<PdmP3RawTelemetryRow> rows;
        try
        {
            rows = await source.ReadBoundedAsync(profile.DeviceId, policy.TelemetryKey,
                request.FromUtc, request.ToUtc, request.MaximumRows + 1, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            return PdmP3OfflineExtractResult.Reject("Provider 无法证明有界读取与取消语义");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (rows is null || rows.Count > request.MaximumRows)
            return PdmP3OfflineExtractResult.Reject("原始历史超过限额；拒绝截断后推断");
        var scope = new PdmP3SeriesScope(
            profile.TenantId, profile.CustomerId, profile.DeviceId,
            profile.Id, profile.Version, policy.TelemetryKey, policy.Unit,
            request.OperatingMode, true, true, true);
        var samples = new List<PdmP3Observation>(rows.Count);
        foreach (var row in rows)
        {
            if (row is null || row.DeviceId != profile.DeviceId ||
                !string.Equals(row.PointKey, policy.TelemetryKey, StringComparison.Ordinal) ||
                row.EventTimeUtc.Offset != TimeSpan.Zero ||
                row.EventTimeUtc < request.FromUtc || row.EventTimeUtc >= request.ToUtc)
                return PdmP3OfflineExtractResult.Reject("历史数据不在可信设备、点位、UTC 半开时间窗内");
            samples.Add(new(scope, row.EventTimeUtc, row.Value,
                row.Quality, row.SourceRecordId));
        }
        var validation = PdmP3DatasetValidator.ValidateSamples(samples, minRows: 9);
        if (!validation.Accepted) return PdmP3OfflineExtractResult.Reject(validation.Reason);
        return new(true, "已核验的有界离线样本（尚未现场验收真实 Provider）",
            scope, samples);
    }
}

