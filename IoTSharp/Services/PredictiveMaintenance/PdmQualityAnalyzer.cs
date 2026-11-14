using System;
using System.Collections.Generic;
using System.Linq;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance;

/// <summary>仅供离线/异步 Worker 调用的原始样本；此 DTO 不写回设备或规则链。</summary>
public sealed record PdmTelemetrySample(Guid TenantId, Guid CustomerId, Guid DeviceId,
    string Key, DateTimeOffset EventTime, double? Value, string Unit);

public enum PdmOperatingState
{
    Unknown,
    Running,
    Stopped,
    Offline
}

public enum PdmPointQualityStatus
{
    Good,
    PolicyInvalid,
    Offline,
    NotRunning,
    OperatingStateUnknown,
    Insufficient,
    Stale,
    UnitMismatch,
    InvalidValue,
    OutOfRange,
    ConflictingDuplicate,
    ExcessiveGap,
    SampleLimitExceeded
}

/// <summary>按设备事件时间计算，不凭空插值或把停机设备判为健康。</summary>
public sealed record PdmPointQuality(
    string TelemetryKey,
    PdmPointQualityStatus Status,
    int ExpectedSamples,
    int ObservedSlots,
    int ExactDuplicates,
    int ReorderedSamples,
    double CoverageRatio,
    double? LatestValue,
    double? SlopePerMinute,
    string Reason)
{
    public bool IsUsable => Status == PdmPointQualityStatus.Good;
    public bool SustainedRise { get; init; }
}

public static class PdmQualityAnalyzer
{
    // 上层 Worker 必须再提供数据库查询限流；此阈值仅用于防止离线计算失控。
    public const int MaxSamplesPerPoint = 25_000;

    public static PdmPointQuality Analyze(
        PdmPointPolicy policy, int windowMinutes, double minimumCoverage,
        DateTimeOffset windowEnd, PdmOperatingState operatingState,
        IReadOnlyList<PdmTelemetrySample> samples)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(samples);
        if (string.IsNullOrWhiteSpace(policy.TelemetryKey)
            || string.IsNullOrWhiteSpace(policy.Unit)
            || policy.ExpectedIntervalSeconds <= 0
            || windowMinutes is <= 0 or > 1440
            || !double.IsFinite(minimumCoverage) || minimumCoverage is < 0 or > 1
            || !double.IsFinite(policy.MinValidValue) || !double.IsFinite(policy.MaxValidValue)
            || policy.MinValidValue >= policy.MaxValidValue)
            return Reject(PdmPointQualityStatus.PolicyInvalid, "采样周期、单位、有效范围或覆盖率配置无效");

        int expected = (int)Math.Ceiling(windowMinutes * 60d / policy.ExpectedIntervalSeconds);
        if (expected <= 0 || expected > MaxSamplesPerPoint)
            return Reject(PdmPointQualityStatus.PolicyInvalid, "窗口样本容量超出单点安全上限");

        if (operatingState == PdmOperatingState.Offline)
            return Reject(PdmPointQualityStatus.Offline, "设备或采集链离线", expected);
        if (operatingState == PdmOperatingState.Stopped)
            return Reject(PdmPointQualityStatus.NotRunning, "停机工况不进行健康评分", expected);
        if (operatingState != PdmOperatingState.Running)
            return Reject(PdmPointQualityStatus.OperatingStateUnknown, "未提供可信的运行状态", expected);

        if (samples.Count > MaxSamplesPerPoint)
            return Reject(PdmPointQualityStatus.SampleLimitExceeded, "单点样本数量超出安全上限", expected);

        var end = windowEnd.ToUniversalTime();
        var start = end.AddMinutes(-windowMinutes);
        var inWindow = samples.Where(s => string.Equals(s.Key, policy.TelemetryKey, StringComparison.Ordinal)
               && s.EventTime.ToUniversalTime() >= start
               && s.EventTime.ToUniversalTime() < end).ToList();
        if (inWindow.Count == 0)
            return Reject(PdmPointQualityStatus.Insufficient, "窗口内没有实际样本", expected);

