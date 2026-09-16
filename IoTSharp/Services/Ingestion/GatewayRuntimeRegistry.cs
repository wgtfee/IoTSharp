using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace IoTSharp.Services.Ingestion;

public enum GatewayRuntimeStatus
{
    Healthy,
    Degraded,
    Offline,
    Recovering
}

public sealed class GatewayRuntimeRegistryOptions
{
    public const string SectionName = "GatewayRuntimeRegistry";
    public int StaleAfterSeconds { get; set; } = 45;
    public int OfflineAfterSeconds { get; set; } = 120;
    public int RecoveringSeconds { get; set; } = 15;
    public long PendingDegradedThreshold { get; set; } = 10_000;
    public int OldestPendingDegradedSeconds { get; set; } = 30;
}

public sealed class GatewayHealthIngestOptions
{
    public const string SectionName = "GatewayHealthIngest";
    public int Version { get; set; } = 1;
    public int MaxPayloadBytes { get; set; } = 64 * 1024;
}

public sealed class GatewayHealthReport
{
    public int Version { get; set; }
    public string GatewayId { get; set; } = string.Empty;
    public long Timestamp { get; set; }
    public string RuntimeVersion { get; set; } = string.Empty;
    public string[] Capabilities { get; set; } = [];
    public double? CpuPercent { get; set; }
    public long? MemoryBytes { get; set; }
    public long? PointCount { get; set; }
    public double? ScanRate { get; set; }
    public double? UploadRate { get; set; }
    public long? PendingCount { get; set; }
    public long? OldestPendingAgeMs { get; set; }
    public long? DiskBufferBytes { get; set; }
    public string RedisState { get; set; } = string.Empty;
    public string IoTSharpState { get; set; } = string.Empty;
    public string BacklogHint { get; set; } = string.Empty;
}

public sealed class GatewayRuntimeSnapshot
{
    public Guid GatewayId { get; init; }
    public string GatewayName { get; init; } = string.Empty;
    public string NodeId { get; init; } = string.Empty;
    public GatewayRuntimeStatus Status { get; init; }
    public bool Connected { get; init; }
    public DateTime? ConnectedAtUtc { get; init; }
    public DateTime LastSeenUtc { get; init; }
    public DateTime? LastHealthAtUtc { get; init; }
    public DateTime? LastBatchAtUtc { get; init; }
    public DateTime? RecoveringUntilUtc { get; init; }
    public string RuntimeVersion { get; init; } = string.Empty;
    public string[] Capabilities { get; init; } = [];
    public double? CpuPercent { get; init; }
    public long? MemoryBytes { get; init; }
    public long? PointCount { get; init; }
    public double? ScanRate { get; init; }
    public double? UploadRate { get; init; }
    public long? PendingCount { get; init; }
    public long? OldestPendingAgeMs { get; init; }
    public long? DiskBufferBytes { get; init; }
    public string RedisState { get; init; } = string.Empty;
    public string IoTSharpState { get; init; } = string.Empty;
    public string BacklogHint { get; init; } = string.Empty;
    public long LastBatchPoints { get; init; }
    public int LastBatchDevices { get; init; }
}

public sealed class GatewayRuntimeRegistry
{
    private readonly ConcurrentDictionary<Guid, RuntimeState> _states = new();
    private readonly GatewayRuntimeRegistryOptions _options;
    private readonly IGatewayOwnershipRegistry _ownership;

    public GatewayRuntimeRegistry(
        IOptions<GatewayRuntimeRegistryOptions> options,
        IGatewayOwnershipRegistry ownership)
    {
        _options = Normalize(options.Value);
        _ownership = ownership;
    }

    public bool TryClaimOwnership(Device gateway, out GatewayOwnershipLease lease)
    {
        lease = null!;
        if (!IsGateway(gateway)) return false;
        lease = _ownership.Claim(gateway.Id);
        return string.Equals(lease.NodeId, _ownership.LocalNodeId, StringComparison.Ordinal);
    }

