using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

public sealed class PdmHealthEvaluatorTests
{
    private static readonly DateTimeOffset End = new(2026, 11, 12, 8, 15, 0, TimeSpan.Zero);
    private static readonly Guid TenantId = Guid.Parse("7bacc388-76ae-4b73-9e8c-1a832ade43d1");
    private static readonly Guid CustomerId = Guid.Parse("3dab8acc-85d8-4163-96bc-c1ed22a172c8");
    private static readonly Guid DeviceId = Guid.Parse("0d41b921-53e6-4f7a-9d80-3dbacc2c0121");

    private static PdmDeviceProfile Profile() => new()
    {
        Id = Guid.Parse("8996a7ed-a0c4-4bbd-b21d-a74900c818c4"),
        TenantId = TenantId,
        CustomerId = CustomerId,
        DeviceId = DeviceId,
        Enabled = true,
        Version = 1,
        WindowMinutes = 15,
        MinimumCoverageRatio = .8
    };

    private static PdmPointPolicy Policy(PdmDeviceProfile profile, string key = "bearing_temperature") => new()
    {
        ProfileId = profile.Id,
        TelemetryKey = key,
        Unit = "°C",
        Enabled = true,
        Required = true,
        ExpectedIntervalSeconds = 60,
        MinValidValue = 0,
        MaxValidValue = 200,
        WarningHighValue = 80,
        CriticalHighValue = 100,
        RisingTrendPerMinute = .4,
        Weight = 1
    };

    private static PdmTelemetrySample Sample(int index, double? value, string key = "bearing_temperature",
        string unit = "°C", Guid? tenant = null, Guid? customer = null, Guid? device = null) =>
        new(tenant ?? TenantId, customer ?? CustomerId, device ?? DeviceId,
            key, End.AddMinutes(index - 15), value, unit);

    private static PdmTelemetrySample[] Series(Func<int, double> value) =>
        Enumerable.Range(0, 15).Select(i => Sample(i, value(i))).ToArray();

    private static PdmHealthEvaluation Eval(PdmDeviceProfile profile, PdmPointPolicy policy,
        IReadOnlyList<PdmTelemetrySample> samples, PdmOperatingState state = PdmOperatingState.Running) =>
        new PdmHealthEvaluator().Evaluate(profile, new[] { policy }, samples, End, state);

    [Fact]
    public void Normal_ValidValues_ReturnsRuleHealthIndex_NotFailureProbability()
    {
        var p = Profile();
        var output = Eval(p, Policy(p), Series(i => 52 + i * .02));
        Assert.Equal("Good", output.DataQuality);
        Assert.Equal(PdmRiskLevel.Normal, output.Risk);
        Assert.Equal(100, output.HealthIndex);
        Assert.Null(output.FailureProbability);
        Assert.Null(output.RemainingUsefulLife);
        Assert.Equal(1, output.CoverageRatio);
        Assert.Equal(15, output.Points.Single().Quality.ObservedSlots);
        var snapshot = output.ToSnapshot(p);
        Assert.Equal(p.TenantId, snapshot.TenantId);
        Assert.Equal(100, snapshot.HealthIndex);
        Assert.Equal(0, snapshot.FailedPointCount);
        Assert.Equal(End.UtcDateTime, snapshot.WindowEndUtc);
    }

    [Fact]
    public void RisingTemperature_ProducesAttentionOnly_WhenBelowWarningLimit()
    {
        var p = Profile();
        var output = Eval(p, Policy(p), Series(i => 50 + i * 1.0));
        Assert.Equal(PdmRiskLevel.Attention, output.Risk);
        Assert.Equal(75, output.HealthIndex);
        Assert.True(output.Points.Single().Quality.SustainedRise);
    }

    [Theory]
    [InlineData(90, PdmRiskLevel.Warning)]
    [InlineData(105, PdmRiskLevel.Critical)]
    public void ThresholdExceedance_UsesConfiguredRuleLevels(double value, PdmRiskLevel expected)
    {
        var p = Profile();
        var output = Eval(p, Policy(p), Series(_ => value));
        Assert.Equal(expected, output.Risk);
        Assert.True(output.HealthIndex < 100);
    }

