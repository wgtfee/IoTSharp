using System;
using System.Collections.Generic;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>P2 planning result only. No notification, work-order or equipment commands are executed.</summary>
public sealed record PdmP2AdvisoryBundle(
    PdmTrendFinding Trend,
    PdmAlertDecision Alert,
    PdmMaintenanceDraft Maintenance,
    bool IsReadOnly = true);

/// <summary>
/// Side-effect-free integration of three parallel P2 components. Only same-window,
/// trusted P1 evidence can produce proposals; an incomplete trend blocks both paths.
/// </summary>
public static class PdmP2ShadowOrchestrator
{
    public static PdmP2AdvisoryBundle Evaluate(
        PdmDeviceProfile profile,
        IReadOnlyList<PdmHealthSnapshot> consecutiveSnapshots,
        PdmRiskEvent activeEpisode,
        PdmHealthEvaluation currentEvaluation,
        PdmAlertPolicy alertPolicy,
        PdmMeasurementCategory verifiedMeasurementCategory,
        bool evidenceVerified,
        DateTimeOffset? lastNotifiedUtc = null,
        PdmRiskLevel lastNotifiedLevel = PdmRiskLevel.Unknown)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(consecutiveSnapshots);
        ArgumentNullException.ThrowIfNull(activeEpisode);
        ArgumentNullException.ThrowIfNull(currentEvaluation);
        ArgumentNullException.ThrowIfNull(alertPolicy);

        var trend = PdmTrendDetector.Analyze(profile, consecutiveSnapshots);
        if (trend.Direction == PdmTrendDirection.Unknown ||
            trend.WindowEndUtc != currentEvaluation.WindowEnd.UtcDateTime)
        {
            var reason = "P2 健康趋势未核验或与当前风险窗口不一致，暂停预警/维护提案";
            return new PdmP2AdvisoryBundle(trend,
                new PdmAlertDecision(PdmAlertDecisionKind.Held, reason, null),
                new PdmMaintenanceDraft(PdmAdviceState.NeedsDataVerification, activeEpisode.Id,
                    profile.DeviceId, "需要现场确认", reason,
                    new[] { "核对连续 P1 健康快照与现场数据质量" }));
        }
        var alert = PdmAlertPolicyEngine.Decide(profile, activeEpisode,
            currentEvaluation, alertPolicy, lastNotifiedUtc, lastNotifiedLevel);
        var advice = PdmMaintenanceAdvisor.Propose(profile, activeEpisode,
            verifiedMeasurementCategory, evidenceVerified);
        return new(trend, alert, advice);
    }
}

