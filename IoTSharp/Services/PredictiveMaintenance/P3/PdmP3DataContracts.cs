using System;
using System.Collections.Generic;
using System.Linq;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>Identity and verified sensor meaning for a single offline replay series.</summary>
public sealed record PdmP3SeriesScope(
    Guid TenantId, Guid CustomerId, Guid DeviceId, Guid ProfileId,
    int ProfileVersion, string PointKey, string EngineeringUnit,
    string OperatingMode, bool MappingVerified, bool UnitVerified,
    bool OperatingModeVerified);

public enum PdmP3SampleQuality { Unknown, Good, Partial, Bad }
public enum PdmP3FaultTruth { Unlabeled, ConfirmedNormal, ConfirmedFault }

/// <summary>UTC event-time observation. SourceId identifies traceable import provenance.</summary>
public sealed record PdmP3Observation(
    PdmP3SeriesScope Scope, DateTimeOffset EventTimeUtc, double Value,
    PdmP3SampleQuality Quality, string SourceId);

/// <summary>
/// Human-verified evaluation label. Verification timestamp may be later than the
/// observed fault; it cannot be used until it exists as of the evaluation cutoff.
/// Unlabeled must NEVER be interpreted as confirmed normal.
/// </summary>
public sealed record PdmP3FaultLabel(
    PdmP3SeriesScope Scope, DateTimeOffset EventTimeUtc,
    DateTimeOffset VerifiedAtUtc, PdmP3FaultTruth Truth,
    string CaseReference, string VerifiedBy);

public sealed record PdmP3Validation(
    bool Accepted, string Reason, int AcceptedRows, DateTimeOffset? LatestTimeUtc);

public static class PdmP3DatasetValidator
{
    private static bool ValidScope(PdmP3SeriesScope scope) =>
        scope.TenantId != Guid.Empty && scope.CustomerId != Guid.Empty &&
        scope.DeviceId != Guid.Empty && scope.ProfileId != Guid.Empty &&
        scope.ProfileVersion >= 1 && scope.MappingVerified && scope.UnitVerified &&
        scope.OperatingModeVerified &&
        !string.IsNullOrWhiteSpace(scope.PointKey) &&
        !string.IsNullOrWhiteSpace(scope.EngineeringUnit) &&
        !string.IsNullOrWhiteSpace(scope.OperatingMode) &&
        scope.PointKey.Length <= 128 && scope.EngineeringUnit.Length <= 32 &&
        scope.OperatingMode.Length <= 64 &&
        !string.Equals(scope.OperatingMode, "Unknown", StringComparison.OrdinalIgnoreCase);

    private static bool IsUtc(DateTimeOffset timestamp) =>
        timestamp.Offset == TimeSpan.Zero &&
        timestamp != default &&
        timestamp.Year >= 2000;

    /// <summary>
    /// Requires ordered, homogeneous samples from one verified sensor and operating
    /// condition. Never silently sorts foreign or duplicate rows. Incomplete data
    /// fails closed rather than inventing a clean baseline.
    /// </summary>
    public static PdmP3Validation ValidateSamples(
        IReadOnlyList<PdmP3Observation> observations,
        int minRows = 5, int maxRows = 4096,
        TimeSpan? maxGap = null)
    {
        ArgumentNullException.ThrowIfNull(observations);
        if (minRows is < 1 or > 4096 || maxRows < minRows || maxRows > 100_000)
            throw new ArgumentOutOfRangeException(nameof(minRows));
        if (observations.Count < minRows || observations.Count > maxRows)
            return new(false, "离线样本量不足或超过读取上限", 0, null);
        var scope = observations[0]?.Scope;
        if (scope is null || !ValidScope(scope))
            return new(false, "设备、点位、单位或运行工况尚未核验", 0, null);
        var gapLimit = maxGap ?? TimeSpan.FromHours(2);
        if (gapLimit <= TimeSpan.Zero || gapLimit > TimeSpan.FromDays(30))
            throw new ArgumentOutOfRangeException(nameof(maxGap));
        DateTimeOffset? previous = null;
        foreach (var row in observations)
        {
            if (row is null || row.Scope != scope || !IsUtc(row.EventTimeUtc) ||
                row.Quality != PdmP3SampleQuality.Good ||
                !double.IsFinite(row.Value) ||
                string.IsNullOrWhiteSpace(row.SourceId) ||
                row.SourceId.Length > 160)
                return new(false, "时间/作用域/数据质量/来源不可信", 0, null);
            if (previous.HasValue &&
                (row.EventTimeUtc <= previous.Value ||
                 row.EventTimeUtc - previous.Value > gapLimit))
                return new(false, "样本时间乱序、重复或存在超限断档", 0, null);
            previous = row.EventTimeUtc;
        }
        return new(true, "离线样本通过严格校验", observations.Count, previous);
    }

    /// <summary>
    /// Enforces label provenance and the as-of availability rule; never upgrades
    /// a missing/unknown label to a negative example.
    /// </summary>
    public static PdmP3Validation ValidateLabels(
        PdmP3SeriesScope scope,
        IReadOnlyList<PdmP3FaultLabel> labels,
        DateTimeOffset asOfUtc)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(labels);
        if (!ValidScope(scope) || !IsUtc(asOfUtc))
            return new(false, "作用域或标签评测截止时间不可信", 0, null);
        if (labels.Count > 100_000)
            return new(false, "标签数量超过离线限制", 0, null);
        var unique = new HashSet<DateTimeOffset>();
        DateTimeOffset? latest = null;
        foreach (var label in labels)
        {
            if (label is null || label.Scope != scope ||
                !IsUtc(label.EventTimeUtc) || !IsUtc(label.VerifiedAtUtc) ||
                label.EventTimeUtc > label.VerifiedAtUtc ||
                label.VerifiedAtUtc > asOfUtc ||
                label.Truth is not (PdmP3FaultTruth.ConfirmedNormal or PdmP3FaultTruth.ConfirmedFault) ||
                string.IsNullOrWhiteSpace(label.CaseReference) ||
                string.IsNullOrWhiteSpace(label.VerifiedBy) ||
                label.CaseReference.Length > 160 || label.VerifiedBy.Length > 160 ||
                !unique.Add(label.EventTimeUtc))
                return new(false, "未核验/未来才可用/重复或跨设备标签被拒绝", 0, null);
            latest = !latest.HasValue || label.EventTimeUtc > latest.Value
                ? label.EventTimeUtc : latest;
        }
        return new(true, "故障标签与 as-of 时间通过校验", labels.Count, latest);
    }
}

