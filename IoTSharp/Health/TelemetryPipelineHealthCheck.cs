using IoTSharp.Services.RuleDispatch;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Health;

public sealed class TelemetryPipelineHealthOptions
{
    public const string SectionName = "TelemetryPipelineHealth";

    public double DegradedQueueUtilization { get; set; } = 0.80;
    public double UnhealthyQueueUtilization { get; set; } = 0.98;
}

public sealed class TelemetryPipelineHealthCheck : IHealthCheck
{
    private readonly TelemetryIngestPipeline _ingest;
    private readonly TelemetryRuleDispatchPipeline _rules;
    private readonly TelemetryPipelineHealthOptions _options;

    public TelemetryPipelineHealthCheck(
        TelemetryIngestPipeline ingest,
        TelemetryRuleDispatchPipeline rules,
        IOptions<TelemetryPipelineHealthOptions> options)
    {
        _ingest = ingest;
        _rules = rules;
        _options = Normalize(options.Value);
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        var ingest = _ingest.GetSnapshot();
        var rules = _rules.GetSnapshot();
        var ingestUtilization = Utilization(ingest.QueueDepth, ingest.Capacity);
        var ruleUtilization = Utilization(rules.QueueDepth, rules.Capacity);
        var maxUtilization = Math.Max(ingestUtilization, ruleUtilization);
        var status = EvaluateStatus(maxUtilization, _options);

        var data = new Dictionary<string, object>
        {
            ["ingest.queueDepth"] = ingest.QueueDepth,
            ["ingest.capacity"] = ingest.Capacity,
            ["ingest.pendingWriters"] = ingest.PendingWriters,
            ["ingest.utilization"] = ingestUtilization,
            ["ingest.enqueued"] = ingest.EnqueuedMessages,
            ["ingest.publishedMessages"] = ingest.PublishedMessages,
            ["ingest.publishedBatches"] = ingest.PublishedBatches,
            ["ingest.failures"] = ingest.PublishFailures,
            ["ingest.backpressureWaits"] = ingest.BackpressureWaits,
            ["rules.queueDepth"] = rules.QueueDepth,
            ["rules.capacity"] = rules.Capacity,
            ["rules.pendingWriters"] = rules.PendingWriters,
            ["rules.utilization"] = ruleUtilization,
            ["rules.enqueued"] = rules.Enqueued,
            ["rules.processed"] = rules.Processed,
            ["rules.failures"] = rules.Failed,
            ["rules.backpressureWaits"] = rules.BackpressureWaits
        };

        var description = $"Telemetry queues: ingest={ingest.QueueDepth}/{ingest.Capacity}, rules={rules.QueueDepth}/{rules.Capacity}.";
        return Task.FromResult(new HealthCheckResult(status, description, data: data));
    }

    internal static HealthStatus EvaluateStatus(double utilization, TelemetryPipelineHealthOptions options)
    {
        var normalized = Normalize(options);
        if (utilization >= normalized.UnhealthyQueueUtilization)
        {
            return HealthStatus.Unhealthy;
        }
        if (utilization >= normalized.DegradedQueueUtilization)
        {
            return HealthStatus.Degraded;
        }
        return HealthStatus.Healthy;
    }

    private static double Utilization(long queueDepth, long capacity)
        => capacity <= 0 ? 0d : Math.Clamp((double)queueDepth / capacity, 0d, 1d);

    private static TelemetryPipelineHealthOptions Normalize(TelemetryPipelineHealthOptions source)
    {
        var degraded = Math.Clamp(source.DegradedQueueUtilization, 0.01, 0.99);
        var unhealthy = Math.Clamp(source.UnhealthyQueueUtilization, degraded, 1.0);
        return new TelemetryPipelineHealthOptions
        {
            DegradedQueueUtilization = degraded,
            UnhealthyQueueUtilization = unhealthy
        };
    }
}
