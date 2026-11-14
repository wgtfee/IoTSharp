using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3ShadowCoordinatorTests
{
    private static readonly double[] Values = { 1,1.1,1.2,1,1.1,1.2,1,1.1,6 };

    [Fact]
    public void ExplicitDisabledGateNeverPerformsAnomalyEvaluation()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        var p2 = PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime);
        var report = PdmP3ShadowCoordinator.Evaluate(
            PdmP3Fixtures.Profile(scope), p2, rows, featureGateApproved: false);
        Assert.Equal(PdmP3ShadowState.Disabled, report.State);
        Assert.Null(report.Finding.RobustDeviationScore);
        Assert.False(report.IsWorkOrderCreated);
        Assert.False(report.IsAlertDelivered);
    }

    [Fact]
    public void VerifiedCurrentP2WindowCanShowOnlyShadowStatisticalEvidence()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        var report = PdmP3ShadowCoordinator.Evaluate(
            PdmP3Fixtures.Profile(scope),
            PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime),
            rows, true);
        Assert.Equal(PdmP3ShadowState.ExplainableBaseline, report.State);
        Assert.Equal(PdmP3AnomalyState.Anomalous, report.Finding.State);
        Assert.True(report.IsReadOnly);
        Assert.False(report.IsAlertDelivered);
        Assert.False(report.IsWorkOrderCreated);
        Assert.Null(report.FailureProbability);
        Assert.Null(report.RemainingUsefulLife);
    }

    [Fact]
    public void CrossTenantOrDifferentProfileVersionIsNeverLinkedToP2()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        var p2 = PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime);
        var profile = PdmP3Fixtures.Profile(scope);
        profile.Version++;
        Assert.Equal(PdmP3ShadowState.Unverified,
            PdmP3ShadowCoordinator.Evaluate(profile,p2,rows,true).State);
        profile.Version--;
        profile.TenantId = Guid.NewGuid();
        Assert.Equal(PdmP3ShadowState.Unverified,
            PdmP3ShadowCoordinator.Evaluate(profile,p2,rows,true).State);
    }

    [Fact]
    public void StaleP2WindowOrUnknownP2TrendMustHold()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        var p2 = PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime.AddMinutes(15));
        Assert.Equal(PdmP3ShadowState.Unverified,
            PdmP3ShadowCoordinator.Evaluate(
                PdmP3Fixtures.Profile(scope),p2,rows,true).State);

        p2 = PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime) with
        {
            Trend = new PdmTrendFinding(PdmTrendDirection.Unknown,0,
                null,null,null,"No trustworthy P1 history")
        };
        Assert.Equal(PdmP3ShadowState.Unverified,
            PdmP3ShadowCoordinator.Evaluate(
                PdmP3Fixtures.Profile(scope),p2,rows,true).State);
    }

    [Fact]
    public void DataQualityFailuresCannotBecomeActionableShadowFindings()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        rows[3] = rows[3] with { Quality = PdmP3SampleQuality.Bad };
        var p2 = PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime);
        var result = PdmP3ShadowCoordinator.Evaluate(
            PdmP3Fixtures.Profile(scope),p2,rows,true);
        Assert.Equal(PdmP3ShadowState.Unverified, result.State);
        Assert.Null(result.Finding.RobustDeviationScore);
        Assert.False(result.IsWorkOrderCreated);
    }

    [Fact]
    public void UnverifiedOperatingProfileBlocksShadow()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, Values);
        var profile = PdmP3Fixtures.Profile(scope);
        profile.RunStateVerified = false;
        Assert.Equal(PdmP3ShadowState.Unverified,
            PdmP3ShadowCoordinator.Evaluate(profile,
                PdmP3Fixtures.P2At(rows[^1].EventTimeUtc.UtcDateTime),
                rows,true).State);
    }
}