    [Theory]
    [InlineData(PdmOperatingState.Stopped, PdmPointQualityStatus.NotRunning)]
    [InlineData(PdmOperatingState.Offline, PdmPointQualityStatus.Offline)]
    [InlineData(PdmOperatingState.Unknown, PdmPointQualityStatus.OperatingStateUnknown)]
    public void NonRunningEquipment_NeverProducesHealthIndex(PdmOperatingState state, PdmPointQualityStatus quality)
    {
        var p = Profile();
        var output = Eval(p, Policy(p), Series(_ => 55), state);
        Assert.Null(output.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, output.Risk);
        Assert.Equal(quality, output.Points.Single().Quality.Status);
    }

    [Fact]
    public void MissingWindowCoverage_NeverReportsHealthy()
    {
        var p = Profile();
        var sparse = Series(_ => 55).Where((_, i) => i >= 8).ToArray();
        var result = Eval(p, Policy(p), sparse);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmPointQualityStatus.Insufficient, result.Points.Single().Quality.Status);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
    }

    [Fact]
    public void LastSampleStaleAndLargeContinuousGap_AreUnknown()
    {
        var p = Profile();
        var stale = Series(_ => 55).Where((_, i) => i <= 12).ToArray();
        Assert.Equal(PdmPointQualityStatus.Stale, Eval(p, Policy(p), stale).Points.Single().Quality.Status);
        var extendedProfile = Profile();
        extendedProfile.WindowMinutes = 60;
        var gap = Enumerable.Range(0, 60)
            .Where(i => i is < 30 or > 33)
            .Select(i => new PdmTelemetrySample(TenantId, CustomerId, DeviceId,
                "bearing_temperature", End.AddMinutes(i - 60), 52, "°C")).ToArray();
        var extended = Eval(extendedProfile, Policy(extendedProfile), gap);
        Assert.Equal(PdmPointQualityStatus.ExcessiveGap, extended.Points.Single().Quality.Status);
    }

    [Theory]
    [InlineData("F", PdmPointQualityStatus.UnitMismatch)]
    [InlineData("°C", PdmPointQualityStatus.InvalidValue)]
    public void InvalidUnitOrValue_BlocksEvaluation(string unit, PdmPointQualityStatus quality)
    {
        var p = Profile();
        var samples = Series(_ => 55);
        samples[5] = samples[5] with { Unit = unit, Value = unit == "F" ? 55 : double.NaN };
        Assert.Equal(quality, Eval(p, Policy(p), samples).Points.Single().Quality.Status);
    }

    [Fact]
    public void DuplicateExactAndOutOfOrder_AreDeterministic()
    {
        var p = Profile();
        var normal = Series(i => 52 + i * .02);
        var reordered = normal.Reverse().Concat(new[] { normal[2] }).ToArray();
        var result = Eval(p, Policy(p), reordered);
        Assert.Equal(100, result.HealthIndex);
        Assert.Equal(1, result.Points.Single().Quality.ExactDuplicates);
        Assert.True(result.Points.Single().Quality.ReorderedSamples > 0);
        Assert.Equal(15, result.Points.Single().Quality.ObservedSlots);
    }

    [Fact]
    public void ConflictingDuplicate_BlocksHealthScore()
    {
        var p = Profile();
        var normal = Series(_ => 52);
        var data = normal.Concat(new[] { normal[4] with { Value = 130 } }).ToArray();
        var result = Eval(p, Policy(p), data);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmPointQualityStatus.ConflictingDuplicate, result.Points.Single().Quality.Status);
    }

    [Fact]
    public void ForeignTenantOrDevice_MustRejectBatchEvenWhenValueLooksNormal()
    {
        var p = Profile();
        var normal = Series(_ => 52);
        var crossTenant = normal.Concat(new[] {
            Sample(4, 52, tenant: Guid.NewGuid()),
            Sample(5, 52, device: Guid.NewGuid())
        }).ToArray();
        var result = Eval(p, Policy(p), crossTenant);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
        Assert.Contains(result.Reasons, x => x.Contains("不同租户"));
    }

    [Fact]
    public void OptionalPointMissing_PartialQualityStillUsesRequiredScore()
    {
        var p = Profile();
        var optional = Policy(p, "optional_temperature");
        optional.Required = false;
        var result = new PdmHealthEvaluator().Evaluate(p, new[] { Policy(p), optional },
            Series(_ => 52), End, PdmOperatingState.Running);
        Assert.Equal("Partial", result.DataQuality);
        Assert.Equal(100, result.HealthIndex);
        Assert.Equal(1, result.Points.Count(a => a.Quality.IsUsable));
    }

    [Fact]
    public void RequiredPointMissing_BlocksEvenIfOptionalIsHealthy()
    {
        var p = Profile();
        var optional = Policy(p, "optional_temperature");
        optional.Required = false;
        var data = Series(_ => 52).Select(s => s with { Key = "optional_temperature" }).ToArray();
        var result = new PdmHealthEvaluator().Evaluate(p, new[] { Policy(p), optional },
            data, End, PdmOperatingState.Running);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
    }

    [Fact]
    public void DisabledOrInvalidProfile_ProducesNoScore()
    {
        var p = Profile();
        p.Enabled = false;
        Assert.Null(Eval(p, Policy(p), Series(_ => 52)).HealthIndex);
        p.Enabled = true;
        var invalidPolicy = Policy(p);
        invalidPolicy.WarningHighValue = 0;
        Assert.Equal(PdmPointQualityStatus.PolicyInvalid,
            Eval(p, invalidPolicy, Series(_ => 52)).Points.Single().Quality.Status);
    }

    [Fact]
    public void ProfileScopeMismatch_BlocksSnapshotConversion()
    {
        var p = Profile();
        var result = Eval(p, Policy(p), Series(_ => 52));
        p.DeviceId = Guid.NewGuid();
        Assert.Throws<InvalidOperationException>(() => result.ToSnapshot(p));
    }

    [Fact]
    public void NoRequiredPolicy_IsUnknownAndDoesNotPublishHealthy()
    {
        var p = Profile();
        var optional = Policy(p);
        optional.Required = false;
        var result = Eval(p, optional, Series(_ => 52));
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
    }

    [Fact]
    public void MalformedTelemetryKey_IsRejectedWithoutRuntimeException()
    {
        var p = Profile();
        var data = Series(_ => 52);
        data[5] = data[5] with { Key = null! };
        var result = Eval(p, Policy(p), data);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
    }

    [Fact]
    public void WrongProfileOrRepeatedPointPolicy_IsRejected()
    {
        var p = Profile();
        var invalid = Policy(p);
        invalid.ProfileId = Guid.NewGuid();
        var samples = Series(_ => 52);
        Assert.Null(Eval(p, invalid, samples).HealthIndex);
        var duplicate = Policy(p);
        var withDuplicate = new PdmHealthEvaluator().Evaluate(
            p, new[] { Policy(p), duplicate }, samples, End, PdmOperatingState.Running);
        Assert.Null(withDuplicate.HealthIndex);
    }

    [Fact]
    public void NonFiniteWeights_AreRejected()
    {
        var p = Profile();
        var invalid = Policy(p);
        invalid.Weight = double.NaN;
        Assert.Null(Eval(p, invalid, Series(_ => 52)).HealthIndex);
    }
    [Fact]
    public void HugeInputBatch_StopsWithoutCalculating()
    {
        var p = Profile();
        var input = Enumerable.Repeat(Sample(0, 55), PdmHealthEvaluator.MaxSamplesPerEvaluation + 1).ToArray();
        var result = Eval(p, Policy(p), input);
        Assert.Null(result.HealthIndex);
        Assert.Equal(PdmRiskLevel.Unknown, result.Risk);
    }
}

