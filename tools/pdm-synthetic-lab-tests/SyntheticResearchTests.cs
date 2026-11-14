using IoTSharp.PdmSyntheticLab;
using Xunit;

namespace IoTSharp.PdmSyntheticLab.Tests;

public sealed class SyntheticResearchTests
{
    [Fact]
    public void GeneratorIsReproducibleAndContainsThreeIndependentEquipmentAndTimeSplits()
    {
        var a = SyntheticResearch.Generate();
        var b = SyntheticResearch.Generate();
        Assert.Equal(SyntheticResearch.Sha256(SyntheticResearch.Canonical(a)),
            SyntheticResearch.Sha256(SyntheticResearch.Canonical(b)));
        Assert.NotEqual(SyntheticResearch.Sha256(SyntheticResearch.Canonical(a)),
            SyntheticResearch.Sha256(SyntheticResearch.Canonical(
                SyntheticResearch.Generate(20261115))));
        SyntheticResearch.ValidateDataset(a);
        var partitions = Enum.GetValues<SyntheticPartition>().Select(k =>
            a.Where(x => x.Partition == k).Select(x => x.DeviceId).Distinct().ToHashSet())
            .ToArray();
        Assert.Equal(18, partitions[0].Count);
        Assert.Equal(6, partitions[1].Count);
        Assert.Equal(6, partitions[2].Count);
        Assert.Empty(partitions[0].Intersect(partitions[1]));
        Assert.Empty(partitions[0].Intersect(partitions[2]));
        Assert.Empty(partitions[1].Intersect(partitions[2]));
        Assert.All(a, x => Assert.StartsWith("SYN-DEV-", x.DeviceId));
    }

    [Fact]
    public void CanFitAndBlindTestSyntheticMultivariateRiskAndRul()
    {
        var (model, result) = SyntheticResearch.Run(SyntheticResearch.Generate());
        Assert.Equal("SyntheticOfflineStudyOnly", result.State);
        Assert.True(model.SyntheticOnly);
        Assert.False(model.RealWorldCalibrated);
        Assert.False(model.ProductionActivationAllowed);
        Assert.False(result.PhysicalEvidenceReviewed);
        Assert.False(result.ProductionApproved);
        Assert.True(result.BlindTest.Rows > 100);
        Assert.True(result.BlindTest.FaultRows > 0);
        Assert.InRange(result.BlindTest.F1, 0, 1);
        Assert.InRange(result.BlindTest.BrierScore, 0, 1);
        Assert.True(double.IsFinite(result.BlindTest.RulMaeHours));
        Assert.Equal(64, model.TrainingAndValidationSha256.Length);
    }

    [Fact]
    public void ChangingOnlyBlindHoldoutCannotChangeWeightsThresholdOrFitFingerprint()
    {
        var original = SyntheticResearch.Generate();
        var (model, report) = SyntheticResearch.Run(original);
        var changed = original.Select(x => x.Partition == SyntheticPartition.Test
            ? x with
            {
                VibrationMmS = x.VibrationMmS + 50,
                FailureWithin24Hours = !x.FailureWithin24Hours,
                HoursUntilNextFault = x.FailureWithin24Hours ? 48 : 8
            }
            : x).ToArray();
        // Rewriting labels and their targets is legal *only* in this negative test.
        var (after, next) = SyntheticResearch.Run(changed);
        Assert.Equal(model.RiskWeights, after.RiskWeights);
        Assert.Equal(model.LogRulWeights, after.LogRulWeights);
        Assert.Equal(model.RiskThreshold, after.RiskThreshold);
        Assert.Equal(model.TrainingAndValidationSha256, after.TrainingAndValidationSha256);
        Assert.NotEqual(report.FullSyntheticDatasetSha256, next.FullSyntheticDatasetSha256);
    }

    [Fact]
    public void MissingEmbargoOrSameEquipmentCrossingSplitsMustBeRejected()
    {
        var rows = SyntheticResearch.Generate().ToArray();
        rows[0] = rows[0] with { AtUtc = SyntheticResearch.StartUtc.AddDays(27) };
        Assert.Throws<InvalidOperationException>(() => SyntheticResearch.ValidateDataset(rows));
        rows = SyntheticResearch.Generate().ToArray();
        var val = Array.FindIndex(rows, x => x.Partition == SyntheticPartition.Validation);
        rows[val] = rows[val] with { DeviceId = "SYN-DEV-000" };
        Assert.Throws<InvalidOperationException>(() => SyntheticResearch.ValidateDataset(rows));
    }

    [Fact]
    public void FailureLabelAndFutureRulCannotBeReadFromInferenceFeatureVector()
    {
        var row = SyntheticResearch.Generate()[0];
        var edited = row with { FailureWithin24Hours = !row.FailureWithin24Hours,
            HoursUntilNextFault = 999 };
        Assert.Equal(row.FeatureVector(), edited.FeatureVector());
        Assert.Equal(6, row.FeatureVector().Length);
        var (model, _) = SyntheticResearch.Run(SyntheticResearch.Generate());
        Assert.Equal(SyntheticResearch.Score(model, row),
            SyntheticResearch.Score(model, edited));
    }

    [Fact]
    public void ModelPersistAndReopenVerifiesChecksumAndNeverEnablesProduction()
    {
        var path = Path.Combine(Path.GetTempPath(),
            "pdm-synthetic-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var (model, _) = SyntheticResearch.Run(SyntheticResearch.Generate());
            SyntheticResearch.SaveModel(path, model);
            Assert.Equal(model, model with { });
            var loaded = SyntheticResearch.LoadModel(path);
            Assert.Equal(model.RiskWeights, loaded.RiskWeights);
            Assert.Equal(model.TrainingAndValidationSha256, loaded.TrainingAndValidationSha256);
            Assert.False(loaded.ProductionActivationAllowed);
            File.AppendAllText(path, "tampered");
            Assert.Throws<InvalidOperationException>(() => SyntheticResearch.LoadModel(path));
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
            if (File.Exists(path + ".sha256")) File.Delete(path + ".sha256");
        }
    }
}
