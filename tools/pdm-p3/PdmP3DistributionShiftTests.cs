using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3DistributionShiftTests
{
    [Fact]
    public void PersistentMedianShiftCanBeFlaggedWithoutProbabilities()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope,
            1,1.1,1.2,1,1.1,1.2, 5,5.1,5.2,5,5.1,5.2);
        var finding = PdmP3DistributionShiftDetector.Evaluate(rows);
        Assert.Equal(PdmP3DistributionShiftState.ShiftDetected, finding.State);
        Assert.True(finding.ShiftScore >= 3);
        Assert.Equal(6, finding.BaselineSamples);
        Assert.Equal(6, finding.RecentSamples);
        Assert.True(finding.IsReadOnly);
    }

    [Fact]
    public void StableDistributionDoesNotClaimVerifiedHealth()
    {
        var scope = PdmP3Fixtures.Scope();
        var result = PdmP3DistributionShiftDetector.Evaluate(
            PdmP3Fixtures.Samples(scope,1,1.1,1.2,1,1.1,1.2,
                1.05,1.1,1.25,1,1.1,1.15));
        Assert.Equal(PdmP3DistributionShiftState.Stable, result.State);
        Assert.Contains("不代表", result.Explanation);
    }

    [Fact]
    public void InsufficientTwoWindowsOrMixedUnitCannotProduceEvidence()
    {
        var scope = PdmP3Fixtures.Scope();
        var incomplete = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1);
        Assert.Equal(PdmP3DistributionShiftState.Unknown,
            PdmP3DistributionShiftDetector.Evaluate(incomplete).State);
        var rows = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,5,5,5,5,5,5);
        rows[7] = rows[7] with { Scope = scope with { EngineeringUnit = "A" } };
        Assert.Equal(PdmP3DistributionShiftState.Unknown,
            PdmP3DistributionShiftDetector.Evaluate(rows).State);
    }

    [Fact]
    public void BadQualityOrInvalidThresholdAlwaysFailsClosed()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,5,5,5,5,5,5);
        rows[6] = rows[6] with { Quality = PdmP3SampleQuality.Unknown };
        Assert.Equal(PdmP3DistributionShiftState.Unknown,
            PdmP3DistributionShiftDetector.Evaluate(rows).State);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PdmP3DistributionShiftDetector.Evaluate(rows, threshold: double.NaN));
    }
}

