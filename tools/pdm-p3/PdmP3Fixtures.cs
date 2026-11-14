using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Services.PredictiveMaintenance.P3;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

internal static class PdmP3Fixtures
{
    internal static readonly DateTimeOffset Start =
        new(2026, 11, 13, 0, 0, 0, TimeSpan.Zero);

    internal static PdmP3SeriesScope Scope() =>
        new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            3, "bearing.vibration.rms", "mm/s", "Running", true, true, true);

    internal static List<PdmP3Observation> Samples(
        PdmP3SeriesScope scope, params double[] values) =>
        values.Select((x, i) =>
            new PdmP3Observation(scope, Start.AddMinutes(15 * i),
                x, PdmP3SampleQuality.Good, "isolated-p3-fixture-v1")).ToList();

    internal static PdmP3FaultLabel Label(
        PdmP3SeriesScope scope, DateTimeOffset observed,
        PdmP3FaultTruth truth, DateTimeOffset verified) =>
        new(scope, observed, verified, truth,
            "human-verified-case-007", "authenticated-inspector-1");

    internal static PdmDeviceProfile Profile(PdmP3SeriesScope scope) => new()
    {
        Id = scope.ProfileId, TenantId = scope.TenantId,
        CustomerId = scope.CustomerId, DeviceId = scope.DeviceId,
        Version = scope.ProfileVersion, Enabled = true,
        PointMappingsVerified = true, RunStateVerified = true
    };

    internal static PdmP2AdvisoryBundle P2At(DateTime utcWindowEnd) =>
        new(
            new PdmTrendFinding(PdmTrendDirection.Stable, 6, 0, 0,
                utcWindowEnd, "isolated verified P2 sample windows"),
            new PdmAlertDecision(PdmAlertDecisionKind.Held,
                "no active alert, offline only", null),
            new PdmMaintenanceDraft(PdmAdviceState.NotApplicable,
                null, Guid.NewGuid(), "offline only", "synthetic",
                Array.Empty<string>()));
}

