using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Health;

public sealed class GatewayFlowControlHealthCheck : IHealthCheck
{
    private readonly GatewayFlowControlService _flowControl;
    public GatewayFlowControlHealthCheck(GatewayFlowControlService flowControl) => _flowControl = flowControl;

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var snapshot = _flowControl.GetSnapshot();
        var data = new Dictionary<string, object>
        {
            ["flow.mode"] = snapshot.Mode,
            ["flow.queueUtilization"] = snapshot.QueueUtilization,
            ["flow.persistenceLagSeconds"] = snapshot.PersistenceLagSeconds,
            ["flow.persistenceInFlightBatches"] = snapshot.PersistenceInFlightBatches,
            ["flow.eligibleGateways"] = snapshot.EligibleGateways,
            ["flow.publishedHints"] = snapshot.PublishedHints,
            ["flow.publishFailures"] = snapshot.PublishFailures
        };
        return Task.FromResult(HealthCheckResult.Healthy(
            $"Gateway flow control mode={snapshot.Mode}, utilization={snapshot.QueueUtilization:P1}, persistenceLag={snapshot.PersistenceLagSeconds:F1}s.",
            data));
    }
}
