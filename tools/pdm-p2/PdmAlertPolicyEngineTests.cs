using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmAlertPolicyEngineTests
{
    private static readonly DateTimeOffset End = new(2026, 11, 13, 8, 15, 0, TimeSpan.Zero);
    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
        Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
        Version = 2
    };
    private static PdmRiskEvent Event(PdmDeviceProfile p, PdmRiskLevel level = PdmRiskLevel.Warning,
        int occurrences = 3) => new()
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
            ProfileId = p.Id, ProfileVersion = p.Version,
            EventKey = "p2-example-risk-episode", Status = "Open",
            RiskType = "device-health", RiskLevel = level.ToString(),
            LastEvaluatedWindowEndUtc = End.UtcDateTime, OccurrenceCount = occurrences
        };
    private static PdmHealthEvaluation Eval(PdmDeviceProfile p,
        PdmRiskLevel level = PdmRiskLevel.Warning, string quality = "Good") =>
        new(p.TenantId, p.CustomerId, p.DeviceId,
            End.AddMinutes(-15), End, quality,
            level == PdmRiskLevel.Unknown ? null : 52,
            level, 0.95, Array.Empty<PdmPointAssessment>(), Array.Empty<string>());

    [Fact]
    public void QualifyingWarning_ProposesOnly_NotSends()
    {
        var p = Profile();
        var d = PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(), null);
        Assert.Equal(PdmAlertDecisionKind.Notify, d.Kind);
        Assert.True(d.RequiresNotificationProposal);
        Assert.Equal(64, d.IdempotencyKey!.Length);
    }

    [Fact]
    public void SameEpisodeAndWindow_HaveStableIdempotencyKey()
    {
        var p = Profile();
        var first = PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(), null);
        var again = PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(), null);
        Assert.Equal(first.IdempotencyKey, again.IdempotencyKey);
    }

    [Fact]
    public void CooldownSuppressesSameLevelButEscalationCanPropose()
    {
        var p = Profile();
        var recent = End.AddMinutes(-5);
        var same = PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(), recent, PdmRiskLevel.Warning);
        Assert.Equal(PdmAlertDecisionKind.Suppressed, same.Kind);
        var critical = PdmAlertPolicyEngine.Decide(p, Event(p, PdmRiskLevel.Critical),
            Eval(p, PdmRiskLevel.Critical), new(), recent, PdmRiskLevel.Warning);
        Assert.Equal(PdmAlertDecisionKind.Escalate, critical.Kind);
    }

    [Fact]
    public void RepeatedWindowOrFutureNotification_CannotNotify()
    {
        var p = Profile();
        Assert.Equal(PdmAlertDecisionKind.Suppressed,
            PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(), End, PdmRiskLevel.Warning).Kind);
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p), new(),
                End.AddMinutes(5), PdmRiskLevel.Warning).Kind);
    }

    [Fact]
    public void UnknownQualityAndMissingEvidence_FailClosed()
    {
        var p = Profile();
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, Event(p, PdmRiskLevel.Unknown),
                Eval(p, PdmRiskLevel.Unknown), new(), null).Kind);
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p, quality: "Partial"), new(), null).Kind);
    }

    [Fact]
    public void CrossTenantAndProfileVersion_AreRejected()
    {
        var p = Profile();
        var risk = Event(p);
        risk.CustomerId = Guid.NewGuid();
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, risk, Eval(p), new(), null).Kind);
        risk.CustomerId = p.CustomerId;
        risk.ProfileVersion--;
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, risk, Eval(p), new(), null).Kind);
    }

    [Fact]
    public void UnknownPreviousAlertSeverity_CannotBypassCooldown()
    {
        var p = Profile();
        var decision = PdmAlertPolicyEngine.Decide(
            p, Event(p), Eval(p), new(), End.AddMinutes(-2));
        Assert.Equal(PdmAlertDecisionKind.Held, decision.Kind);
        Assert.False(decision.RequiresNotificationProposal);
    }

    [Fact]
    public void TooFewOccurrencesOrInvalidPolicy_CannotNotify()
    {
        var p = Profile();
        Assert.Equal(PdmAlertDecisionKind.BelowThreshold,
            PdmAlertPolicyEngine.Decide(p, Event(p, occurrences: 1), Eval(p), new(), null).Kind);
        Assert.Equal(PdmAlertDecisionKind.Held,
            PdmAlertPolicyEngine.Decide(p, Event(p), Eval(p),
                new PdmAlertPolicy(CooldownMinutes: -1), null).Kind);
    }
}

