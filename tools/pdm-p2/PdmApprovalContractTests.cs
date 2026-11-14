using System;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmApprovalContractTests
{
    private static (PdmDeviceProfile Profile, PdmRiskEvent Episode, PdmP2AdvisoryBundle Bundle) Valid()
    {
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
            DeviceId = Guid.NewGuid(), Version = 3,
            Enabled = true, PointMappingsVerified = true, RunStateVerified = true
        };
        var now = DateTime.UtcNow;
        var e = new PdmRiskEvent
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId,
            DeviceId = p.DeviceId, ProfileId = p.Id, ProfileVersion = p.Version,
            RiskType = PdmRiskEventTransitions.HealthRiskType,
            RiskLevel = "Warning", Status = "Open",
            EventKey = "trusted-open-episode",
            LastEvaluatedWindowEndUtc = now,
            EvidenceJson = "{\"reasons\":[\"validated\"]}"
        };
        var trend = new PdmTrendFinding(PdmTrendDirection.Declining, 5,
            -9.5, -12, now, "连续有效下降");
        var alert = new PdmAlertDecision(PdmAlertDecisionKind.Notify,
            "待审核通知提案", new string('a', 64));
        var maintenance = new PdmMaintenanceDraft(
            PdmAdviceState.ReadyForHumanReview, e.Id, p.DeviceId,
            "检查振动异常", "需要人工现场确认",
            new[] { "检查振动探头", "核对设备运行状态" });
        return (p, e, new PdmP2AdvisoryBundle(trend, alert, maintenance));
    }

    [Fact]
    public void TrustedCandidate_IsStillOnlyAwaitingHumanReview()
    {
        var (p, e, bundle) = Valid();
        var packet = PdmApprovalContract.Prepare(p, e, bundle);
        Assert.Equal(PdmReviewPacketState.AwaitingHumanReview, packet.State);
        Assert.Equal(64, packet.Fingerprint.Length);
        Assert.True(packet.RequiresVerifiedReviewer);
        Assert.True(packet.RequiresAuditPersistence);
        Assert.False(packet.IsAuthorizedToExecute);
        Assert.False(packet.IsAlertDelivered);
        Assert.False(packet.IsWorkOrderCreated);
        Assert.Equal(p.TenantId, packet.TenantId);
    }

    [Fact]
    public void IdempotencyFingerprint_IsDeterministicWithinSameEpisode()
    {
        var (p, e, bundle) = Valid();
        var first = PdmApprovalContract.Prepare(p, e, bundle);
        var next = PdmApprovalContract.Prepare(p, e, bundle);
        Assert.Equal(first.Fingerprint, next.Fingerprint);
        e.Id = Guid.NewGuid();
        var changed = PdmApprovalContract.Prepare(p, e, bundle);
        Assert.NotEqual(first.Fingerprint, changed.Fingerprint);
    }

    [Fact]
    public void MixedTenantCustomerOrProfileVersion_FailsClosed()
    {
        var (p, e, bundle) = Valid();
        e.CustomerId = Guid.NewGuid();
        Assert.Throws<InvalidOperationException>(() => PdmApprovalContract.Prepare(p, e, bundle));
        e.CustomerId = p.CustomerId;
        e.ProfileVersion = p.Version - 1;
        Assert.Throws<InvalidOperationException>(() => PdmApprovalContract.Prepare(p, e, bundle));
    }

    [Fact]
    public void UnverifiedAdviceOrSuspendedAlert_BlocksReview()
    {
        var (p, e, bundle) = Valid();
        var unverified = bundle with
        {
            Maintenance = bundle.Maintenance with { State = PdmAdviceState.NeedsDataVerification }
        };
        Assert.Equal(PdmReviewPacketState.Blocked,
            PdmApprovalContract.Prepare(p, e, unverified).State);

        var held = bundle with
        {
            Alert = new PdmAlertDecision(PdmAlertDecisionKind.Held, "数据不足", null)
        };
        Assert.Equal(PdmReviewPacketState.Blocked,
            PdmApprovalContract.Prepare(p, e, held).State);
    }

    [Fact]
    public void ClosedRiskOrDisabledProfile_CannotProgress()
    {
        var (p, e, bundle) = Valid();
        e.Status = "Cleared";
        Assert.Equal(PdmReviewPacketState.Blocked,
            PdmApprovalContract.Prepare(p, e, bundle).State);
        e.Status = "Open";
        p.Enabled = false;
        Assert.Equal(PdmReviewPacketState.Blocked,
            PdmApprovalContract.Prepare(p, e, bundle).State);
    }

    [Fact]
    public void InvalidEvidenceOrUntrustedUtcWindow_BlocksReviewPacket()
    {
        var (p, e, bundle) = Valid();
        e.EvidenceJson = "not JSON";
        Assert.Equal(PdmReviewPacketState.Blocked, PdmApprovalContract.Prepare(p, e, bundle).State);
        e.EvidenceJson = "{}";
        Assert.Equal(PdmReviewPacketState.Blocked, PdmApprovalContract.Prepare(p, e, bundle).State);
        e.EvidenceJson = "{\"reasons\":[\"validated\"]}";
        e.LastEvaluatedWindowEndUtc = DateTime.SpecifyKind(
            e.LastEvaluatedWindowEndUtc, DateTimeKind.Unspecified);
        Assert.Equal(PdmReviewPacketState.Blocked, PdmApprovalContract.Prepare(p, e, bundle).State);
        e.LastEvaluatedWindowEndUtc = e.LastEvaluatedWindowEndUtc.AddMinutes(15);
        e.LastEvaluatedWindowEndUtc = DateTime.SpecifyKind(e.LastEvaluatedWindowEndUtc, DateTimeKind.Utc);
        Assert.Equal(PdmReviewPacketState.Blocked, PdmApprovalContract.Prepare(p, e, bundle).State);
    }

    [Fact]
    public void NonHashProposalCannotBecomeReviewable()
    {
        var (p, e, bundle) = Valid();
        var forged = bundle with
        {
            Alert = new PdmAlertDecision(PdmAlertDecisionKind.Notify, "new", "short-unsafe-key")
        };
        Assert.Equal(PdmReviewPacketState.Blocked, PdmApprovalContract.Prepare(p, e, forged).State);
    }
    [Fact]
    public void AbsentReviewerMeansThereIsNoApprovalExecutionMethod()
    {
        var actions = typeof(PdmApprovalContract).GetMethods(
            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
        Assert.Single(actions, a => a.Name == nameof(PdmApprovalContract.Prepare));
        Assert.All(actions, a => Assert.DoesNotContain(a.Name,
            new[] { "Approve", "Execute", "IssueWorkOrder", "SendAlert" }));
    }
}

