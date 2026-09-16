using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Health;

/// <summary>
/// Exposes gateway runtime counts without making field gateway availability part of platform readiness.
/// </summary>
public sealed class GatewayRuntimeRegistryHealthCheck : IHealthCheck
{
    private readonly GatewayRuntimeRegistry _registry;

    public GatewayRuntimeRegistryHealthCheck(GatewayRuntimeRegistry registry) => _registry = registry;

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var snapshots = _registry.GetSnapshots();
        var data = new Dictionary<string, object>
        {
            ["gateway.total"] = snapshots.Count,
            ["gateway.healthy"] = snapshots.Count(item => item.Status == GatewayRuntimeStatus.Healthy),
            ["gateway.degraded"] = snapshots.Count(item => item.Status == GatewayRuntimeStatus.Degraded),
            ["gateway.offline"] = snapshots.Count(item => item.Status == GatewayRuntimeStatus.Offline),
            ["gateway.recovering"] = snapshots.Count(item => item.Status == GatewayRuntimeStatus.Recovering)
        };
        return Task.FromResult(HealthCheckResult.Healthy(
            $"Gateway registry contains {snapshots.Count} runtime entries. Field gateway state does not gate platform readiness.",
            data));
    }
}
