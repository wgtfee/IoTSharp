using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmMaintenanceAdvisorTests
{
    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
        Version = 3, Enabled = true, PointMappingsVerified = true, RunStateVerified = true
    };
    private static PdmRiskEvent Event(PdmDeviceProfile p, string risk = "Warning") => new()
    {
        TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
        ProfileId = p.Id, ProfileVersion = p.Version,
        RiskLevel = risk, Status = "Open", EvidenceJson = "{\"reasons\":[\"validated threshold\"]}"
    };

    [Theory]
    [InlineData(PdmMeasurementCategory.Temperature)]
    [InlineData(PdmMeasurementCategory.Vibration)]
    [InlineData(PdmMeasurementCategory.MotorCurrent)]
    [InlineData(PdmMeasurementCategory.Pressure)]
    public void VerifiedRisk_GeneratesHumanReviewDraftWithNoActuation(PdmMeasurementCategory category)
    {
        var p = Profile();
        var proposal = PdmMaintenanceAdvisor.Propose(p, Event(p), category, evidenceVerified: true);
        Assert.Equal(PdmAdviceState.ReadyForHumanReview, proposal.State);
        Assert.True(proposal.RequiresHumanApproval);
        Assert.False(proposal.IsWorkOrderIssued);
        Assert.Null(proposal.FailureProbability);
        Assert.Null(proposal.RemainingUsefulLife);
        Assert.True(proposal.SuggestedChecks.Count >= 3);
    }

    [Fact]
    public void UnverifiedSignalsOrEvidence_BlockMaintenanceProposal()
    {
        var p = Profile();
        var risk = Event(p);
        Assert.Equal(PdmAdviceState.NeedsDataVerification,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Unclassified, true).State);
        Assert.Equal(PdmAdviceState.NeedsDataVerification,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Temperature, false).State);
        p.RunStateVerified = false;
        Assert.Equal(PdmAdviceState.NeedsDataVerification,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Temperature, true).State);
    }

    [Fact]
    public void InvalidOrOversizedEvidence_CannotGenerateMaintenanceAdvice()
    {
        var p = Profile();
        var risk = Event(p);
        risk.EvidenceJson = "not valid JSON";
        Assert.Equal(PdmAdviceState.NeedsDataVerification,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Vibration, true).State);
        risk.EvidenceJson = new string('x', 65537);
        Assert.Equal(PdmAdviceState.NeedsDataVerification,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Vibration, true).State);
    }

    [Fact]
    public void ClearedEvent_CannotCreateNewMaintenanceWork()
    {
        var p = Profile();
        var risk = Event(p);
        risk.Status = "Cleared";
        Assert.Equal(PdmAdviceState.NotApplicable,
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Vibration, true).State);
    }

    [Fact]
    public void CrossTenantOrVersion_CannotMixWorkOrderContext()
    {
        var p = Profile();
        var risk = Event(p);
        risk.TenantId = Guid.NewGuid();
        Assert.Throws<InvalidOperationException>(() =>
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Temperature, true));
        risk.TenantId = p.TenantId;
        risk.ProfileVersion = p.Version + 1;
        Assert.Throws<InvalidOperationException>(() =>
            PdmMaintenanceAdvisor.Propose(p, risk, PdmMeasurementCategory.Temperature, true));
    }

    [Fact]
    public void CriticalRisk_PrioritizesHumanReviewNotAutomaticAction()
    {
        var p = Profile();
        var proposal = PdmMaintenanceAdvisor.Propose(p, Event(p, "Critical"),
            PdmMeasurementCategory.Temperature, true);
        Assert.Equal(PdmAdviceState.ReadyForHumanReview, proposal.State);
        Assert.Contains("严重风险", proposal.Title);
        Assert.False(proposal.IsWorkOrderIssued);
    }
}

