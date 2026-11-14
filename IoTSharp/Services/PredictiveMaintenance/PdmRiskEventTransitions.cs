using System;
using System.Security.Cryptography;
using System.Text;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance;

public enum PdmRiskTransitionKind
{
    NoChange,
    Opened,
    Updated,
    RecoveryPending,
    Cleared,
    IgnoredDuplicate,
    HeldForUnknown
}

public static class PdmRiskEventTransitions
{
    public const string HealthRiskType = "device-health";

    /// <summary>
    /// 按唯一评估窗口推进一段风险 Episode。
    /// 调用者必须在数据库事务中先筛出该设备/配置作用域的 Open 事件，并保存更新。
    /// Unknown/停机不自动解除已存在的风险。
    /// </summary>
    public static PdmRiskTransitionKind Apply(
        PdmRiskEvent? active, PdmHealthEvaluation evaluation,
        PdmDeviceProfile profile, int consecutiveRecoveryWindows,
        out PdmRiskEvent? changed)
    {
        ArgumentNullException.ThrowIfNull(evaluation);
        ArgumentNullException.ThrowIfNull(profile);
        if (consecutiveRecoveryWindows is < 1 or > 100)
            throw new ArgumentOutOfRangeException(nameof(consecutiveRecoveryWindows));
        if (evaluation.TenantId != profile.TenantId ||
            evaluation.CustomerId != profile.CustomerId ||
            evaluation.DeviceId != profile.DeviceId)
            throw new InvalidOperationException("PdM risk event profile scope mismatch.");
        if (evaluation.WindowEnd <= evaluation.WindowStart)
            throw new InvalidOperationException("PdM health evaluation window is invalid.");
        if (active != null &&
            (active.TenantId != profile.TenantId ||
             active.CustomerId != profile.CustomerId ||
             active.DeviceId != profile.DeviceId ||
             active.ProfileId != profile.Id ||
             active.ProfileVersion != profile.Version ||
             active.RiskType != HealthRiskType || active.Status != "Open"))
            throw new InvalidOperationException("Risk event from different scope or episode.");
        changed = active;

        var end = evaluation.WindowEnd.UtcDateTime;
        if (active != null && active.LastEvaluatedWindowEndUtc >= end)
            return PdmRiskTransitionKind.IgnoredDuplicate;
        if (evaluation.Risk == PdmRiskLevel.Unknown || evaluation.HealthIndex == null
            || evaluation.DataQuality is not ("Good" or "Partial"))
            return PdmRiskTransitionKind.HeldForUnknown;

        if (evaluation.Risk == PdmRiskLevel.Normal)
        {
            if (active == null) return PdmRiskTransitionKind.NoChange;
            active.RecoveryStreak = active.LastEvaluatedWindowEndUtc == evaluation.WindowStart.UtcDateTime
                ? checked(active.RecoveryStreak + 1)
                : 1;
            active.LastEvaluatedWindowEndUtc = end;
            if (active.RecoveryStreak < consecutiveRecoveryWindows)
                return PdmRiskTransitionKind.RecoveryPending;
            active.Status = "Cleared";
            active.ClearedAtUtc = end;
            return PdmRiskTransitionKind.Cleared;
        }

        if (active == null)
        {
            var key = EventKey(profile, evaluation.WindowStart.UtcDateTime);
            changed = new PdmRiskEvent
            {
                TenantId = profile.TenantId,
                CustomerId = profile.CustomerId,
                DeviceId = profile.DeviceId,
                ProfileId = profile.Id,
                ProfileVersion = profile.Version,
                EventKey = key,
                RiskType = HealthRiskType,
                RiskLevel = evaluation.Risk.ToString(),
                Status = "Open",
                FirstObservedUtc = end,
                LastObservedUtc = end,
                LastEvaluatedWindowEndUtc = end,
                OccurrenceCount = 1,
                RecoveryStreak = 0,
                EvidenceJson = evaluation.ToSnapshot(profile).ExplanationJson
            };
            return PdmRiskTransitionKind.Opened;
        }

        active.OccurrenceCount = checked(active.OccurrenceCount + 1);
        active.LastObservedUtc = end;
        active.LastEvaluatedWindowEndUtc = end;
        active.RecoveryStreak = 0;
        active.RiskLevel = evaluation.Risk.ToString();
        active.EvidenceJson = evaluation.ToSnapshot(profile).ExplanationJson;
        return PdmRiskTransitionKind.Updated;
    }

    public static string EventKey(PdmDeviceProfile profile, DateTime episodeStartUtc)
    {
        ArgumentNullException.ThrowIfNull(profile);
        if (episodeStartUtc.Kind != DateTimeKind.Utc)
            throw new ArgumentException("Risk episode start must be UTC.", nameof(episodeStartUtc));
        var dimensions = string.Join("|", "pdm-risk-v1",
            profile.TenantId.ToString("N"), profile.CustomerId.ToString("N"),
            profile.DeviceId.ToString("N"), profile.Id.ToString("N"),
            profile.Version.ToString(System.Globalization.CultureInfo.InvariantCulture),
            HealthRiskType, episodeStartUtc.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dimensions))).ToLowerInvariant();
    }
}

