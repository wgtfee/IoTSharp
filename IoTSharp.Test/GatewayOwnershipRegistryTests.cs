using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Options;
using System;
using System.Threading;
using Xunit;

namespace IoTSharp.Test;

public sealed class GatewayOwnershipRegistryTests
{
    [Fact]
    public void Claim_IsIdempotentAndRenewsSameLocalOwner()
    {
        var registry = Create("node-a");
        var gatewayId = Guid.NewGuid();
        var first = registry.Claim(gatewayId);
        Thread.Sleep(2);
        var second = registry.Claim(gatewayId);

        Assert.Equal("node-a", first.NodeId);
        Assert.Equal(first.AcquiredAtUtc, second.AcquiredAtUtc);
        Assert.True(second.LastRenewedAtUtc >= first.LastRenewedAtUtc);
        Assert.Single(registry.GetSnapshots());
    }

    [Fact]
    public void Release_RemovesOwnership()
    {
        var registry = Create("node-a");
        var gatewayId = Guid.NewGuid();
        registry.Claim(gatewayId);

        Assert.True(registry.Release(gatewayId));
        Assert.False(registry.TryGet(gatewayId, out _));
    }

    [Fact]
    public void ConfiguredNodeId_IsUsedAsStableOwnerIdentity()
    {
        var registry = Create("platform-node-01");
        Assert.Equal("platform-node-01", registry.LocalNodeId);
    }

    [Fact]
    public void ActiveForeignLease_CannotBeStolenOrReleasedByAnotherNode()
    {
        var store = new InMemoryGatewayOwnershipStore();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 15, 6, 0, 0, TimeSpan.Zero));
        var nodeA = Create("node-a", store, clock);
        var nodeB = Create("node-b", store, clock);
        var gatewayId = Guid.NewGuid();

        var first = nodeA.Claim(gatewayId);
        var denied = nodeB.Claim(gatewayId);

        Assert.Equal("node-a", first.NodeId);
        Assert.Equal("node-a", denied.NodeId);
        Assert.False(nodeB.Release(gatewayId));
        Assert.True(nodeA.TryGet(gatewayId, out var current));
        Assert.Equal("node-a", current.NodeId);
    }

    [Fact]
    public void ExpiredLease_CanBeTakenOverByAnotherNode()
    {
        var store = new InMemoryGatewayOwnershipStore();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 15, 6, 0, 0, TimeSpan.Zero));
        var nodeA = Create("node-a", store, clock, leaseSeconds: 5);
        var nodeB = Create("node-b", store, clock, leaseSeconds: 5);
        var gatewayId = Guid.NewGuid();
        var first = nodeA.Claim(gatewayId);

        clock.Advance(TimeSpan.FromSeconds(6));
        var takeover = nodeB.Claim(gatewayId);

        Assert.Equal("node-b", takeover.NodeId);
        Assert.True(takeover.AcquiredAtUtc > first.AcquiredAtUtc);
        Assert.True(nodeB.Release(gatewayId));
        Assert.False(nodeA.TryGet(gatewayId, out _));
    }

    [Fact]
    public void SameOwner_RenewsExpiryWithoutChangingAcquiredTime()
    {
        var store = new InMemoryGatewayOwnershipStore();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 15, 6, 0, 0, TimeSpan.Zero));
        var node = Create("node-a", store, clock, leaseSeconds: 10);
        var gatewayId = Guid.NewGuid();
        var first = node.Claim(gatewayId);
        clock.Advance(TimeSpan.FromSeconds(3));
        var renewed = node.Claim(gatewayId);

        Assert.Equal(first.AcquiredAtUtc, renewed.AcquiredAtUtc);
        Assert.True(renewed.LastRenewedAtUtc > first.LastRenewedAtUtc);
        Assert.True(renewed.ExpiresAtUtc > first.ExpiresAtUtc);
    }

    private static InMemoryGatewayOwnershipRegistry Create(string nodeId)
        => new(Options.Create(new GatewayOwnershipOptions { NodeId = nodeId }));

    private static InMemoryGatewayOwnershipRegistry Create(
        string nodeId,
        InMemoryGatewayOwnershipStore store,
        TimeProvider timeProvider,
        int leaseSeconds = 60)
        => new(Options.Create(new GatewayOwnershipOptions { NodeId = nodeId, LeaseSeconds = leaseSeconds }), store, timeProvider);

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;
        public override DateTimeOffset GetUtcNow() => _utcNow;
        public void Advance(TimeSpan value) => _utcNow = _utcNow.Add(value);
    }
}