    public bool MarkConnected(Device gateway)
    {
        if (!TryClaimOwnership(gateway, out _)) return false;
        var now = DateTime.UtcNow;
        var state = _states.GetOrAdd(gateway.Id, _ => new RuntimeState(gateway.Id));
        lock (state)
        {
            var wasConnected = state.Connected;
            var wasKnownAndDisconnected = state.Initialized && !state.Connected;
            state.Initialized = true;
            state.GatewayName = gateway.Name ?? state.GatewayName;
            state.Connected = true;
            if (!wasConnected) state.ConnectedAtUtc = now;
            state.LastSeenUtc = now;
            state.RecoveringUntilUtc = wasKnownAndDisconnected
                ? now.AddSeconds(_options.RecoveringSeconds)
                : null;
        }
        return true;
    }

    public bool MarkDisconnected(Device gateway)
    {
        if (!IsGateway(gateway)) return false;
        if (_ownership.TryGet(gateway.Id, out var lease)
            && !string.Equals(lease.NodeId, _ownership.LocalNodeId, StringComparison.Ordinal))
            return false;
        var state = _states.GetOrAdd(gateway.Id, _ => new RuntimeState(gateway.Id));
        lock (state)
        {
            state.Initialized = true;
            state.GatewayName = gateway.Name ?? state.GatewayName;
            state.Connected = false;
            state.LastSeenUtc = DateTime.UtcNow;
            state.RecoveringUntilUtc = null;
        }
        _ownership.Release(gateway.Id);
        return true;
    }

    public bool TouchActivity(Device gateway)
    {
        if (!TryClaimOwnership(gateway, out _)) return false;
        var state = _states.GetOrAdd(gateway.Id, _ => new RuntimeState(gateway.Id));
        lock (state)
        {
            var wasConnected = state.Connected;
            state.Initialized = true;
            state.GatewayName = gateway.Name ?? state.GatewayName;
            state.Connected = true;
            var now = DateTime.UtcNow;
            if (!wasConnected) state.ConnectedAtUtc = now;
            state.LastSeenUtc = now;
            state.RecoveringUntilUtc = null;
        }
        return true;
    }

    public bool TouchBatch(Device gateway, int deviceCount, long pointCount)
    {
        if (!TryClaimOwnership(gateway, out _)) return false;
        var now = DateTime.UtcNow;
        var state = _states.GetOrAdd(gateway.Id, _ => new RuntimeState(gateway.Id));
        lock (state)
        {
            var wasConnected = state.Connected;
            state.Initialized = true;
            state.GatewayName = gateway.Name ?? state.GatewayName;
            state.Connected = true;
            if (!wasConnected) state.ConnectedAtUtc = now;
            state.LastSeenUtc = now;
            state.LastBatchAtUtc = now;
            state.LastBatchDevices = Math.Max(0, deviceCount);
            state.LastBatchPoints = Math.Max(0, pointCount);
            state.RecoveringUntilUtc = null;
        }
        return true;
    }