        var times = new Dictionary<DateTimeOffset, PdmTelemetrySample>();
        int duplicateCount = 0;
        int reorderCount = 0;
        DateTimeOffset? previous = null;
        foreach (var sample in inWindow)
        {
            var timestamp = sample.EventTime.ToUniversalTime();
            if (previous.HasValue && timestamp < previous.Value) reorderCount++;
            previous = timestamp;
            if (times.TryGetValue(timestamp, out var prior))
            {
                if (prior.Value != sample.Value || !string.Equals(prior.Unit, sample.Unit, StringComparison.Ordinal))
                    return Reject(PdmPointQualityStatus.ConflictingDuplicate,
                        "同时间戳出现冲突数据", expected, times.Count, duplicateCount, reorderCount);
                duplicateCount++;
            }
            else
                times.Add(timestamp, sample);
        }

        var rows = times.OrderBy(x => x.Key).ToArray();
        var slots = new HashSet<int>();
        foreach (var (time, value) in rows)
        {
            if (!string.Equals(value.Unit, policy.Unit, StringComparison.Ordinal))
                return Reject(PdmPointQualityStatus.UnitMismatch, "采样单位与确认点位单位不一致",
                    expected, slots.Count, duplicateCount, reorderCount);
            if (value.Value is not { } v || !double.IsFinite(v))
                return Reject(PdmPointQualityStatus.InvalidValue, "缺失、NaN 或 Infinity 值",
                    expected, slots.Count, duplicateCount, reorderCount);
            if (v < policy.MinValidValue || v > policy.MaxValidValue)
                return Reject(PdmPointQualityStatus.OutOfRange, "数值超出设备物理有效范围",
                    expected, slots.Count, duplicateCount, reorderCount);
            var slot = (int)((time - start).TotalSeconds / policy.ExpectedIntervalSeconds);
            if (slot >= 0 && slot < expected) slots.Add(slot);
        }

        var coverage = Math.Clamp(slots.Count / (double)expected, 0, 1);
        if (coverage < minimumCoverage)
            return Reject(PdmPointQualityStatus.Insufficient, "有效时间槽覆盖率不足",
                expected, slots.Count, duplicateCount, reorderCount, coverage);

        if ((end - rows[^1].Key).TotalSeconds > policy.ExpectedIntervalSeconds * 2.5)
            return Reject(PdmPointQualityStatus.Stale, "窗口最后一条样本过期",
                expected, slots.Count, duplicateCount, reorderCount, coverage);

        // 覆盖率满足最低标准仍需限制持续性长缺口（3 个以上连续空时间槽）。
        int longestGap = 0;
        int runningGap = 0;
        for (int i = 0; i < expected; i++)
        {
            runningGap = slots.Contains(i) ? 0 : runningGap + 1;
            longestGap = Math.Max(longestGap, runningGap);
        }
        if (longestGap > 3)
            return Reject(PdmPointQualityStatus.ExcessiveGap, "存在连续超过三个采样周期的数据空洞",
                expected, slots.Count, duplicateCount, reorderCount, coverage);

        var xs = rows.Select(r => (r.Key - start).TotalMinutes).ToArray();
        var ys = rows.Select(r => r.Value.Value!.Value).ToArray();
        var meanX = xs.Average();
        var meanY = ys.Average();
        var denominator = xs.Sum(x => (x - meanX) * (x - meanX));
        var slope = denominator > 0
            ? xs.Select((x, i) => (x - meanX) * (ys[i] - meanY)).Sum() / denominator
            : 0d;

        return new PdmPointQuality(policy.TelemetryKey, PdmPointQualityStatus.Good,
            expected, slots.Count, duplicateCount, reorderCount, coverage,
            ys[^1], slope, string.Empty)
        {
            SustainedRise = ys.Length >= 3 && ys[^3] < ys[^2] && ys[^2] < ys[^1]
        };

        PdmPointQuality Reject(PdmPointQualityStatus status, string reason,
            int count = 0, int observed = 0, int exactDuplicates = 0, int reordered = 0,
            double coverageRatio = 0) =>
            new(policy.TelemetryKey, status, count, observed, exactDuplicates,
                reordered, coverageRatio, null, null, reason);
    }
}

