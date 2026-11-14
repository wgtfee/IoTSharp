using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmTrendDetectorTests
{
    private static readonly DateTime Start = new(2026, 11, 13, 0, 0, 0, DateTimeKind.Utc);

    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
        Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
        Version = 2, MinimumCoverageRatio = 0.8
    };

    private static List<PdmHealthSnapshot> Windows(PdmDeviceProfile profile, params double[] values) =>
        values.Select((value, i) => new PdmHealthSnapshot
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            DeviceId = profile.DeviceId, ProfileId = profile.Id, ProfileVersion = profile.Version,
            WindowStartUtc = Start.AddMinutes(15 * i),
            WindowEndUtc = Start.AddMinutes(15 * (i + 1)),
            HealthIndex = value, DataQuality = "Good",
            RiskLevel = "Normal", CoverageRatio = 0.95
        }).ToList();

    [Fact]
    public void SustainedDecline_ProducesExplainablePointsPerHour_NotFailureProbability()
    {
        var p = Profile();
        var finding = PdmTrendDetector.Analyze(p, Windows(p, 94, 90, 86, 82, 78));
        Assert.Equal(PdmTrendDirection.Declining, finding.Direction);
        Assert.True(finding.IsActionable);
        Assert.InRange(finding.SlopePointsPerHour!.Value, -16.01, -15.99);
        Assert.Equal(-16, finding.ChangePoints);
        Assert.Equal(5, finding.ValidWindows);
    }

    [Fact]
    public void StableOrImprovingHistory_DoesNotInventDecline()
    {
        var p = Profile();
        Assert.Equal(PdmTrendDirection.Stable,
            PdmTrendDetector.Analyze(p, Windows(p, 88, 88.1, 88, 87.9, 88)).Direction);
        Assert.Equal(PdmTrendDirection.Improving,
            PdmTrendDetector.Analyze(p, Windows(p, 60, 65, 70, 75, 80)).Direction);
    }

    [Fact]
    public void InsufficientOrDisabledProfile_FailsClosed()
    {
        var p = Profile();
        Assert.Equal(PdmTrendDirection.Unknown,
            PdmTrendDetector.Analyze(p, Windows(p, 99, 98)).Direction);
        p.PointMappingsVerified = false;
        Assert.Equal(PdmTrendDirection.Unknown,
            PdmTrendDetector.Analyze(p, Windows(p, 99, 98, 97, 96, 95)).Direction);
    }

    [Fact]
    public void MixedTenantOrProfileVersion_FailsClosed()
    {
        var p = Profile();
        var rows = Windows(p, 94, 90, 86, 82, 78);
        rows[0].TenantId = Guid.NewGuid();
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
        rows[0].TenantId = p.TenantId;
        rows[0].ProfileVersion = 1;
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
    }

    [Fact]
    public void GapOrDuplicateTimestamp_CannotBeMisreportedAsHealthy()
    {
        var p = Profile();
        var rows = Windows(p, 94, 90, 86, 82, 78);
        rows[3].WindowStartUtc = rows[3].WindowStartUtc.AddMinutes(15);
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
        rows = Windows(p, 94, 90, 86, 82, 78);
        rows[3].WindowEndUtc = rows[2].WindowEndUtc;
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
    }

    [Fact]
    public void UnknownQualityAndNaN_AreNeverUsedForRiskInference()
    {
        var p = Profile();
        var rows = Windows(p, 94, 90, 86, 82, 78);
        rows[2].DataQuality = "Unknown";
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
        rows[2].DataQuality = "Good";
        rows[2].HealthIndex = double.NaN;
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
    }

    [Fact]
    public void UnverifiedUtcTimeOrLowCoverage_IsRejected()
    {
        var p = Profile();
        var rows = Windows(p, 94, 90, 86, 82, 78);
        rows[0].WindowEndUtc = DateTime.SpecifyKind(rows[0].WindowEndUtc, DateTimeKind.Unspecified);
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
        rows = Windows(p, 94, 90, 86, 82, 78);
        rows[2].CoverageRatio = 0.2;
        Assert.Equal(PdmTrendDirection.Unknown, PdmTrendDetector.Analyze(p, rows).Direction);
    }
}