    public bool UpdateHealth(Device gateway, GatewayHealthReport report)
    {
        if (!IsGateway(gateway)) return false;
        ArgumentNullException.ThrowIfNull(report);
        if (!TryClaimOwnership(gateway, out _)) return false;
        var now = DateTime.UtcNow;
        var state = _states.GetOrAdd(gateway.Id, _ => new RuntimeState(gateway.Id));
        lock (state)
        {
            var wasConnected = state.Connected;
            state.Initialized = true;
            state.GatewayName = gateway.Name ?? state.GatewayName;
            state.Connected = true;
            if (!wasConnected) state.ConnectedAtUtc = now;
            state.LastSeenUtc = now;
            // Freshness is based on platform receive time. Gateway clocks can drift and must not cause false degradation.
            state.LastHealthAtUtc = now;
            state.RuntimeVersion = report.RuntimeVersion ?? string.Empty;
            state.Capabilities = (report.Capabilities ?? []).Where(item => !string.IsNullOrWhiteSpace(item)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            state.CpuPercent = report.CpuPercent;
            state.MemoryBytes = report.MemoryBytes;
            state.PointCount = report.PointCount;
            state.ScanRate = report.ScanRate;
            state.UploadRate = report.UploadRate;
            state.PendingCount = report.PendingCount;
            state.OldestPendingAgeMs = report.OldestPendingAgeMs;
            state.DiskBufferBytes = report.DiskBufferBytes;
            state.RedisState = report.RedisState ?? string.Empty;
            state.IoTSharpState = report.IoTSharpState ?? string.Empty;
            state.BacklogHint = report.BacklogHint ?? string.Empty;
            state.RecoveringUntilUtc = null;
        }
        return true;
    }

    public IReadOnlyList<GatewayRuntimeSnapshot> GetSnapshots()
        => GetSnapshots(DateTime.UtcNow);

    internal IReadOnlyList<GatewayRuntimeSnapshot> GetSnapshots(DateTime utcNow)
        => _states.Values.Select(state => Snapshot(state, utcNow)).OrderBy(item => item.GatewayName).ThenBy(item => item.GatewayId).ToArray();

    public bool TryGetSnapshot(Guid gatewayId, out GatewayRuntimeSnapshot snapshot)
    {
        if (_states.TryGetValue(gatewayId, out var state))
        {
            snapshot = Snapshot(state, DateTime.UtcNow);
            return true;
        }
        snapshot = null;
        return false;
    }

    private GatewayRuntimeSnapshot Snapshot(RuntimeState state, DateTime utcNow)
    {
        lock (state)
        {
            var nodeId = _ownership.TryGet(state.GatewayId, out var ownership)
                ? ownership.NodeId
                : _ownership.LocalNodeId;
            var raw = new GatewayRuntimeSnapshot
            {
                GatewayId = state.GatewayId,
                GatewayName = state.GatewayName,
                NodeId = nodeId,
                Connected = state.Connected,
                ConnectedAtUtc = state.ConnectedAtUtc,
                LastSeenUtc = state.LastSeenUtc,
                LastHealthAtUtc = state.LastHealthAtUtc,
                LastBatchAtUtc = state.LastBatchAtUtc,
                RecoveringUntilUtc = state.RecoveringUntilUtc,
                RuntimeVersion = state.RuntimeVersion,
                Capabilities = state.Capabilities.ToArray(),
                CpuPercent = state.CpuPercent,
                MemoryBytes = state.MemoryBytes,
                PointCount = state.PointCount,
                ScanRate = state.ScanRate,
                UploadRate = state.UploadRate,
                PendingCount = state.PendingCount,
                OldestPendingAgeMs = state.OldestPendingAgeMs,
                DiskBufferBytes = state.DiskBufferBytes,
                RedisState = state.RedisState,
                IoTSharpState = state.IoTSharpState,
                BacklogHint = state.BacklogHint,
                LastBatchDevices = state.LastBatchDevices,
                LastBatchPoints = state.LastBatchPoints
            };
            return new GatewayRuntimeSnapshot
            {
                GatewayId = raw.GatewayId,
                GatewayName = raw.GatewayName,
                NodeId = raw.NodeId,
                Status = EvaluateStatus(raw, utcNow, _options),
                Connected = raw.Connected,
                ConnectedAtUtc = raw.ConnectedAtUtc,
                LastSeenUtc = raw.LastSeenUtc,
                LastHealthAtUtc = raw.LastHealthAtUtc,
                LastBatchAtUtc = raw.LastBatchAtUtc,
                RecoveringUntilUtc = raw.RecoveringUntilUtc,
                RuntimeVersion = raw.RuntimeVersion,
                Capabilities = raw.Capabilities,
                CpuPercent = raw.CpuPercent,
                MemoryBytes = raw.MemoryBytes,
                PointCount = raw.PointCount,
                ScanRate = raw.ScanRate,
                UploadRate = raw.UploadRate,
                PendingCount = raw.PendingCount,
                OldestPendingAgeMs = raw.OldestPendingAgeMs,
                DiskBufferBytes = raw.DiskBufferBytes,
                RedisState = raw.RedisState,
                IoTSharpState = raw.IoTSharpState,
                BacklogHint = raw.BacklogHint,
                LastBatchDevices = raw.LastBatchDevices,
                LastBatchPoints = raw.LastBatchPoints
            };
        }
    }

    internal static GatewayRuntimeStatus EvaluateStatus(GatewayRuntimeSnapshot snapshot, DateTime utcNow, GatewayRuntimeRegistryOptions options)
    {
        var normalized = Normalize(options);
        if (!snapshot.Connected) return GatewayRuntimeStatus.Offline;
        if (snapshot.RecoveringUntilUtc.HasValue && snapshot.RecoveringUntilUtc.Value > utcNow)
            return GatewayRuntimeStatus.Recovering;

        var freshnessSignal = Latest(snapshot.LastHealthAtUtc, snapshot.LastBatchAtUtc);
        if (freshnessSignal.HasValue)
        {
            var age = utcNow - freshnessSignal.Value;
            if (age >= TimeSpan.FromSeconds(normalized.OfflineAfterSeconds)) return GatewayRuntimeStatus.Offline;
            if (age >= TimeSpan.FromSeconds(normalized.StaleAfterSeconds)) return GatewayRuntimeStatus.Degraded;
        }

        if (snapshot.PendingCount.GetValueOrDefault() >= normalized.PendingDegradedThreshold
            || snapshot.OldestPendingAgeMs.GetValueOrDefault() >= normalized.OldestPendingDegradedSeconds * 1000L)
            return GatewayRuntimeStatus.Degraded;
        if (IsNonHealthy(snapshot.IoTSharpState)) return GatewayRuntimeStatus.Degraded;
        return GatewayRuntimeStatus.Healthy;
    }

    private static DateTime? Latest(DateTime? left, DateTime? right)
        => !left.HasValue ? right : !right.HasValue ? left : left > right ? left : right;

    private static bool IsNonHealthy(string state)
        => !string.IsNullOrWhiteSpace(state)
           && !state.Equals("Healthy", StringComparison.OrdinalIgnoreCase)
           && !state.Equals("Connected", StringComparison.OrdinalIgnoreCase)
           && !state.Equals("Online", StringComparison.OrdinalIgnoreCase);

    private static bool IsGateway(Device device) => device?.DeviceType == DeviceType.Gateway;

    private static bool TryGetReportedAt(long unixMilliseconds, out DateTime utc)
    {
        utc = default;
        if (unixMilliseconds <= 0) return false;
        try
        {
            utc = DateTimeOffset.FromUnixTimeMilliseconds(unixMilliseconds).UtcDateTime;
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static GatewayRuntimeRegistryOptions Normalize(GatewayRuntimeRegistryOptions source)
    {
        var stale = Math.Max(5, source?.StaleAfterSeconds ?? 45);
        var offline = Math.Max(stale + 5, source?.OfflineAfterSeconds ?? 120);
        return new GatewayRuntimeRegistryOptions
        {
            StaleAfterSeconds = stale,
            OfflineAfterSeconds = offline,
            RecoveringSeconds = Math.Max(0, source?.RecoveringSeconds ?? 15),
            PendingDegradedThreshold = Math.Max(1, source?.PendingDegradedThreshold ?? 10_000),
            OldestPendingDegradedSeconds = Math.Max(1, source?.OldestPendingDegradedSeconds ?? 30)
        };
    }

    private sealed class RuntimeState
    {
        public RuntimeState(Guid gatewayId) => GatewayId = gatewayId;
        public Guid GatewayId { get; }
        public bool Initialized { get; set; }
        public string GatewayName { get; set; } = string.Empty;
        public bool Connected { get; set; }
        public DateTime? ConnectedAtUtc { get; set; }
        public DateTime LastSeenUtc { get; set; }
        public DateTime? LastHealthAtUtc { get; set; }
        public DateTime? LastBatchAtUtc { get; set; }
        public DateTime? RecoveringUntilUtc { get; set; }
        public string RuntimeVersion { get; set; } = string.Empty;
        public string[] Capabilities { get; set; } = [];
        public double? CpuPercent { get; set; }
        public long? MemoryBytes { get; set; }
        public long? PointCount { get; set; }
        public double? ScanRate { get; set; }
        public double? UploadRate { get; set; }
        public long? PendingCount { get; set; }
        public long? OldestPendingAgeMs { get; set; }
        public long? DiskBufferBytes { get; set; }
        public string RedisState { get; set; } = string.Empty;
        public string IoTSharpState { get; set; } = string.Empty;
        public string BacklogHint { get; set; } = string.Empty;
        public int LastBatchDevices { get; set; }
        public long LastBatchPoints { get; set; }
    }
}

internal sealed record GatewayHealthValidationResult(bool Success, string Error, GatewayHealthReport Report)
{
    public static GatewayHealthValidationResult Fail(string error) => new(false, error, null);
}

internal static class GatewayHealthValidator
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString
    };

    internal static GatewayHealthValidationResult Validate(
        ReadOnlyMemory<byte> payload,
        string routeGatewayId,
        Device sessionGateway,
        GatewayHealthIngestOptions options)
    {
        ArgumentNullException.ThrowIfNull(sessionGateway);
        ArgumentNullException.ThrowIfNull(options);
        var maxBytes = Math.Max(1024, options.MaxPayloadBytes);
        if (payload.Length == 0) return GatewayHealthValidationResult.Fail("Gateway health payload is empty.");
        if (payload.Length > maxBytes) return GatewayHealthValidationResult.Fail($"Gateway health payload exceeds {maxBytes} bytes.");
        if (sessionGateway.DeviceType != DeviceType.Gateway) return GatewayHealthValidationResult.Fail("MQTT session is not a gateway.");
        if (!MatchesGateway(routeGatewayId, sessionGateway)) return GatewayHealthValidationResult.Fail("Route gatewayId does not match authenticated gateway.");

        GatewayHealthReport report;
        try { report = JsonSerializer.Deserialize<GatewayHealthReport>(payload.Span, JsonOptions); }
        catch (JsonException ex) { return GatewayHealthValidationResult.Fail($"Gateway health JSON is invalid: {ex.Message}"); }
        if (report is null) return GatewayHealthValidationResult.Fail("Gateway health JSON is empty.");
        if (report.Version != Math.Max(1, options.Version)) return GatewayHealthValidationResult.Fail($"Unsupported gateway health version {report.Version}.");
        if (string.IsNullOrWhiteSpace(report.GatewayId) || !string.Equals(routeGatewayId, report.GatewayId, StringComparison.OrdinalIgnoreCase))
            return GatewayHealthValidationResult.Fail("Payload gatewayId does not match route gatewayId.");
        return new GatewayHealthValidationResult(true, string.Empty, report);
    }

    private static bool MatchesGateway(string gatewayId, Device gateway)
        => !string.IsNullOrWhiteSpace(gatewayId)
           && (string.Equals(gatewayId, gateway.Name, StringComparison.OrdinalIgnoreCase)
               || string.Equals(gatewayId, gateway.Id.ToString("D"), StringComparison.OrdinalIgnoreCase)
               || string.Equals(gatewayId, gateway.Id.ToString("N"), StringComparison.OrdinalIgnoreCase));
}
