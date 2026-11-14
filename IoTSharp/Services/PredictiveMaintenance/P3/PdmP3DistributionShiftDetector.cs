using System;
using System.Collections.Generic;
using System.Linq;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public enum PdmP3DistributionShiftState { Unknown, Stable, ShiftDetected }

/// <summary>Offline distribution shift evidence, not concept drift proof or fault prediction.</summary>
public sealed record PdmP3DistributionShift(
    PdmP3DistributionShiftState State, DateTimeOffset? AtUtc,
    double? BaselineMedian, double? RecentMedian, double? ShiftScore,
    int BaselineSamples, int RecentSamples, string Explanation,
    bool IsReadOnly = true);

/// <summary>
/// Compare two non-overlapping, causally ordered windows from the SAME
/// verified sensor/operating condition. Robust scale has an explicit floor.
/// This is a statistical distribution shift heuristic, not an ML drift score.
/// </summary>
public static class PdmP3DistributionShiftDetector
{
    public static PdmP3DistributionShift Evaluate(
        IReadOnlyList<PdmP3Observation> history,
        int baselineCount = 6, int recentCount = 6,
        double threshold = 3.0, double minimumScale = 0.25)
    {
        ArgumentNullException.ThrowIfNull(history);
        if (baselineCount is < 3 or > 128 || recentCount is < 3 or > 128 ||
            !double.IsFinite(threshold) || threshold < 1 || threshold > 50 ||
            !double.IsFinite(minimumScale) || minimumScale <= 0 || minimumScale > 10000)
            throw new ArgumentOutOfRangeException(nameof(baselineCount));
        PdmP3DistributionShift Unknown(string why) =>
            new(PdmP3DistributionShiftState.Unknown, history.Count > 0 ?
                history[^1]?.EventTimeUtc : null,
                null, null, null, 0, 0, why);

        var required = baselineCount + recentCount;
        if (history.Count < required)
            return Unknown("缺少相互独立的早期与近期可信窗口");
        var validation = PdmP3DatasetValidator.ValidateSamples(history, required);
        if (!validation.Accepted) return Unknown(validation.Reason);
        // Exactly the latest required samples; no time overlap.
        var start = history.Count - required;
        var baseline = history.Skip(start).Take(baselineCount).Select(x => x.Value).ToArray();
        var recent = history.Skip(start + baselineCount).Take(recentCount)
            .Select(x => x.Value).ToArray();
        var earlyMedian = Median(baseline);
        var recentMedian = Median(recent);
        var mad = Median(baseline.Select(x => Math.Abs(x - earlyMedian)).ToArray());
        var scale = Math.Max(minimumScale, 1.4826 * mad);
        var shift = Math.Abs(recentMedian - earlyMedian) / scale;
        if (!double.IsFinite(shift))
            return Unknown("统计尺度或分布位移发生溢出");
        var flagged = shift >= threshold;
        var why = flagged
            ? $"同工况早期中位数 {earlyMedian:G6} 与近期中位数 {recentMedian:G6} 出现统计分布变化；需复核传感器与工况"
            : "两段相互独立的同工况窗口未出现超过阈值的分布偏移；不代表证明设备正常";
        return new(flagged ? PdmP3DistributionShiftState.ShiftDetected :
            PdmP3DistributionShiftState.Stable,
            history[^1].EventTimeUtc, Math.Round(earlyMedian, 6),
            Math.Round(recentMedian, 6), Math.Round(shift, 6),
            baselineCount, recentCount, why);
    }

    private static double Median(double[] x)
    {
        Array.Sort(x);
        var n = x.Length;
        return n % 2 == 1 ? x[n/2] : x[n/2 - 1] / 2 + x[n/2] / 2;
    }
}

