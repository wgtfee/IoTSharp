using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>
/// Dedicated local SQL Server real persistence test. Data is deliberately
/// TEST-FIXTURE and must never be promoted as real equipment evidence.
/// This uses an in-process fake Feishu tool only: NOT a real external send.
/// </summary>
public sealed class Batch10LocalSqlServerFullChainTests
{
    private const string DevConnection =
        "Server=.\\MSSQ;Database=IoTSharpPdmDev;Integrated Security=True;TrustServerCertificate=True;Pooling=False";

    private sealed class FakeManagedFeishu : IPdmManagedFeishuMcpSender
    {
        public int Calls { get; private set; }

        public Task<PdmManagedFeishuSendResult> SendAsync(
            PdmVolAiFeishuMcpHandoff message, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Contains("IoTSharp 内部维修工单", message.Content);
            Assert.Equal("send_feishu_message", message.ToolName);
            Assert.StartsWith("iotsharp-wo:", message.DeliveryKey);
            return Task.FromResult(new PdmManagedFeishuSendResult(true, new string('b', 64)));
        }
    }

    [Fact]
    public async Task FullSqlServerProfileRiskAutoOrderOutboxFakeFeishuAndReconciliation()
    {
        if (Environment.GetEnvironmentVariable("PDM_LOCAL_SQLSERVER_E2E") != "1")
            return;

        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var device = Guid.NewGuid();
        var at = new DateTime(2026, 11, 14, 6, 0, 0, DateTimeKind.Utc);
        var metadataOptions = new DbContextOptionsBuilder<PdmDbContext>()
            .UseSqlServer(DevConnection).Options;
        var orderOptions = new DbContextOptionsBuilder<PdmInternalWorkOrderDbContext>()
            .UseSqlServer(DevConnection).Options;
        await using var source = new PdmDbContext(metadataOptions);
        await using var localOrders = new PdmInternalWorkOrderDbContext(orderOptions);
        var orders = new PdmInternalWorkOrderService(localOrders);
        var profile = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device,
            Version = 1, Enabled = true,
            PointMappingsVerified = true, RunStateVerified = true,
            RunStateTelemetryKey = "test-only-run-state",
            MinimumCoverageRatio = 0.8
        };
        var eventId = Guid.NewGuid();

        try
        {
            source.DeviceProfiles.Add(profile);
            source.HealthSnapshots.Add(new PdmHealthSnapshot
            {
                TenantId = tenant, CustomerId = customer,
                DeviceId = device, ProfileId = profile.Id, ProfileVersion = 1,
                WindowStartUtc = at.AddMinutes(-15), WindowEndUtc = at,
                RiskLevel = "Warning", DataQuality = "Good",
                HealthIndex = 45, CoverageRatio = 1, EvaluatedPointCount = 2,
                ExplanationJson = "{\"fixture\":\"integration-test-not-field-data\"}"
            });
            source.RiskEvents.Add(new PdmRiskEvent
            {
                Id = eventId, TenantId = tenant, CustomerId = customer,
                DeviceId = device, ProfileId = profile.Id, ProfileVersion = 1,
                EventKey = Guid.NewGuid().ToString("N"), RiskType = "device-health",
                RiskLevel = "Warning", Status = "Open", OccurrenceCount = 3,
                FirstObservedUtc = at.AddMinutes(-30), LastObservedUtc = at,
                LastEvaluatedWindowEndUtc = at,
                EvidenceJson = "{\"fixture\":\"integration-test-not-field-data\"}"
            });
            await source.SaveChangesAsync();

            // An actual SQL Server round-trip, using the exact automatic
            // creator called by the opt-in P1 Evaluation Worker.
            var creator = new PdmInternalWorkOrderAutoCreator(source, orders);
            var first = await creator.AfterCommittedWindowAsync(profile.Id, new DateTimeOffset(at));
            Assert.NotNull(first);
            Assert.Equal("Open", first.State);
            var duplicate = await creator.AfterCommittedWindowAsync(profile.Id, new DateTimeOffset(at));
            Assert.Equal(first.Id, duplicate?.Id);

            var notification = await localOrders.Notifications.AsNoTracking().SingleAsync(
                x => x.TenantId == tenant && x.CustomerId == customer);
            Assert.Equal("Pending", notification.State);
            var sender = new FakeManagedFeishu();
            var dispatcher = new PdmInternalWorkOrderFeishuDispatcher(localOrders, orders, sender);
            var route = new PdmVolAiFeishuRoute(
                tenant, customer, "fake-feishu-account",
                "oc_integrationtestfixture00000000000000000",
                Guid.NewGuid(), DateTimeOffset.UtcNow, true);
            var firstSend = await dispatcher.DispatchOneAsync(
                tenant, customer, notification.Id, Guid.NewGuid(), route,
                DateTimeOffset.UtcNow);
            Assert.True(firstSend.Confirmed);
            var repeatedSend = await dispatcher.DispatchOneAsync(
                tenant, customer, notification.Id, Guid.NewGuid(), route,
                DateTimeOffset.UtcNow);
            Assert.False(repeatedSend.Claimed);
            Assert.Equal(1, sender.Calls);
            Assert.Equal("Confirmed", (await localOrders.Notifications.AsNoTracking()
                .SingleAsync(x => x.TenantId == tenant)).State);
            Assert.Equal(1, await localOrders.WorkOrders.AsNoTracking()
                .CountAsync(x => x.TenantId == tenant));
            Assert.Equal(1, await localOrders.Audits.AsNoTracking()
                .CountAsync(x => x.TenantId == tenant));
        }
        finally
        {
            // Only randomized test-tenant rows are deleted; parent / main
            // IOTSharp DB is never used or modified.
            await localOrders.Audits.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await localOrders.Notifications.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await localOrders.WorkOrders.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await source.HealthSnapshots.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await source.RiskEvents.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await source.DeviceProfiles.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
        }
    }
}
