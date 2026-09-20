using IoTSharp.Extensions;
using IoTSharp.EventBus;
using IoTSharp.Services.RuleDispatch;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MQTTnet;
using MQTTnet.Protocol;
using MQTTnet.Server;
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.Ingestion;

public sealed class GatewayFlowControlOptions
{
    public const string SectionName = "GatewayFlowControl";
    public bool Enabled { get; set; } = true;
    public bool RequireCapability { get; set; } = true;
    public string Capability { get; set; } = "flow-control-v1";
    public int EvaluationIntervalMilliseconds { get; set; } = 2000;
    public int RefreshIntervalSeconds { get; set; } = 60;
    public double DegradedQueueUtilization { get; set; } = 0.80;
    public double SevereQueueUtilization { get; set; } = 0.95;
    public double DegradedPersistenceLagSeconds { get; set; } = 5;
    public double SeverePersistenceLagSeconds { get; set; } = 20;
    public int NormalTelemetryMaxRate { get; set; } = 0;
    public int NormalBatchMaxPoints { get; set; } = 2000;
    public int DegradedTelemetryMaxRate { get; set; } = 50_000;
    public int DegradedBatchMaxPoints { get; set; } = 1000;
    public int DegradedDelayMilliseconds { get; set; } = 50;
    public int SevereTelemetryMaxRate { get; set; } = 20_000;
    public int SevereBatchMaxPoints { get; set; } = 500;
    public int SevereDelayMilliseconds { get; set; } = 200;
}

public sealed class GatewayFlowControlHint
{
    public int Version { get; init; } = 1;
    public string GatewayId { get; init; } = string.Empty;
    public string Mode { get; init; } = "normal";
    public int TelemetryMaxRate { get; init; }
    public int BatchMaxPoints { get; init; }
    public int RecommendedDelayMs { get; init; }
    public bool ReliableEventsAffected { get; init; } = false;
    public string Reason { get; init; } = string.Empty;
    public long Timestamp { get; init; }
}

public sealed record GatewayFlowControlSnapshot(
    string Mode,
    double QueueUtilization,
    double PersistenceLagSeconds,
    int PersistenceInFlightBatches,
    int EligibleGateways,
    long PublishedHints,
    long PublishFailures);

internal enum GatewayFlowControlMode
{
    Normal,
    Degraded,
    Severe
}

internal sealed record GatewayFlowControlDecision(
    GatewayFlowControlMode Mode,
    int TelemetryMaxRate,
    int BatchMaxPoints,
    int RecommendedDelayMs,
    double QueueUtilization,
    string Reason);

public sealed class GatewayFlowControlService : BackgroundService
{
    private const string FlowTopicPrefix = "gateway/";
    private const string FlowTopicSuffix = "/control/flow";
    private readonly MqttServer _mqttServer;
    private readonly GatewayRuntimeRegistry _registry;
    private readonly TelemetryIngestPipeline _telemetry;
    private readonly TelemetryRuleDispatchPipeline _rules;
    private readonly TelemetryPersistenceMonitor _persistence;
    private readonly GatewayFlowControlOptions _options;
    private readonly ILogger<GatewayFlowControlService> _logger;
    private readonly ConcurrentDictionary<Guid, LastHint> _lastHints = new();
    private long _publishedHints;
    private long _publishFailures;
    private int _eligibleGateways;
    private volatile string _mode = "normal";
    private double _queueUtilization;
    private double _persistenceLagSeconds;
    private int _persistenceInFlightBatches;

    public GatewayFlowControlService(
        MqttServer mqttServer,
        GatewayRuntimeRegistry registry,
        TelemetryIngestPipeline telemetry,
        TelemetryRuleDispatchPipeline rules,
        EventBusOption eventBusOption,
        IOptions<GatewayFlowControlOptions> options,
        ILogger<GatewayFlowControlService> logger)
    {
        _mqttServer = mqttServer;
        _registry = registry;
        _telemetry = telemetry;
        _rules = rules;
        _persistence = eventBusOption.TelemetryPersistence;
        _options = Normalize(options.Value);
        _logger = logger;
        _mqttServer.ClientSubscribedTopicAsync += OnClientSubscribedTopicAsync;
    }

