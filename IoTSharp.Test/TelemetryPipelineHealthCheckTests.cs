using IoTSharp.Health;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Xunit;

namespace IoTSharp.Test;

public sealed class TelemetryPipelineHealthCheckTests
{
    [Theory]
    [InlineData(0.0, HealthStatus.Healthy)]
    [InlineData(0.79, HealthStatus.Healthy)]
    [InlineData(0.80, HealthStatus.Degraded)]
    [InlineData(0.97, HealthStatus.Degraded)]
    [InlineData(0.98, HealthStatus.Unhealthy)]
    [InlineData(1.0, HealthStatus.Unhealthy)]
    public void EvaluateStatus_UsesDefaultQueueThresholds(double utilization, HealthStatus expected)
    {
        var status = TelemetryPipelineHealthCheck.EvaluateStatus(
            utilization,
            new TelemetryPipelineHealthOptions());

        Assert.Equal(expected, status);
    }

    [Fact]
    public void EvaluateStatus_NormalizesInvalidCustomThresholdOrdering()
    {
        var options = new TelemetryPipelineHealthOptions
        {
            DegradedQueueUtilization = 0.90,
            UnhealthyQueueUtilization = 0.50
        };

        Assert.Equal(HealthStatus.Healthy, TelemetryPipelineHealthCheck.EvaluateStatus(0.89, options));
        Assert.Equal(HealthStatus.Unhealthy, TelemetryPipelineHealthCheck.EvaluateStatus(0.90, options));
    }
}
