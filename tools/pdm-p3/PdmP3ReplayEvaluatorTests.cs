using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3ReplayEvaluatorTests
{
    private static PdmP3AnomalyFinding Prediction(
        PdmP3SeriesScope scope, int minutes, PdmP3AnomalyState state) =>
        new(scope, PdmP3Fixtures.Start.AddMinutes(minutes),
            state, state == PdmP3AnomalyState.Anomalous ? 5 : 0.1,
            1, .1, state == PdmP3AnomalyState.Anomalous ? 4 : 0,
            8, "synthetic offline replay, not real benchmark");

    [Fact]
    public void NoVerifiedLabelsProducesNoPrecisionRecallOrNormalAssumptions()
    {
        var scope = PdmP3Fixtures.Scope();
        var predictions = new[]
        {
            Prediction(scope, 15, PdmP3AnomalyState.Anomalous),
            Prediction(scope, 30, PdmP3AnomalyState.Normal)
        };
        var result = PdmP3ReplayEvaluator.Evaluate(predictions,
            Array.Empty<PdmP3FaultLabel>(), PdmP3Fixtures.Start, PdmP3Fixtures.Start.AddHours(4));
        Assert.False(result.HasTrustedGroundTruth);
        Assert.Equal(0, result.EvaluatedSamples);
        Assert.Equal(2, result.UnlabeledSamples);
        Assert.Null(result.Precision);
        Assert.Null(result.Recall);
        Assert.Null(result.FailureProbabilityCalibration);
    }

    [Fact]
    public void ConfirmedGroundTruthSeparatesTPFPFNAndTN()
    {
        var scope = PdmP3Fixtures.Scope();
        var start = PdmP3Fixtures.Start;
        var predictions = new[]
        {
            Prediction(scope, 15, PdmP3AnomalyState.Anomalous),
            Prediction(scope, 30, PdmP3AnomalyState.Anomalous),
            Prediction(scope, 45, PdmP3AnomalyState.Normal),
            Prediction(scope, 60, PdmP3AnomalyState.Normal)
        };
        var labels = new[]
        {
            PdmP3Fixtures.Label(scope,start.AddMinutes(15), PdmP3FaultTruth.ConfirmedFault,start.AddMinutes(80)),
            PdmP3Fixtures.Label(scope,start.AddMinutes(30), PdmP3FaultTruth.ConfirmedNormal,start.AddMinutes(85)),
            PdmP3Fixtures.Label(scope,start.AddMinutes(45), PdmP3FaultTruth.ConfirmedFault,start.AddMinutes(90)),
            PdmP3Fixtures.Label(scope,start.AddMinutes(60), PdmP3FaultTruth.ConfirmedNormal,start.AddMinutes(95))
        };
        var result = PdmP3ReplayEvaluator.Evaluate(
            predictions, labels, start, start.AddHours(2));
        Assert.True(result.HasTrustedGroundTruth);
        Assert.Equal(4, result.EvaluatedSamples);
        Assert.Equal(1, result.TruePositive);
        Assert.Equal(1, result.FalsePositive);
        Assert.Equal(1, result.FalseNegative);
        Assert.Equal(1, result.TrueNegative);
        Assert.Equal(.5, result.Precision);
        Assert.Equal(.5, result.Recall);
        Assert.Equal(64, result.ReproducibilitySha256.Length);
    }

    [Fact]
    public void ChronologicalHoldoutAndUnknownPredictionsAreNotMiscounted()
    {
        var scope = PdmP3Fixtures.Scope();
        var start = PdmP3Fixtures.Start;
        var predictions = new[]
        {
            Prediction(scope, 0, PdmP3AnomalyState.Anomalous),
            Prediction(scope, 30, PdmP3AnomalyState.Unknown),
            Prediction(scope, 45, PdmP3AnomalyState.Normal)
        };
        var labels = new[]
        {
            PdmP3Fixtures.Label(scope,start,PdmP3FaultTruth.ConfirmedFault,start.AddMinutes(5)),
            PdmP3Fixtures.Label(scope,start.AddMinutes(30),PdmP3FaultTruth.ConfirmedFault,start.AddMinutes(70)),
            PdmP3Fixtures.Label(scope,start.AddMinutes(45),PdmP3FaultTruth.ConfirmedNormal,start.AddMinutes(75))
        };
        var metrics = PdmP3ReplayEvaluator.Evaluate(predictions,labels,
            start.AddMinutes(20),start.AddHours(3));
        Assert.Equal(1, metrics.EvaluatedSamples);
        Assert.Equal(1, metrics.AbstainedSamples);
        Assert.Equal(0, metrics.FalsePositive);
        Assert.Equal(1, metrics.TrueNegative);
        Assert.Null(metrics.Precision);
        Assert.Null(metrics.Recall);
    }

    [Fact]
    public void FutureVerifiedFaultLabelIsRejectedNotUsedForHindsight()
    {
        var scope = PdmP3Fixtures.Scope();
        var start = PdmP3Fixtures.Start;
        var prediction = new[] { Prediction(scope, 15, PdmP3AnomalyState.Anomalous) };
        var label = PdmP3Fixtures.Label(scope,start.AddMinutes(15),
            PdmP3FaultTruth.ConfirmedFault,start.AddDays(2));
        Assert.Throws<ArgumentException>(() =>
            PdmP3ReplayEvaluator.Evaluate(prediction,new[] { label },
                start,start.AddHours(3)));
    }

    [Fact]
    public void MixedTenantDuplicateTimestampsAndNonUtcCutoffsFailClosed()
    {
        var scope = PdmP3Fixtures.Scope();
        var start = PdmP3Fixtures.Start;
        var p = Prediction(scope, 15, PdmP3AnomalyState.Anomalous);
        Assert.Throws<ArgumentException>(() =>
            PdmP3ReplayEvaluator.Evaluate(new[] { p,
                p with { Scope = scope with { TenantId = Guid.NewGuid() }, AtUtc = start.AddMinutes(30) } },
                Array.Empty<PdmP3FaultLabel>(), start,start.AddHours(1)));
        Assert.Throws<ArgumentException>(() =>
            PdmP3ReplayEvaluator.Evaluate(new[] { p,p },
                Array.Empty<PdmP3FaultLabel>(),start,start.AddHours(1)));
        Assert.Throws<ArgumentException>(() =>
            PdmP3ReplayEvaluator.Evaluate(new[] { p },
                Array.Empty<PdmP3FaultLabel>(),start.ToOffset(TimeSpan.FromHours(8)),start.AddHours(1)));
    }

    [Fact]
    public void IdenticalReplayIsReproducibleWithoutWallClockOrRandomSeed()
    {
        var scope = PdmP3Fixtures.Scope();
        var start = PdmP3Fixtures.Start;
        var predictions = new[]
        {
            Prediction(scope, 30, PdmP3AnomalyState.Normal),
            Prediction(scope, 15, PdmP3AnomalyState.Anomalous)
        };
        var label = PdmP3Fixtures.Label(scope,start.AddMinutes(15),
            PdmP3FaultTruth.ConfirmedFault,start.AddMinutes(60));
        var a = PdmP3ReplayEvaluator.Evaluate(
            predictions,new[] { label },start,start.AddHours(2));
        var b = PdmP3ReplayEvaluator.Evaluate(
            predictions.Reverse().ToArray(),new[] { label },start,start.AddHours(2));
        Assert.Equal(a.ReproducibilitySha256,b.ReproducibilitySha256);
        Assert.Equal(a.Precision,b.Precision);
        Assert.Equal(a.Recall,b.Recall);
    }
}

