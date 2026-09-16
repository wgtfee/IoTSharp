using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace IoTSharp.Services.Ingestion;

public sealed class GatewayOwnershipOptions
{
    public const string SectionName = "GatewayOwnership";
    public string NodeId { get; set; } = string.Empty;
    public int LeaseSeconds { get; set; } = 60;
}

public sealed record GatewayOwnershipLease(
    Guid GatewayId,
    string NodeId,
    DateTime AcquiredAtUtc,
    DateTime LastRenewedAtUtc,
    DateTime ExpiresAtUtc);

public sealed class InMemoryGatewayOwnershipStore
{
    internal ConcurrentDictionary<Guid, GatewayOwnershipLease> Leases { get; } = new();
}

/// <summary>
/// Gateway 到平台节点的归属抽象。默认实现只在当前进程内协调；未来多实例部署可以替换实现，
/// 而不改变 MQTT/Gateway 接入链路。Redis/Kafka 不属于默认依赖。
/// </summary>
public interface IGatewayOwnershipRegistry
{
    string LocalNodeId { get; }
    GatewayOwnershipLease Claim(Guid gatewayId);
    bool Release(Guid gatewayId);
    bool TryGet(Guid gatewayId, out GatewayOwnershipLease lease);
    IReadOnlyList<GatewayOwnershipLease> GetSnapshots();
}

public sealed class InMemoryGatewayOwnershipRegistry : IGatewayOwnershipRegistry
{
    private readonly InMemoryGatewayOwnershipStore _store;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _leaseDuration;

    public InMemoryGatewayOwnershipRegistry(IOptions<GatewayOwnershipOptions> options)
        : this(options, new InMemoryGatewayOwnershipStore(), TimeProvider.System)
    {
    }

    public InMemoryGatewayOwnershipRegistry(
        IOptions<GatewayOwnershipOptions> options,
        InMemoryGatewayOwnershipStore store)
        : this(options, store, TimeProvider.System)
    {
    }

    public InMemoryGatewayOwnershipRegistry(
        IOptions<GatewayOwnershipOptions> options,
        InMemoryGatewayOwnershipStore store,
        TimeProvider timeProvider)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _timeProvider = timeProvider ?? TimeProvider.System;
        var configured = options.Value?.NodeId?.Trim();
        var environment = Environment.GetEnvironmentVariable("IOTSHARP_NODE_ID")?.Trim();
        LocalNodeId = !string.IsNullOrWhiteSpace(configured)
            ? configured
            : !string.IsNullOrWhiteSpace(environment)
                ? environment
                : $"{Environment.MachineName}:{Environment.ProcessId}";
        _leaseDuration = TimeSpan.FromSeconds(Math.Max(5, options.Value?.LeaseSeconds ?? 60));
    }

    public string LocalNodeId { get; }

    public GatewayOwnershipLease Claim(Guid gatewayId)
    {
        while (true)
        {
            var now = _timeProvider.GetUtcNow().UtcDateTime;
            if (!_store.Leases.TryGetValue(gatewayId, out var current))
            {
                var created = NewLease(gatewayId, now);
                if (_store.Leases.TryAdd(gatewayId, created)) return created;
                continue;
            }

            if (!string.Equals(current.NodeId, LocalNodeId, StringComparison.Ordinal)
                && current.ExpiresAtUtc > now)
            {
                return current;
            }

            var replacement = string.Equals(current.NodeId, LocalNodeId, StringComparison.Ordinal)
                ? current with { LastRenewedAtUtc = now, ExpiresAtUtc = now.Add(_leaseDuration) }
                : NewLease(gatewayId, now);
            if (_store.Leases.TryUpdate(gatewayId, replacement, current)) return replacement;
        }
    }

    public bool Release(Guid gatewayId)
    {
        while (_store.Leases.TryGetValue(gatewayId, out var current))
        {
            if (!string.Equals(current.NodeId, LocalNodeId, StringComparison.Ordinal)) return false;
            if (RemoveExact(gatewayId, current)) return true;
        }
        return false;
    }

    public bool TryGet(Guid gatewayId, out GatewayOwnershipLease lease)
    {
        while (_store.Leases.TryGetValue(gatewayId, out var current))
        {
            var now = _timeProvider.GetUtcNow().UtcDateTime;
            if (current.ExpiresAtUtc > now)
            {
                lease = current;
                return true;
            }
            RemoveExact(gatewayId, current);
        }

        lease = null!;
        return false;
    }

    public IReadOnlyList<GatewayOwnershipLease> GetSnapshots()
    {
        var now = _timeProvider.GetUtcNow().UtcDateTime;
        var active = new List<GatewayOwnershipLease>();
        foreach (var pair in _store.Leases)
        {
            if (pair.Value.ExpiresAtUtc > now)
                active.Add(pair.Value);
            else
                RemoveExact(pair.Key, pair.Value);
        }
        return active.OrderBy(item => item.GatewayId).ToArray();
    }

    private GatewayOwnershipLease NewLease(Guid gatewayId, DateTime now)
        => new(gatewayId, LocalNodeId, now, now, now.Add(_leaseDuration));

    private bool RemoveExact(Guid gatewayId, GatewayOwnershipLease lease)
        => ((ICollection<KeyValuePair<Guid, GatewayOwnershipLease>>)_store.Leases)
            .Remove(new KeyValuePair<Guid, GatewayOwnershipLease>(gatewayId, lease));
}
