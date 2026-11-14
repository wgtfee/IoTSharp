using System;
using System.Collections.Generic;
using System.Linq;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmTrendDirection { Unknown, Stable, Declining, Improving }

/// <summary>Explainable health-index trend, not failure probability or remaining useful life.</summary>
public sealed record PdmTrendFinding(
    PdmTrendDirection Direction, int ValidWindows, double? SlopePointsPerHour,
    double? ChangePoints, DateTime? WindowEndUtc, string Reason)
{
    public bool IsActionable => Direction == PdmTrendDirection.Declining;
}

/// <summary>
/// Pure offline analysis of already persisted P1 snapshots. No storage, alert, PLC or work-order side effects.
/// Rejects mixed scopes, bad quality, gaps, duplicated timestamps, missing approval and invalid scores.
/// </summary>
public static class PdmTrendDetector
{
    public static PdmTrendFinding Analyze(
        PdmDeviceProfile profile, IReadOnlyList<PdmHealthSnapshot> snapshots,
        int minimumWindows = 5, double materialChangePerHour = 5)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(snapshots);
        PdmTrendFinding Unknown(string reason) =>
            new(PdmTrendDirection.Unknown, 0, null, null, null, reason);

        if (!profile.Enabled || !profile.PointMappingsVerified || !profile.RunStateVerified ||
            profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty ||
            profile.DeviceId == Guid.Empty || profile.Id == Guid.Empty)
            return Unknown("设备、点位或运行工况尚未可信确认");
        if (minimumWindows is < 3 or > 32 ||
            !double.IsFinite(materialChangePerHour) || materialChangePerHour is <= 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(materialChangePerHour));
        if (snapshots.Count < minimumWindows || snapshots.Count > 256)
            return Unknown("连续健康评估窗口不足或超出内存分析上限");

        // Never silently discard foreign-tenant data, even outside the latest N windows.
        if (snapshots.Any(s => s == null || s.TenantId != profile.TenantId ||
            s.CustomerId != profile.CustomerId || s.DeviceId != profile.DeviceId ||
            s.ProfileId != profile.Id || s.ProfileVersion != profile.Version))
            return Unknown("评估序列存在跨设备、跨租户或规则版本混用");

        var ordered = snapshots.OrderBy(s => s.WindowEndUtc).ToArray();
        var selected = ordered.TakeLast(Math.Min(32, ordered.Length)).ToArray();
        if (selected.Any(s => s.WindowStartUtc.Kind != DateTimeKind.Utc ||
            s.WindowEndUtc.Kind != DateTimeKind.Utc ||
            s.WindowEndUtc <= s.WindowStartUtc ||
            s.DataQuality is not ("Good" or "Partial") ||
            s.RiskLevel is "Unknown" ||
            !s.HealthIndex.HasValue ||
            !double.IsFinite(s.HealthIndex.Value) ||
            s.HealthIndex.Value is < 0 or > 100 ||
            !double.IsFinite(s.CoverageRatio) ||
            s.CoverageRatio < profile.MinimumCoverageRatio))
            return Unknown("存在不可信时间、质量不足或无效评分");

        for (var i = 1; i < selected.Length; i++)
        {
            if (selected[i].WindowStartUtc != selected[i - 1].WindowEndUtc)
                return Unknown("健康评估窗口存在断档、交叠或重复");
        }

        var count = selected.Length;
        var x0 = selected[0].WindowEndUtc;
        var hours = selected.Select(s => (s.WindowEndUtc - x0).TotalHours).ToArray();
        var values = selected.Select(s => s.HealthIndex!.Value).ToArray();
        var xm = hours.Average();
        var ym = values.Average();
        var xx = hours.Sum(x => (x - xm) * (x - xm));
        if (xx <= 0 || !double.IsFinite(xx))
            return Unknown("趋势时间跨度异常");

        var slope = hours.Zip(values, (x, y) => (x - xm) * (y - ym)).Sum() / xx;
        if (!double.IsFinite(slope))
            return Unknown("趋势计算发生数值溢出");
        var change = values[^1] - values[0];
        var direction = slope <= -materialChangePerHour && change < 0
            ? PdmTrendDirection.Declining
            : slope >= materialChangePerHour && change > 0
                ? PdmTrendDirection.Improving
                : PdmTrendDirection.Stable;
        var reason = direction switch
        {
            PdmTrendDirection.Declining => "连续可信窗口内规则健康指数明显下降，建议人工复核趋势",
            PdmTrendDirection.Improving => "连续可信窗口内规则健康指数上升",
            _ => "连续可信窗口内未出现超过阈值的方向性变化"
        };
        return new(direction, count, Math.Round(slope, 4), Math.Round(change, 4),
            selected[^1].WindowEndUtc, reason);
    }
}