    public GatewayFlowControlSnapshot GetSnapshot()
        => new(
            _mode,
            Volatile.Read(ref _queueUtilization),
            Volatile.Read(ref _persistenceLagSeconds),
            Volatile.Read(ref _persistenceInFlightBatches),
            Volatile.Read(ref _eligibleGateways),
            Interlocked.Read(ref _publishedHints),
            Interlocked.Read(ref _publishFailures));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await EvaluateAndPublishAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Gateway flow control evaluation failed.");
            }

            await Task.Delay(_options.EvaluationIntervalMilliseconds, stoppingToken);
        }
    }

    private async Task EvaluateAndPublishAsync(CancellationToken cancellationToken)
    {
        var decision = EvaluateCurrentDecision();

        var gateways = _registry.GetSnapshots()
            .Where(item => item.Connected && item.Status != GatewayRuntimeStatus.Offline)
            .Where(item => !_options.RequireCapability || item.Capabilities.Any(cap => cap.Equals(_options.Capability, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
        Volatile.Write(ref _eligibleGateways, gateways.Length);
        var now = DateTime.UtcNow;

        foreach (var gateway in gateways)
        {
            var gatewayKey = string.IsNullOrWhiteSpace(gateway.GatewayName) ? gateway.GatewayId.ToString("D") : gateway.GatewayName;
            var fingerprint = $"{decision.Mode}:{decision.TelemetryMaxRate}:{decision.BatchMaxPoints}:{decision.RecommendedDelayMs}";
            var last = _lastHints.GetOrAdd(gateway.GatewayId, static _ => new LastHint());
            lock (last)
            {
                if (string.Equals(last.Fingerprint, fingerprint, StringComparison.Ordinal)
                    && now - last.SentAtUtc < TimeSpan.FromSeconds(_options.RefreshIntervalSeconds))
                    continue;
            }

            var hint = new GatewayFlowControlHint
            {
                GatewayId = gatewayKey,
                Mode = decision.Mode.ToString().ToLowerInvariant(),
                TelemetryMaxRate = decision.TelemetryMaxRate,
                BatchMaxPoints = decision.BatchMaxPoints,
                RecommendedDelayMs = decision.RecommendedDelayMs,
                ReliableEventsAffected = false,
                Reason = decision.Reason,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
            var message = new MqttApplicationMessageBuilder()
                .WithTopic($"gateway/{gatewayKey}/control/flow")
                .WithPayload(JsonSerializer.SerializeToUtf8Bytes(hint))
                .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithRetainFlag(true)
                .Build();
            try
            {
                await _mqttServer.InjectApplicationMessage(
                    new InjectedMqttApplicationMessage(message)
                    {
                        SenderClientId = "iotsharp-flow-control"
                    },
                    cancellationToken);
                lock (last)
                {
                    last.Fingerprint = fingerprint;
                    last.SentAtUtc = now;
                }
                Interlocked.Increment(ref _publishedHints);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Interlocked.Increment(ref _publishFailures);
                _logger.LogWarning(ex, "Failed to publish flow-control hint. Gateway={GatewayId}, Mode={Mode}", gatewayKey, decision.Mode);
            }
        }
    }

    private async Task OnClientSubscribedTopicAsync(ClientSubscribedTopicEventArgs eventArgs)
    {
        if (!_options.Enabled)
            return;

        var topic = eventArgs.TopicFilter?.Topic;
        if (string.IsNullOrWhiteSpace(topic)
            || !topic.StartsWith(FlowTopicPrefix, StringComparison.OrdinalIgnoreCase)
            || !topic.EndsWith(FlowTopicSuffix, StringComparison.OrdinalIgnoreCase))
            return;

        var gatewayKeyLength = topic.Length - FlowTopicPrefix.Length - FlowTopicSuffix.Length;
        if (gatewayKeyLength <= 0)
            return;

        var gatewayKey = topic.Substring(FlowTopicPrefix.Length, gatewayKeyLength);
        if (string.IsNullOrWhiteSpace(gatewayKey) || gatewayKey.Contains('/'))
            return;

        var decision = EvaluateCurrentDecision();
        var hint = new GatewayFlowControlHint
        {
            GatewayId = gatewayKey,
            Mode = decision.Mode.ToString().ToLowerInvariant(),
            TelemetryMaxRate = decision.TelemetryMaxRate,
            BatchMaxPoints = decision.BatchMaxPoints,
            RecommendedDelayMs = decision.RecommendedDelayMs,
            ReliableEventsAffected = false,
            Reason = decision.Reason,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
        var message = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(JsonSerializer.SerializeToUtf8Bytes(hint))
            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
            .WithRetainFlag(true)
            .Build();

        try
        {
            await _mqttServer.InjectApplicationMessage(
                new InjectedMqttApplicationMessage(message)
                {
                    SenderClientId = "iotsharp-flow-control"
                });
            Interlocked.Increment(ref _publishedHints);
        }
        catch (Exception ex)
        {
            Interlocked.Increment(ref _publishFailures);
            _logger.LogWarning(ex, "Failed to publish initial flow-control hint. Gateway={GatewayId}, Mode={Mode}", gatewayKey, decision.Mode);
        }
    }

    private GatewayFlowControlDecision EvaluateCurrentDecision()
    {
        var telemetry = _telemetry.GetSnapshot();
        var rules = _rules.GetSnapshot();
        var telemetryUtilization = Utilization(telemetry.QueueDepth, telemetry.Capacity);
        var ruleUtilization = Utilization(rules.QueueDepth, rules.Capacity);
        var persistence = _persistence.GetSnapshot();
        var decision = EvaluatePersistenceAware(
            Math.Max(telemetryUtilization, ruleUtilization),
            telemetryUtilization,
            ruleUtilization,
            persistence.LagSeconds,
            _options);
        _mode = decision.Mode.ToString().ToLowerInvariant();
        Volatile.Write(ref _queueUtilization, decision.QueueUtilization);
        Volatile.Write(ref _persistenceLagSeconds, persistence.LagSeconds);
        Volatile.Write(ref _persistenceInFlightBatches, persistence.InFlightBatches);
        return decision;
    }

    internal static GatewayFlowControlDecision Evaluate(
        double utilization,
        double telemetryUtilization,
        double ruleUtilization,
        GatewayFlowControlOptions options)
        => EvaluatePersistenceAware(utilization, telemetryUtilization, ruleUtilization, 0d, options);

    internal static GatewayFlowControlDecision EvaluatePersistenceAware(
        double utilization,
        double telemetryUtilization,
        double ruleUtilization,
        double persistenceLagSeconds,
        GatewayFlowControlOptions options)
    {
        var normalized = Normalize(options);
        var value = Math.Clamp(utilization, 0d, 1d);
        var lag = Math.Max(0d, persistenceLagSeconds);
        var reason = $"ingest_queue={Math.Clamp(telemetryUtilization, 0d, 1d):F3};rules_queue={Math.Clamp(ruleUtilization, 0d, 1d):F3};persistence_lag_seconds={lag:F3}";
        if (value >= normalized.SevereQueueUtilization || lag >= normalized.SeverePersistenceLagSeconds)
            return new GatewayFlowControlDecision(GatewayFlowControlMode.Severe, normalized.SevereTelemetryMaxRate, normalized.SevereBatchMaxPoints, normalized.SevereDelayMilliseconds, value, reason);
        if (value >= normalized.DegradedQueueUtilization || lag >= normalized.DegradedPersistenceLagSeconds)
            return new GatewayFlowControlDecision(GatewayFlowControlMode.Degraded, normalized.DegradedTelemetryMaxRate, normalized.DegradedBatchMaxPoints, normalized.DegradedDelayMilliseconds, value, reason);
        return new GatewayFlowControlDecision(GatewayFlowControlMode.Normal, normalized.NormalTelemetryMaxRate, normalized.NormalBatchMaxPoints, 0, value, reason);
    }

    private static double Utilization(long depth, long capacity)
        => capacity <= 0 ? 0d : Math.Clamp((double)depth / capacity, 0d, 1d);

    private static GatewayFlowControlOptions Normalize(GatewayFlowControlOptions source)
    {
        source ??= new GatewayFlowControlOptions();
        var degraded = Math.Clamp(source.DegradedQueueUtilization, 0.10, 0.98);
        var severe = Math.Clamp(source.SevereQueueUtilization, degraded + 0.01, 1.0);
        var degradedLagSeconds = Math.Max(0.1, source.DegradedPersistenceLagSeconds);
        var severeLagSeconds = Math.Max(degradedLagSeconds + 0.1, source.SeverePersistenceLagSeconds);
        return new GatewayFlowControlOptions
        {
            Enabled = source.Enabled,
            RequireCapability = source.RequireCapability,
            Capability = string.IsNullOrWhiteSpace(source.Capability) ? "flow-control-v1" : source.Capability,
            EvaluationIntervalMilliseconds = Math.Max(250, source.EvaluationIntervalMilliseconds),
            RefreshIntervalSeconds = Math.Max(10, source.RefreshIntervalSeconds),
            DegradedQueueUtilization = degraded,
            SevereQueueUtilization = severe,
            DegradedPersistenceLagSeconds = degradedLagSeconds,
            SeverePersistenceLagSeconds = severeLagSeconds,
            NormalTelemetryMaxRate = Math.Max(0, source.NormalTelemetryMaxRate),
            NormalBatchMaxPoints = Math.Max(1, source.NormalBatchMaxPoints),
            DegradedTelemetryMaxRate = Math.Max(1, source.DegradedTelemetryMaxRate),
            DegradedBatchMaxPoints = Math.Max(1, source.DegradedBatchMaxPoints),
            DegradedDelayMilliseconds = Math.Max(0, source.DegradedDelayMilliseconds),
            SevereTelemetryMaxRate = Math.Max(1, source.SevereTelemetryMaxRate),
            SevereBatchMaxPoints = Math.Max(1, source.SevereBatchMaxPoints),
            SevereDelayMilliseconds = Math.Max(0, source.SevereDelayMilliseconds)
        };
    }

    private sealed class LastHint
    {
        public string Fingerprint { get; set; } = string.Empty;
        public DateTime SentAtUtc { get; set; }
    }
}
