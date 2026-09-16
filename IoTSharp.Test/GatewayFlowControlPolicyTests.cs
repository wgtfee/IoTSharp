using IoTSharp.Services.Ingestion;
using Xunit;

namespace IoTSharp.Test;

public sealed class GatewayFlowControlPolicyTests
{
    [Theory]
    [InlineData(0.79, "Normal")]
    [InlineData(0.80, "Degraded")]
    [InlineData(0.94, "Degraded")]
    [InlineData(0.95, "Severe")]
    [InlineData(1.00, "Severe")]
    public void Evaluate_UsesConfiguredPressureBands(double utilization, string expected)
    {
        var decision = GatewayFlowControlService.Evaluate(utilization, utilization, 0.2, new GatewayFlowControlOptions());
        Assert.Equal(expected, decision.Mode.ToString());
    }

    [Fact]
    public void Evaluate_DegradedAndSevereReduceOnlyTelemetryHints()
    {
        var options = new GatewayFlowControlOptions();
        var degraded = GatewayFlowControlService.Evaluate(0.85, 0.85, 0.1, options);
        var severe = GatewayFlowControlService.Evaluate(0.98, 0.98, 0.2, options);

        Assert.Equal(50_000, degraded.TelemetryMaxRate);
        Assert.Equal(1000, degraded.BatchMaxPoints);
        Assert.Equal(50, degraded.RecommendedDelayMs);
        Assert.Equal(20_000, severe.TelemetryMaxRate);
        Assert.Equal(500, severe.BatchMaxPoints);
        Assert.Equal(200, severe.RecommendedDelayMs);
    }

    [Fact]
    public void Hint_ExplicitlyKeepsReliableEventsOutsideFlowControl()
    {
        var hint = new GatewayFlowControlHint();
        Assert.False(hint.ReliableEventsAffected);
    }
}
