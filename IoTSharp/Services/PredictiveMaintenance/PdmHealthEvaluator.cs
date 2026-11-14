using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance;

public enum PdmRiskLevel
{
    Unknown = 0,
    Normal = 1,
    Attention = 2,
    Warning = 3,
    Critical = 4
}

public sealed record PdmPointAssessment(
    string TelemetryKey,
    PdmPointQuality Quality,
    double? RuleHealthIndex,
    PdmRiskLevel Risk,
    string Explanation);

/// <summary>
/// 一个固定窗口的规则级指标；HealthIndex 并非故障概率，RUL 在 P1 中始终未知。
/// </summary>
public sealed record PdmHealthEvaluation(
    Guid TenantId,
    Guid CustomerId,
    Guid DeviceId,
    DateTimeOffset WindowStart,
    DateTimeOffset WindowEnd,
    string DataQuality,
    double? HealthIndex,
    PdmRiskLevel Risk,
    double CoverageRatio,
    IReadOnlyList<PdmPointAssessment> Points,
    IReadOnlyList<string> Reasons)
{
    public double? FailureProbability => null;
    public TimeSpan? RemainingUsefulLife => null;

    public PdmHealthSnapshot ToSnapshot(PdmDeviceProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        if (profile.TenantId != TenantId || profile.CustomerId != CustomerId || profile.DeviceId != DeviceId)
            throw new InvalidOperationException("Evaluation and profile scopes differ.");
        return new PdmHealthSnapshot
        {
            TenantId = TenantId,
            CustomerId = CustomerId,
            DeviceId = DeviceId,
            ProfileId = profile.Id,
            ProfileVersion = profile.Version,
            WindowStartUtc = WindowStart.UtcDateTime,
            WindowEndUtc = WindowEnd.UtcDateTime,
            DataQuality = DataQuality,
            RiskLevel = Risk.ToString(),
            HealthIndex = HealthIndex,
            CoverageRatio = CoverageRatio,
            EvaluatedPointCount = Points.Count,
            FailedPointCount = Points.Count(p => !p.Quality.IsUsable),
            ExplanationJson = JsonSerializer.Serialize(new
            {
                reasons = Reasons,
                points = Points.Select(p => new
                {
                    key = p.TelemetryKey,
                    quality = p.Quality.Status.ToString(),
                    coverage = p.Quality.CoverageRatio,
                    risk = p.Risk.ToString(),
                    explanation = p.Explanation
                })
            })
        };
    }
}

/// <summary>
/// 无状态、无数据库写入、无设备控制的健康规则评估器。
/// 可在后续专用后台 Worker 用受控的历史查询调用，不得插入同步采集热路径。
/// </summary>
public sealed class PdmHealthEvaluator
{
    public const int MaxSamplesPerEvaluation = 100_000;

    public PdmHealthEvaluation Evaluate(
        PdmDeviceProfile profile,
        IReadOnlyList<PdmPointPolicy> policies,
        IReadOnlyList<PdmTelemetrySample> samples,
        DateTimeOffset windowEnd,
        PdmOperatingState operatingState)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(policies);
        ArgumentNullException.ThrowIfNull(samples);

        if (profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty || profile.DeviceId == Guid.Empty)
            throw new ArgumentException("PdmDeviceProfile requires nonempty TenantId/CustomerId/DeviceId.");
        if (profile.WindowMinutes is <= 0 or > 1440)
            throw new ArgumentException("PdmDeviceProfile window must be 1..1440 minutes.");

        var end = windowEnd.ToUniversalTime();
        var begin = end.AddMinutes(-profile.WindowMinutes);

        PdmHealthEvaluation NotAvailable(string reason) =>
            new(profile.TenantId, profile.CustomerId, profile.DeviceId, begin, end,
                "Unknown", null, PdmRiskLevel.Unknown, 0, Array.Empty<PdmPointAssessment>(), new[] { reason });

        if (!profile.Enabled)
            return NotAvailable("设备健康配置尚未启用");
        if (!double.IsFinite(profile.MinimumCoverageRatio)
            || profile.MinimumCoverageRatio is < 0 or > 1)
            return NotAvailable("最低时间窗口覆盖率配置无效");
        if (samples.Count > MaxSamplesPerEvaluation)
            return NotAvailable("输入样本数超过离线计算上限");
        var enabled = policies.Where(p => p.Enabled).ToArray();
        if (enabled.Length == 0)
            return NotAvailable("没有启用且经过现场确认的点位策略");
        if (enabled.All(p => !p.Required))
            return NotAvailable("至少需要一个现场确认的必需点位");
        if (enabled.Any(p => p.ProfileId != profile.Id || string.IsNullOrWhiteSpace(p.TelemetryKey))
            || enabled.GroupBy(p => p.TelemetryKey, StringComparer.Ordinal).Any(g => g.Count() > 1))
            return NotAvailable("点位配置不属于此设备或存在重复 Key");

