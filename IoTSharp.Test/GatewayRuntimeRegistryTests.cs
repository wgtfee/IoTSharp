using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Health;
using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class GatewayRuntimeRegistryTests
{
    [Fact]
    public void Registry_TracksConnectDisconnectAndRecovery()
    {
        var registry = Registry();
        var gateway = Gateway();
        registry.MarkConnected(gateway);
        Assert.Equal(GatewayRuntimeStatus.Healthy, registry.GetSnapshots().Single().Status);

        registry.MarkDisconnected(gateway);
        Assert.Equal(GatewayRuntimeStatus.Offline, registry.GetSnapshots().Single().Status);

        registry.MarkConnected(gateway);
        Assert.Equal(GatewayRuntimeStatus.Recovering, registry.GetSnapshots().Single().Status);

        registry.TouchBatch(gateway, 10, 1000);
        Assert.Equal(GatewayRuntimeStatus.Healthy, registry.GetSnapshots().Single().Status);
    }

    [Fact]
    public async Task Registry_HealthBacklogCanDegradeGatewayWithoutTakingPlatformDown()
    {
        var registry = Registry(pendingThreshold: 100);
        var gateway = Gateway();
        registry.MarkConnected(gateway);
        registry.UpdateHealth(gateway, new GatewayHealthReport
        {
            Version = 1,
            GatewayId = gateway.Name,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            PendingCount = 101,
            IoTSharpState = "Healthy"
        });

        Assert.Equal(GatewayRuntimeStatus.Degraded, registry.GetSnapshots().Single().Status);
        var check = new GatewayRuntimeRegistryHealthCheck(registry);
        var result = await check.CheckHealthAsync(new HealthCheckContext());
        Assert.Equal(HealthStatus.Healthy, result.Status);
        Assert.Equal(1, result.Data["gateway.degraded"]);
    }

    [Fact]
    public void EvaluateStatus_UsesFreshnessOnlyAfterHealthOrBatchCapabilityIsSeen()
    {
        var options = RegistryOptions();
        var now = new DateTime(2026, 9, 15, 6, 0, 0, DateTimeKind.Utc);
        var legacy = new GatewayRuntimeSnapshot { Connected = true, LastSeenUtc = now.AddHours(-1) };
        Assert.Equal(GatewayRuntimeStatus.Healthy, GatewayRuntimeRegistry.EvaluateStatus(legacy, now, options));

        var stale = new GatewayRuntimeSnapshot { Connected = true, LastSeenUtc = now, LastHealthAtUtc = now.AddSeconds(-50) };
        Assert.Equal(GatewayRuntimeStatus.Degraded, GatewayRuntimeRegistry.EvaluateStatus(stale, now, options));

        var offline = new GatewayRuntimeSnapshot { Connected = true, LastSeenUtc = now, LastBatchAtUtc = now.AddSeconds(-130) };
        Assert.Equal(GatewayRuntimeStatus.Offline, GatewayRuntimeRegistry.EvaluateStatus(offline, now, options));
    }

    [Fact]
    public void HealthValidator_AuthenticatesGatewayAndPayloadIdentity()
    {
        var gateway = Gateway();
        var json = $"{{\"version\":1,\"gatewayId\":\"{gateway.Name}\",\"timestamp\":{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},\"pointCount\":1000}}";
        var valid = GatewayHealthValidator.Validate(Encoding.UTF8.GetBytes(json), gateway.Name, gateway, new GatewayHealthIngestOptions());
        Assert.True(valid.Success, valid.Error);

        var invalid = GatewayHealthValidator.Validate(Encoding.UTF8.GetBytes(json), "OTHER", gateway, new GatewayHealthIngestOptions());
        Assert.False(invalid.Success);
    }

    [Fact]
    public void Registry_DoesNotMutateRuntimeWhenAnotherNodeOwnsActiveLease()
    {
        var store = new InMemoryGatewayOwnershipStore();
        var gateway = Gateway();
        var nodeAOwnership = new InMemoryGatewayOwnershipRegistry(
            Microsoft.Extensions.Options.Options.Create(new GatewayOwnershipOptions { NodeId = "node-a", LeaseSeconds = 60 }), store);
        var nodeBOwnership = new InMemoryGatewayOwnershipRegistry(
            Microsoft.Extensions.Options.Options.Create(new GatewayOwnershipOptions { NodeId = "node-b", LeaseSeconds = 60 }), store);
        nodeAOwnership.Claim(gateway.Id);
        var registry = new GatewayRuntimeRegistry(
            Microsoft.Extensions.Options.Options.Create(RegistryOptions()),
            nodeBOwnership);

        Assert.False(registry.TouchBatch(gateway, 1, 10));
        Assert.False(registry.TouchActivity(gateway));
        Assert.False(registry.UpdateHealth(gateway, new GatewayHealthReport { Version = 1, GatewayId = gateway.Name }));
        Assert.Empty(registry.GetSnapshots());
        Assert.True(nodeAOwnership.TryGet(gateway.Id, out var lease));
        Assert.Equal("node-a", lease.NodeId);
    }

    private static GatewayRuntimeRegistry Registry(long pendingThreshold = 10_000)
        => new(
            Microsoft.Extensions.Options.Options.Create(RegistryOptions(pendingThreshold)),
            new InMemoryGatewayOwnershipRegistry(Microsoft.Extensions.Options.Options.Create(new GatewayOwnershipOptions { NodeId = "test-node" })));

    private static GatewayRuntimeRegistryOptions RegistryOptions(long pendingThreshold = 10_000) => new()
    {
        StaleAfterSeconds = 45,
        OfflineAfterSeconds = 120,
        RecoveringSeconds = 15,
        PendingDegradedThreshold = pendingThreshold,
        OldestPendingDegradedSeconds = 30
    };

    private static Device Gateway() => new()
    {
        Id = Guid.NewGuid(),
        Name = "GW-TEST",
        DeviceType = DeviceType.Gateway
    };
}
