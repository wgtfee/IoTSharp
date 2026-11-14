using System;
using System.Collections.Generic;
using System.Linq;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public enum PdmP3AnomalyState { Unknown, Normal, Anomalous }

/// <summary>Statistical departure from a verified operating baseline, NOT fault probability.</summary>
public sealed record PdmP3AnomalyFinding(
    PdmP3SeriesScope? Scope,
    DateTimeOffset? AtUtc,
    PdmP3AnomalyState State,
    double? RobustDeviationScore,
    double? BaselineMedian,
    double? BaselineMad,
    double? SignedDeviation,
    int BaselineRows,
    string Explanation,
    double? FailureProbability = null,
    TimeSpan? RemainingUsefulLife = null)
{
    public bool IsShadowOnly => true;
}

/// <summary>
/// Robust, causal rolling median/MAD detector. Data at the assessment timestamp
/// is excluded from its own baseline; no supervised training, network, IO,
/// work-order, alert delivery, probability or RUL.
/// </summary>
public static class PdmP3AnomalyDetector
{
    public static PdmP3AnomalyFinding Evaluate(
        IReadOnlyList<PdmP3Observation> history,
        int baselineRows = 8, double threshold = 3.5,
        double minimumScale = 0.25)
    {
        ArgumentNullException.ThrowIfNull(history);
        if (baselineRows is < 5 or > 128 ||
            !double.IsFinite(threshold) || threshold is < 2 or > 20 ||
            !double.IsFinite(minimumScale) || minimumScale is <= 0 or > 10000)
            throw new ArgumentOutOfRangeException(nameof(baselineRows));

        var scope = history.Count > 0 ? history[0]?.Scope : null;
        var timestamp = history.Count > 0 ? history[^1]?.EventTimeUtc : null;
        PdmP3AnomalyFinding Unknown(string why) =>
            new(scope, timestamp, PdmP3AnomalyState.Unknown,
                null, null, null, null, 0, why);

        if (history.Count < baselineRows + 1)
            return Unknown("可比历史样本不足，拒绝生成异常判断");
        var validation = PdmP3DatasetValidator.ValidateSamples(history, baselineRows + 1);
        if (!validation.Accepted)
            return Unknown(validation.Reason);

        // Only the preceding N samples participate in calibration. No label or
        // future sample is used to create the candidate's baseline.
        var previous = history.Skip(history.Count - baselineRows - 1)
            .Take(baselineRows).Select(x => x.Value).ToArray();
        var candidate = history[^1];
        var median = Median(previous);
        var mad = Median(previous.Select(x => Math.Abs(x - median)).ToArray());
        var deviation = candidate.Value - median;
        var scale = Math.Max(1.4826 * mad, minimumScale);
        var score = Math.Abs(deviation) / scale;
        if (!double.IsFinite(median) || !double.IsFinite(mad) ||
            !double.IsFinite(deviation) || !double.IsFinite(score))
            return Unknown("数值溢出，无法信任统计结果");
        var anomaly = score >= threshold;
        var explanation = anomaly
            ? $"数值偏离同工况历史中位数 {median:G6} {candidate.Scope.EngineeringUnit}，偏差 {deviation:G6}，稳健偏离分数 {score:F3}；仅表示统计异常"
            : $"数值位于已核验同工况历史的统计范围，稳健偏离分数 {score:F3}；不代表确认无故障";
        return new(candidate.Scope, candidate.EventTimeUtc,
            anomaly ? PdmP3AnomalyState.Anomalous : PdmP3AnomalyState.Normal,
            Math.Round(score, 6), Math.Round(median, 6), Math.Round(mad, 6),
            Math.Round(deviation, 6), baselineRows, explanation);
    }

    private static double Median(double[] values)
    {
        Array.Sort(values);
        var n = values.Length;
        return n % 2 == 1 ? values[n / 2] :
            values[n / 2 - 1] / 2 + values[n / 2] / 2;
    }
}

