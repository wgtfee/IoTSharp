using System;
using System.Security.Cryptography;
using System.Text;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmAlertDecisionKind { Held, BelowThreshold, Suppressed, Notify, Escalate }

/// <summary>Explicit, locally evaluated notification policy. This does not send notifications.</summary>
public sealed record PdmAlertPolicy(
    PdmRiskLevel MinimumRisk = PdmRiskLevel.Warning,
    int MinimumOccurrences = 2,
    int CooldownMinutes = 30,
    bool RequireGoodQuality = true);

public sealed record PdmAlertDecision(
    PdmAlertDecisionKind Kind, string Reason, string? IdempotencyKey)
{
    public bool RequiresNotificationProposal =>
        Kind is PdmAlertDecisionKind.Notify or PdmAlertDecisionKind.Escalate;
}

/// <summary>
/// Pure P2 decision engine. Never writes alarms, emails, events or PLC/MES.
/// </summary>
public static class PdmAlertPolicyEngine
{
    public static PdmAlertDecision Decide(
        PdmDeviceProfile profile, PdmRiskEvent episode, PdmHealthEvaluation evaluation,
        PdmAlertPolicy policy, DateTimeOffset? lastNotifiedUtc,
        PdmRiskLevel lastNotifiedLevel = PdmRiskLevel.Unknown)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(episode);
        ArgumentNullException.ThrowIfNull(evaluation);
        ArgumentNullException.ThrowIfNull(policy);

        PdmAlertDecision Hold(string why) => new(PdmAlertDecisionKind.Held, why, null);
        if (profile.Id == Guid.Empty || profile.TenantId == Guid.Empty ||
            profile.CustomerId == Guid.Empty || profile.DeviceId == Guid.Empty ||
            !profile.Enabled || !profile.PointMappingsVerified || !profile.RunStateVerified)
            return Hold("设备身份或现场映射未完成核验");
        if (policy.MinimumRisk is < PdmRiskLevel.Attention or > PdmRiskLevel.Critical ||
            policy.MinimumOccurrences is < 1 or > 100 ||
            policy.CooldownMinutes is < 0 or > 10080)
            return Hold("预警策略参数无效");
        if (episode.TenantId != profile.TenantId ||
            episode.CustomerId != profile.CustomerId ||
            episode.DeviceId != profile.DeviceId ||
            episode.ProfileId != profile.Id ||
            episode.ProfileVersion != profile.Version ||
            episode.Status != "Open" ||
            string.IsNullOrWhiteSpace(episode.EventKey))
            return Hold("风险片段状态、版本或作用域不可用");
        if (evaluation.TenantId != profile.TenantId ||
            evaluation.CustomerId != profile.CustomerId ||
            evaluation.DeviceId != profile.DeviceId ||
            evaluation.WindowEnd.Offset != TimeSpan.Zero ||
            evaluation.WindowEnd <= evaluation.WindowStart ||
            evaluation.WindowEnd.UtcDateTime != episode.LastEvaluatedWindowEndUtc)
            return Hold("评估窗口或租户身份不匹配");

        if (evaluation.Risk is PdmRiskLevel.Normal or PdmRiskLevel.Unknown ||
            evaluation.HealthIndex is null ||
            !double.IsFinite(evaluation.HealthIndex.Value) ||
            evaluation.HealthIndex.Value is < 0 or > 100 ||
            (policy.RequireGoodQuality ? evaluation.DataQuality != "Good"
                : evaluation.DataQuality is not ("Good" or "Partial")))
            return Hold("无可靠风险评分或数据质量不足");
        if (evaluation.Risk < policy.MinimumRisk ||
            episode.OccurrenceCount < policy.MinimumOccurrences)
            return new(PdmAlertDecisionKind.BelowThreshold, "尚未达到预警阈值或持续次数", null);
        if (!string.Equals(episode.RiskLevel, evaluation.Risk.ToString(), StringComparison.Ordinal))
            return Hold("事件与当前评估风险等级不一致");

        if (lastNotifiedUtc.HasValue &&
            (lastNotifiedUtc.Value.Offset != TimeSpan.Zero ||
             lastNotifiedUtc.Value > evaluation.WindowEnd))
            return Hold("上一次通知时间不可被信任");
        if (lastNotifiedUtc.HasValue &&
            lastNotifiedUtc.Value >= evaluation.WindowEnd)
            return new(PdmAlertDecisionKind.Suppressed, "重复评估窗口不得重复通知", null);

        // Never bypass cooldown when the last notified severity is not known.
        if (lastNotifiedUtc.HasValue && (lastNotifiedLevel is < PdmRiskLevel.Attention or > PdmRiskLevel.Critical))
            return Hold("历史通知级别未知，禁止未经核验的升级绕过冷却期");
        var escalate = lastNotifiedUtc.HasValue && evaluation.Risk > lastNotifiedLevel;
        if (lastNotifiedUtc.HasValue && !escalate &&
            evaluation.WindowEnd - lastNotifiedUtc.Value < TimeSpan.FromMinutes(policy.CooldownMinutes))
            return new(PdmAlertDecisionKind.Suppressed, "同级风险处于通知冷却期", null);

        var dimensions = string.Join("|", "pdm-p2-proposal-v1",
            profile.TenantId.ToString("N"), profile.CustomerId.ToString("N"),
            profile.DeviceId.ToString("N"), profile.Version,
            episode.EventKey, evaluation.Risk, evaluation.WindowEnd.ToUnixTimeMilliseconds());
        var key = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(dimensions))).ToLowerInvariant();
        return new(escalate ? PdmAlertDecisionKind.Escalate : PdmAlertDecisionKind.Notify,
            escalate ? "已验证风险升级，建议优先人工确认" : "满足预警条件，生成待审核通知提案", key);
    }
}

