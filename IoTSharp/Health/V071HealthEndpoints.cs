using Industrial.Health;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Health;

public static class V071HealthEndpoints
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static void MapV071Health(this IEndpointRouteBuilder endpoints, string serviceName)
    {
        endpoints.MapGet("/health/live", () =>
        {
            var now = DateTimeOffset.UtcNow;
            return Json(new
            {
                service = serviceName,
                instance = Environment.MachineName,
                status = ServiceStatus.Healthy,
                application = new ApplicationHealth(ServiceStatus.Healthy, true, now),
                checkedAt = now
            });
        });

        endpoints.MapGet("/health/dependencies", async (HealthCheckService healthChecks, CancellationToken ct) =>
        {
            var snapshot = await EvaluateAsync(serviceName, healthChecks, ct);
            return Json(snapshot);
        });

        endpoints.MapGet("/health/traffic", async (HealthCheckService healthChecks, CancellationToken ct) =>
        {
            var snapshot = await EvaluateAsync(serviceName, healthChecks, ct);
            var traffic = HealthSnapshotEvaluator.ToTrafficHealth(snapshot);
            return Json(traffic, traffic.Status == TrafficStatus.Allowed ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
        });
    }

    // IoTSharp wraps the response PipeWriter for request tracing. On the current
    // runtime that wrapper does not expose UnflushedBytes, which breaks the
    // framework's WriteAsJsonAsync path for clients that do not request gzip.
    // Serializing before writing keeps the health contract independent of that
    // middleware implementation.
    private static IResult Json(object value, int statusCode = StatusCodes.Status200OK)
        => Results.Content(JsonSerializer.Serialize(value, JsonOptions), "application/json", Encoding.UTF8, statusCode);

    private static async Task<ServiceHealthSnapshot> EvaluateAsync(string serviceName, HealthCheckService healthChecks, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var report = await healthChecks.CheckHealthAsync(ct);
        var dependencies = report.Entries.Select(entry =>
        {
            var healthy = entry.Value.Status == HealthStatus.Healthy;
            var criticality = Classify(entry.Key);
            return new DependencyHealthItem(
                entry.Key,
                healthy ? DependencyStatus.Healthy : DependencyStatus.Unhealthy,
                criticality,
                healthy ? null : ReasonCode(entry.Key),
                healthy ? null : "Configured dependency health check failed",
                healthy ? null : now,
                healthy ? null : Impact(entry.Key),
                criticality != DependencyCriticality.Critical);
        }).ToArray();
        return HealthSnapshotEvaluator.Evaluate(serviceName, Environment.MachineName, dependencies, checkedAt: now);
    }

    private static DependencyCriticality Classify(string name)
    {
        var value = name.ToLowerInvariant();
        if (value.Contains("sql") || value.Contains("database") || value.Contains("sonnet")) return DependencyCriticality.Critical;
        if (value.Contains("redis") || value.Contains("cache")) return DependencyCriticality.Degradable;
        return DependencyCriticality.Optional;
    }

    private static string ReasonCode(string name)
        => Classify(name) == DependencyCriticality.Critical ? "SQL_CONNECTION_FAILED" : "DEPENDENCY_CHECK_FAILED";

    private static string Impact(string name)
        => Classify(name) == DependencyCriticality.Critical
            ? "Core telemetry persistence may be unavailable"
            : "Optional telemetry or integration capability is degraded";
}
