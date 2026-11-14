using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3DataContractsTests
{
    [Fact]
    public void VerifiedOrderedSameConditionSeries_IsAccepted()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1, 1.1, 1.2, 1.1, 1);
        var result = PdmP3DatasetValidator.ValidateSamples(rows);
        Assert.True(result.Accepted);
        Assert.Equal(5, result.AcceptedRows);
        Assert.Equal(rows[^1].EventTimeUtc, result.LatestTimeUtc);
    }

    [Fact]
    public void UnverifiedPointUnitsAndOperatingCondition_FailClosed()
    {
        var scope = PdmP3Fixtures.Scope();
        Assert.False(PdmP3DatasetValidator.ValidateSamples(PdmP3Fixtures.Samples(
            scope with { MappingVerified = false }, 1,2,3,4,5)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateSamples(PdmP3Fixtures.Samples(
            scope with { UnitVerified = false }, 1,2,3,4,5)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateSamples(PdmP3Fixtures.Samples(
            scope with { OperatingModeVerified = false }, 1,2,3,4,5)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateSamples(PdmP3Fixtures.Samples(
            scope with { OperatingMode = "Unknown" }, 1,2,3,4,5)).Accepted);
    }

    [Fact]
    public void MixingTenantEquipmentUnitOrProfileVersion_IsRejected()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[3] = rows[3] with { Scope = scope with { TenantId = Guid.NewGuid() } };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows[3] = rows[3] with { Scope = scope with { TenantId = scope.TenantId, EngineeringUnit = "A" } };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows[3] = rows[3] with { Scope = scope with { EngineeringUnit = scope.EngineeringUnit, ProfileVersion = 4 } };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
    }

    [Fact]
    public void PoorQualityAndNonFiniteSignals_AreNeverAnalyzed()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[2] = rows[2] with { Quality = PdmP3SampleQuality.Partial };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows[2] = rows[2] with { Quality = PdmP3SampleQuality.Good, Value = double.NaN };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows[2] = rows[2] with { Value = double.PositiveInfinity };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
    }

    [Fact]
    public void DuplicateOutOfOrderGappedOrNonUtcTimes_AreRejected()
    {
        var scope = PdmP3Fixtures.Scope();
        var rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[2] = rows[2] with { EventTimeUtc = rows[1].EventTimeUtc };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[2] = rows[2] with { EventTimeUtc = rows[1].EventTimeUtc.AddMinutes(-2) };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[3] = rows[3] with { EventTimeUtc = rows[2].EventTimeUtc.AddHours(3) };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
        rows = PdmP3Fixtures.Samples(scope, 1,2,3,4,5);
        rows[0] = rows[0] with { EventTimeUtc = rows[0].EventTimeUtc.ToOffset(TimeSpan.FromHours(8)) };
        Assert.False(PdmP3DatasetValidator.ValidateSamples(rows).Accepted);
    }

    [Fact]
    public void MissingFaultLabelsNeverMeanNormal_AndFutureVerificationIsInvalid()
    {
        var scope = PdmP3Fixtures.Scope();
        var asOf = PdmP3Fixtures.Start.AddHours(2);
        Assert.True(PdmP3DatasetValidator.ValidateLabels(
            scope, Array.Empty<PdmP3FaultLabel>(), asOf).Accepted);
        var unlabeled = PdmP3Fixtures.Label(scope, PdmP3Fixtures.Start,
            PdmP3FaultTruth.Unlabeled, asOf.AddMinutes(-1));
        Assert.False(PdmP3DatasetValidator.ValidateLabels(scope, new[] { unlabeled }, asOf).Accepted);
        var future = PdmP3Fixtures.Label(scope, PdmP3Fixtures.Start,
            PdmP3FaultTruth.ConfirmedFault, asOf.AddDays(1));
        Assert.False(PdmP3DatasetValidator.ValidateLabels(scope, new[] { future }, asOf).Accepted);
    }

    [Fact]
    public void HumanEvidenceAndLabelProvenanceMustMatchTrustedScope()
    {
        var scope = PdmP3Fixtures.Scope();
        var time = PdmP3Fixtures.Start.AddHours(1);
        var label = PdmP3Fixtures.Label(scope, time,
            PdmP3FaultTruth.ConfirmedNormal, time.AddMinutes(5));
        Assert.True(PdmP3DatasetValidator.ValidateLabels(scope, new[] { label },
            time.AddMinutes(6)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateLabels(scope,
            new[] { label with { VerifiedBy = "" } }, time.AddMinutes(6)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateLabels(scope,
            new[] { label with { Scope = scope with { CustomerId = Guid.NewGuid() } } },
            time.AddMinutes(6)).Accepted);
        Assert.False(PdmP3DatasetValidator.ValidateLabels(scope,
            new[] { label, label }, time.AddMinutes(6)).Accepted);
    }
}

