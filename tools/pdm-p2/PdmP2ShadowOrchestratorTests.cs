using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmP2ShadowOrchestratorTests
{
    private static readonly DateTime Start = new(2026, 11, 13, 8, 0, 0, DateTimeKind.Utc);

    private static (PdmDeviceProfile profile, List<PdmHealthSnapshot> history,
        PdmRiskEvent risk, PdmHealthEvaluation current) Arrange()
    {
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
            Version = 3, Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
            MinimumCoverageRatio = 0.8
        };
        var values = new double[] { 94, 86, 78, 70, 62 };
        var windows = values.Select((value, i) => new PdmHealthSnapshot
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
            ProfileId = p.Id, ProfileVersion = p.Version, DataQuality = "Good",
            HealthIndex = value, RiskLevel = "Warning", CoverageRatio = 0.95,
            WindowStartUtc = Start.AddMinutes(15 * i),
            WindowEndUtc = Start.AddMinutes(15 * (i + 1))
        }).ToList();
        var end = new DateTimeOffset(windows[^1].WindowEndUtc);
        var evaluation = new PdmHealthEvaluation(p.TenantId, p.CustomerId, p.DeviceId,
            end.AddMinutes(-15), end, "Good", values[^1], PdmRiskLevel.Warning,
            0.95, Array.Empty<PdmPointAssessment>(), Array.Empty<string>());
        var episode = new PdmRiskEvent
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
            ProfileId = p.Id, ProfileVersion = p.Version,
            RiskLevel = "Warning", Status = "Open",
            EventKey = "p2-orchestration-synthetic",
            LastEvaluatedWindowEndUtc = end.UtcDateTime, OccurrenceCount = 3,
            EvidenceJson = "{\"reasons\":[\"verified abnormal trend\"]}"
        };
        return (p, windows, episode, evaluation);
    }

    [Fact]
    public void ConsistentVerifiedWindows_GenerateOnlyAdvisoryProposals()
    {
        var (p, history, risk, current) = Arrange();
        var response = PdmP2ShadowOrchestrator.Evaluate(
            p, history, risk, current, new(), PdmMeasurementCategory.Vibration, true);
        Assert.Equal(PdmTrendDirection.Declining, response.Trend.Direction);
        Assert.Equal(PdmAlertDecisionKind.Notify, response.Alert.Kind);
        Assert.Equal(PdmAdviceState.ReadyForHumanReview, response.Maintenance.State);
        Assert.True(response.IsReadOnly);
        Assert.True(response.Maintenance.RequiresHumanApproval);
        Assert.False(response.Maintenance.IsWorkOrderIssued);
        Assert.Null(response.Maintenance.FailureProbability);
    }

    [Fact]
    public void StaleOrCrossTenantHistory_BlocksBothAlertAndMaintenance()
    {
        var (p, history, risk, current) = Arrange();
        history[^1].WindowEndUtc = history[^1].WindowEndUtc.AddMinutes(-5);
        var result = PdmP2ShadowOrchestrator.Evaluate(
            p, history, risk, current, new(), PdmMeasurementCategory.Temperature, true);
        Assert.Equal(PdmAlertDecisionKind.Held, result.Alert.Kind);
        Assert.Equal(PdmAdviceState.NeedsDataVerification, result.Maintenance.State);

        (p, history, risk, current) = Arrange();
        history[0].TenantId = Guid.NewGuid();
        result = PdmP2ShadowOrchestrator.Evaluate(
            p, history, risk, current, new(), PdmMeasurementCategory.Vibration, true);
        Assert.Equal(PdmTrendDirection.Unknown, result.Trend.Direction);
        Assert.Equal(PdmAlertDecisionKind.Held, result.Alert.Kind);
        Assert.Null(result.Alert.IdempotencyKey);
    }

    [Fact]
    public void UnverifiedMeasurementCategory_CannotProduceWorkOrderReadyAdvice()
    {
        var (p, history, risk, current) = Arrange();
        var result = PdmP2ShadowOrchestrator.Evaluate(
            p, history, risk, current, new(), PdmMeasurementCategory.Unclassified, true);
        Assert.Equal(PdmAdviceState.NeedsDataVerification, result.Maintenance.State);
        Assert.False(result.Maintenance.IsWorkOrderIssued);
    }
}

