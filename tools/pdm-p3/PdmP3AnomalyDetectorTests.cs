using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3AnomalyDetectorTests
{
    [Fact]
    public void StrongOutlierIsExplainableAnomalyButNeverFailureProbability()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1,1.1,1.2,1,1.1,1.2,1,1.1,7.5);
        var result = PdmP3AnomalyDetector.Evaluate(rows);
        Assert.Equal(PdmP3AnomalyState.Anomalous, result.State);
        Assert.True(result.RobustDeviationScore > 3.5);
        Assert.Equal(8, result.BaselineRows);
        Assert.Null(result.FailureProbability);
        Assert.Null(result.RemainingUsefulLife);
        Assert.Contains("统计异常", result.Explanation);
    }

    [Fact]
    public void StableSeriesDoesNotClaimGuaranteedNoFault()
    {
        var scope = PdmP3Fixtures.Scope();
        var finding = PdmP3AnomalyDetector.Evaluate(
            PdmP3Fixtures.Samples(scope,1,1.1,1.2,1.1,1,1.2,1,1.1,1.15));
        Assert.Equal(PdmP3AnomalyState.Normal, finding.State);
        Assert.Contains("不代表确认无故障", finding.Explanation);
    }

    [Fact]
    public void ColdStartInsufficientBaselinesFailClosed()
    {
        var finding = PdmP3AnomalyDetector.Evaluate(
            PdmP3Fixtures.Samples(PdmP3Fixtures.Scope(),1,2,3,4,5));
        Assert.Equal(PdmP3AnomalyState.Unknown, finding.State);
        Assert.Null(finding.RobustDeviationScore);
    }

    [Fact]
    public void CandidateNeverLeaksIntoItsOwnBaseline()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1,1,1,1,1,1,1,1,8);
        var detection = PdmP3AnomalyDetector.Evaluate(rows);
        Assert.Equal(1, detection.BaselineMedian);
        Assert.Equal(0, detection.BaselineMad);
        Assert.Equal(PdmP3AnomalyState.Anomalous, detection.State);
    }

    [Fact]
    public void MixedScopeBadQualityOrGapsBlockFinding()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,7);
        rows[6] = rows[6] with { Scope = scope with { DeviceId = Guid.NewGuid() } };
        Assert.Equal(PdmP3AnomalyState.Unknown, PdmP3AnomalyDetector.Evaluate(rows).State);
        rows = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,7);
        rows[4] = rows[4] with { Quality = PdmP3SampleQuality.Unknown };
        Assert.Equal(PdmP3AnomalyState.Unknown, PdmP3AnomalyDetector.Evaluate(rows).State);
        rows = PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,7);
        rows[3] = rows[3] with { EventTimeUtc = rows[2].EventTimeUtc.AddHours(4) };
        Assert.Equal(PdmP3AnomalyState.Unknown, PdmP3AnomalyDetector.Evaluate(rows).State);
    }

    [Fact]
    public void ExcessiveSeriesSizeAndInvalidThresholdAreRejected()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = Enumerable.Range(0,4097).Select(i =>
            new PdmP3Observation(scope, PdmP3Fixtures.Start.AddMinutes(i),1,
                PdmP3SampleQuality.Good,"bounded")).ToList();
        Assert.Equal(PdmP3AnomalyState.Unknown, PdmP3AnomalyDetector.Evaluate(rows).State);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PdmP3AnomalyDetector.Evaluate(
                PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,3),threshold: double.NaN));
    }
}

