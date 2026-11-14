using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>
/// Opt-in actual SQL Server test; NEVER runs against the IOTSharp business DB.
/// Enable for local machine only: PDM_LOCAL_SQLSERVER_E2E=1
/// Database must already exist and have reviewed V001 migration installed.
/// </summary>
public sealed class Batch9LocalSqlServerE2ETests
{
    [Fact]
    public async Task VerifiedRiskCreatesInternalWorkOrderAndFeishuOutboxInDedicatedSqlServer()
    {
        if (Environment.GetEnvironmentVariable("PDM_LOCAL_SQLSERVER_E2E") != "1")
            return;
        const string connection = "Server=.\\MSSQ;Database=IoTSharpPdmDev;Integrated Security=True;TrustServerCertificate=True;Pooling=False";
        var options = new DbContextOptionsBuilder<PdmInternalWorkOrderDbContext>()
            .UseSqlServer(connection).Options;
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        await using var db = new PdmInternalWorkOrderDbContext(options);
        var service = new PdmInternalWorkOrderService(db);
        var at = new DateTime(2026, 11, 14, 6, 0, 0, DateTimeKind.Utc);
        var profile = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = Guid.NewGuid(),
            Version = 1, Enabled = true, PointMappingsVerified = true,
            RunStateVerified = true, RunStateTelemetryKey = "verified-run",
            MinimumCoverageRatio = .8
        };
        var risk = new PdmRiskEvent
        {
            TenantId = tenant, CustomerId = customer, DeviceId = profile.DeviceId,
            ProfileId = profile.Id, ProfileVersion = 1,
            RiskType = "device-health", RiskLevel = "Warning", Status = "Open",
            OccurrenceCount = 3, EventKey = "real-sqlserver-isolated-regression",
            EvidenceJson = "{\"rule\":\"demo-unit-test-only\"}",
            FirstObservedUtc = at.AddMinutes(-30), LastObservedUtc = at,
            LastEvaluatedWindowEndUtc = at
        };
        var snapshot = new PdmHealthSnapshot
        {
            TenantId = tenant, CustomerId = customer, DeviceId = profile.DeviceId,
            ProfileId = profile.Id, ProfileVersion = 1,
            WindowStartUtc = at.AddMinutes(-15), WindowEndUtc = at,
            RiskLevel = "Warning", DataQuality = "Good",
            HealthIndex = 51, CoverageRatio = 1, EvaluatedPointCount = 2
        };
        try
        {
            var order = await service.OpenFromVerifiedRiskAsync(profile, risk, snapshot);
            Assert.Equal("Open", order.State);
            Assert.Equal(order.Id, (await service.OpenFromVerifiedRiskAsync(
                profile, risk, snapshot)).Id);
            var saved = await db.WorkOrders.AsNoTracking().SingleAsync(
                x => x.TenantId == tenant && x.CustomerId == customer);
            Assert.Equal(order.WorkOrderNo, saved.WorkOrderNo);
            Assert.Equal(1, await db.Notifications.CountAsync(
                x => x.TenantId == tenant && x.CustomerId == customer &&
                     x.WorkOrderId == order.Id && x.State == "Pending"));
            var manager = Guid.NewGuid(); var tech = Guid.NewGuid();
            Assert.Equal("Assigned", (await service.TransitionAsync(tenant,customer,
                order.Id,1,"Assign",manager,tech,"隔离开发库测试分配")).State);
            Assert.Equal("InProgress", (await service.TransitionAsync(tenant,customer,
                order.Id,2,"Start",tech,null,"隔离开发库测试开始")).State);
            Assert.Equal("Completed", (await service.TransitionAsync(tenant,customer,
                order.Id,3,"Complete",tech,null,"隔离开发库测试维修结果")).State);
            Assert.Equal("Closed", (await service.TransitionAsync(tenant,customer,
                order.Id,4,"Close",manager,null,"隔离开发库测试验收")).State);
            Assert.Equal(5, await db.Audits.CountAsync(
                x => x.TenantId == tenant && x.CustomerId == customer));
        }
        finally
        {
            await db.Audits.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await db.Notifications.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
            await db.WorkOrders.Where(x => x.TenantId == tenant &&
                x.CustomerId == customer).ExecuteDeleteAsync();
        }
    }
}
