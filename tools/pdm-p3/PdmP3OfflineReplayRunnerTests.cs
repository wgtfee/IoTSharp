using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3OfflineReplayRunnerTests
{
    [Fact]
    public void CandidatePredictionsUseOnlyPrecedingBaselines_NotFutureOrLabels()
    {
        var scope = PdmP3Fixtures.Scope();
        var samples = PdmP3Fixtures.Samples(scope, 1,1,1,1,1,1,1,1,8,1,1);
        var run = PdmP3OfflineReplayRunner.Run(samples,
            Array.Empty<PdmP3FaultLabel>(), 8, PdmP3Fixtures.Start.AddHours(4));
        Assert.Equal(8, run.TrainingRows);
        Assert.Equal(3, run.HoldoutRows);
        Assert.Equal(3, run.Predictions.Count);
        Assert.Equal(PdmP3AnomalyState.Anomalous, run.Predictions[0].State);
        Assert.Equal(1, run.Predictions[0].BaselineMedian);
        Assert.Equal(PdmP3AnomalyState.Normal, run.Predictions[2].State);
        Assert.False(run.UsedFutureLabelsForDetection);
        Assert.False(run.IsProductionModel);
        Assert.Null(run.Metrics.Precision);
        Assert.Null(run.Metrics.Recall);
    }

    [Fact]
    public void HumanConfirmedLabelsOnlyAffectMetricsNotPredictions()
    {
        var scope = PdmP3Fixtures.Scope();
        var samples = PdmP3Fixtures.Samples(scope, 1,1,1,1,1,1,1,1,8,1);
        var asOf = PdmP3Fixtures.Start.AddHours(3);
        var noLabel = PdmP3OfflineReplayRunner.Run(samples,
            Array.Empty<PdmP3FaultLabel>(),8,asOf);
        var labels = new[]
        {
            PdmP3Fixtures.Label(scope,samples[8].EventTimeUtc,
                PdmP3FaultTruth.ConfirmedFault,asOf.AddMinutes(-1)),
            PdmP3Fixtures.Label(scope,samples[9].EventTimeUtc,
                PdmP3FaultTruth.ConfirmedNormal,asOf.AddMinutes(-1))
        };
        var labeled = PdmP3OfflineReplayRunner.Run(samples,labels,8,asOf);
        Assert.Equal(noLabel.Predictions,labeled.Predictions);
        Assert.Equal(noLabel.InputSha256,labeled.InputSha256);
        Assert.True(labeled.Metrics.HasTrustedGroundTruth);
        Assert.Equal(2,labeled.Metrics.EvaluatedSamples);
    }

    [Fact]
    public void RepeatedRunsAndInputChangesHaveDeterministicFingerprint()
    {
        var scope = PdmP3Fixtures.Scope();
        var samples = PdmP3Fixtures.Samples(scope, 1,1,1,1,1,1,1,1,7,1);
        var asOf = PdmP3Fixtures.Start.AddHours(4);
        var a = PdmP3OfflineReplayRunner.Run(samples,Array.Empty<PdmP3FaultLabel>(),8,asOf);
        var b = PdmP3OfflineReplayRunner.Run(samples,Array.Empty<PdmP3FaultLabel>(),8,asOf);
        Assert.Equal(a.InputSha256,b.InputSha256);
        Assert.Equal(a.Metrics.ReproducibilitySha256,b.Metrics.ReproducibilitySha256);
        var changed = samples.ToArray();
        changed[0] = changed[0] with { SourceId = "changed-source" };
        var c = PdmP3OfflineReplayRunner.Run(changed,Array.Empty<PdmP3FaultLabel>(),8,asOf);
        Assert.NotEqual(a.InputSha256,c.InputSha256);
    }

    [Fact]
    public void FutureLabelAndInvalidTrainingSplitAreRejected()
    {
        var scope = PdmP3Fixtures.Scope();
        var samples = PdmP3Fixtures.Samples(scope, 1,1,1,1,1,1,1,1,8,1);
        var asOf = PdmP3Fixtures.Start.AddHours(4);
        var future = PdmP3Fixtures.Label(scope,samples[8].EventTimeUtc,
            PdmP3FaultTruth.ConfirmedFault,asOf.AddDays(1));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP3OfflineReplayRunner.Run(samples,new[]{future},8,asOf));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PdmP3OfflineReplayRunner.Run(samples,Array.Empty<PdmP3FaultLabel>(),4,asOf));
    }
}