        // 输入批次的身份不是由客户端声称的 DeviceId 决定，必须与可信设备配置一致。
        // 发现任何混入别的租户/设备的数据就拒绝整个评估，避免污染评分。
        if (samples.Any(s => s is null || string.IsNullOrWhiteSpace(s.Key) || s.Unit is null))
            return NotAvailable("输入样本字段缺失或不合法");
        if (samples.Any(s => s.TenantId != profile.TenantId
            || s.CustomerId != profile.CustomerId || s.DeviceId != profile.DeviceId))
            return NotAvailable("输入批次混入了不同租户、客户或设备的数据");

        var groups = samples.GroupBy(s => s.Key, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<PdmTelemetrySample>)g.ToArray(), StringComparer.Ordinal);
        var assessments = new List<PdmPointAssessment>(enabled.Length);
        foreach (var policy in enabled)
        {
            groups.TryGetValue(policy.TelemetryKey, out var rows);
            var quality = PdmQualityAnalyzer.Analyze(policy,
                profile.WindowMinutes, profile.MinimumCoverageRatio,
                end, operatingState, rows ?? Array.Empty<PdmTelemetrySample>());
            if (!quality.IsUsable)
            {
                assessments.Add(new PdmPointAssessment(policy.TelemetryKey,
                    quality, null, PdmRiskLevel.Unknown, quality.Reason));
                continue;
            }

            if (!double.IsFinite(policy.Weight) || policy.Weight <= 0
                || !double.IsFinite(policy.WarningHighValue) || !double.IsFinite(policy.CriticalHighValue)
                || policy.WarningHighValue <= policy.MinValidValue
                || policy.CriticalHighValue <= policy.WarningHighValue
                || policy.CriticalHighValue > policy.MaxValidValue
                || (policy.RisingTrendPerMinute.HasValue
                    && (!double.IsFinite(policy.RisingTrendPerMinute.Value)
                        || policy.RisingTrendPerMinute.Value <= 0)))
            {
                var invalid = quality with
                {
                    Status = PdmPointQualityStatus.PolicyInvalid,
                    LatestValue = null,
                    SlopePerMinute = null,
                    Reason = "健康指标权重、报警界限或趋势阈值配置无效"
                };
                assessments.Add(new PdmPointAssessment(policy.TelemetryKey,
                    invalid, null, PdmRiskLevel.Unknown, invalid.Reason));
                continue;
            }

            var latest = quality.LatestValue!.Value;
            var rising = policy.RisingTrendPerMinute.HasValue
                && quality.SustainedRise
                && quality.SlopePerMinute >= policy.RisingTrendPerMinute.Value;
            PdmRiskLevel risk;
            double index;
            string message;
            if (latest >= policy.CriticalHighValue)
            {
                risk = PdmRiskLevel.Critical;
                index = 10;
                message = "最近值达到已配置的严重上限";
            }
            else if (latest >= policy.WarningHighValue)
            {
                risk = PdmRiskLevel.Warning;
                var ratio = (latest - policy.WarningHighValue)
                    / (policy.CriticalHighValue - policy.WarningHighValue);
                index = 60 - ratio * 40;
                message = "最近值达到已配置的预警上限";
            }
            else if (rising)
            {
                risk = PdmRiskLevel.Attention;
                index = 75;
                message = "持续上升且趋势斜率超过已配置阈值";
            }
            else
            {
                risk = PdmRiskLevel.Normal;
                index = 100;
                message = string.Empty;
            }

            assessments.Add(new PdmPointAssessment(policy.TelemetryKey,
                quality, Math.Clamp(index, 0, 100), risk, message));
        }

        var missingRequired = assessments.Where(a =>
            enabled.First(p => p.TelemetryKey == a.TelemetryKey).Required
            && !a.Quality.IsUsable).ToList();
        var usable = assessments.Where(a => a.Quality.IsUsable && a.RuleHealthIndex.HasValue).ToArray();
        var reasons = assessments.Where(p => p.Explanation.Length > 0)
            .Select(p => p.TelemetryKey + ": " + p.Explanation).ToArray();
        var weightedCoverage = enabled.Where(p => p.Required).ToArray();
        var coverage = weightedCoverage.Length == 0 ? 0
            : weightedCoverage.Average(p => assessments
                .First(a => a.TelemetryKey == p.TelemetryKey).Quality.CoverageRatio);

        if (missingRequired.Count > 0 || usable.Length == 0)
            return new PdmHealthEvaluation(profile.TenantId, profile.CustomerId, profile.DeviceId,
                begin, end, "Unknown", null, PdmRiskLevel.Unknown,
                coverage, assessments, reasons.Length > 0 ? reasons : new[] { "缺少可信必要点位" });

        var totalWeight = usable.Sum(a => enabled.First(p => p.TelemetryKey == a.TelemetryKey).Weight);
        var healthIndex = usable.Sum(a => a.RuleHealthIndex!.Value *
            enabled.First(p => p.TelemetryKey == a.TelemetryKey).Weight) / totalWeight;
        var overallRisk = usable.Max(a => a.Risk);
        var qualityLabel = assessments.All(a => a.Quality.IsUsable) ? "Good" : "Partial";

        return new PdmHealthEvaluation(profile.TenantId, profile.CustomerId, profile.DeviceId,
            begin, end, qualityLabel, Math.Round(healthIndex, 1), overallRisk, coverage,
            assessments, reasons);
    }
}

