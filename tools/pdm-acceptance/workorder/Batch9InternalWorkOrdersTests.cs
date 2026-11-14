using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

public sealed class Batch9InternalWorkOrdersTests
{
    private sealed class FakeMcpSender(bool shouldThrow = false) : IPdmManagedFeishuMcpSender
    {
        public int Calls;
        public Task<PdmManagedFeishuSendResult> SendAsync(
            PdmVolAiFeishuMcpHandoff message, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal("send_feishu_message", message.ToolName);
            Assert.Equal(message.DeliveryKey, message.ToolArguments()["delivery_key"]);
            if (shouldThrow) throw new InvalidOperationException("Simulated uncertain provider outcome.");
            return Task.FromResult(new PdmManagedFeishuSendResult(true, new string('b',64)));
        }
    }

    private static readonly DateTime AtUtc = new(2026, 11, 14, 6, 0, 0, DateTimeKind.Utc);

    private sealed class Store : IAsyncDisposable
    {
        private readonly string _path = Path.Combine(Path.GetTempPath(),
            "pdm-internal-order-test-" + Guid.NewGuid().ToString("N") + ".sqlite");
        private readonly List<PdmInternalWorkOrderDbContext> _dbs = [];
        private readonly List<SqliteConnection> _connections = [];

        public async Task<(PdmInternalWorkOrderDbContext Db, PdmInternalWorkOrderService Service)>
            OpenAsync(bool initialize = false)
        {
            var connection = new SqliteConnection("Data Source=" + _path + ";Pooling=False");
            await connection.OpenAsync();
            _connections.Add(connection);
            var options = new DbContextOptionsBuilder<PdmInternalWorkOrderDbContext>()
                .UseSqlite(connection).Options;
            var db = new PdmInternalWorkOrderDbContext(options);
            _dbs.Add(db);
            if (initialize) await db.Database.EnsureCreatedAsync();
            return (db, new PdmInternalWorkOrderService(db));
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var db in _dbs) await db.DisposeAsync();
            foreach (var c in _connections) await c.DisposeAsync();
            if (File.Exists(_path)) File.Delete(_path);
        }
    }

    private static (
        PdmDeviceProfile Profile,
        PdmRiskEvent Risk,
        PdmHealthSnapshot Snapshot) VerifiedEvidence()
    {
        var p = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
            DeviceId = Guid.NewGuid(), Version = 1,
            Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
            RunStateTelemetryKey = "actual-runstate",
            MinimumCoverageRatio = .8
        };
        var e = new PdmRiskEvent
        {
            Id = Guid.NewGuid(),
            TenantId = p.TenantId, CustomerId = p.CustomerId,
            DeviceId = p.DeviceId, ProfileId = p.Id,
            ProfileVersion = p.Version, Status = "Open",
            EventKey = "field-rule-episode", RiskType = "device-health",
            RiskLevel = "Warning", OccurrenceCount = 2,
            EvidenceJson = "{\"rule\":\"vibration-high\"}",
            FirstObservedUtc = AtUtc.AddMinutes(-30),
            LastObservedUtc = AtUtc,
            LastEvaluatedWindowEndUtc = AtUtc
        };
        var snap = new PdmHealthSnapshot
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId,
            DeviceId = p.DeviceId, ProfileId = p.Id,
            ProfileVersion = p.Version, WindowStartUtc = AtUtc.AddMinutes(-15),
            WindowEndUtc = AtUtc, RiskLevel = "Warning", DataQuality = "Good",
            CoverageRatio = 1, HealthIndex = 48, EvaluatedPointCount = 2
        };
        return (p,e,snap);
    }

    [Fact]
    public async Task CreatesLocalOrderAndNotificationAtomicallyAndSurvivesRestart()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        var original = await service.OpenFromVerifiedRiskAsync(p,e,s);
        Assert.Equal("Open", original.State);
        Assert.StartsWith("PM-", original.WorkOrderNo);
        Assert.Equal(p.DeviceId, original.DeviceId);
        Assert.Equal(1, await db.WorkOrders.CountAsync());
        Assert.Equal(1, await db.Notifications.CountAsync());
        Assert.Equal("Pending", (await db.Notifications.SingleAsync()).State);
        Assert.Equal(1, await db.Audits.CountAsync());
        Assert.Equal(original.Id, (await service.OpenFromVerifiedRiskAsync(p,e,s)).Id);

        var (afterRestartDb, newService) = await store.OpenAsync();
        Assert.Equal(original.Id, (await newService.GetAsync(p.TenantId,p.CustomerId,original.Id))!.Id);
        Assert.Equal(1, await afterRestartDb.WorkOrders.CountAsync());
        Assert.Equal(1, await afterRestartDb.Notifications.CountAsync());
    }

    [Fact]
    public async Task WorkOrderIsIndependentOfFeishuAndSupportsRealStateManagement()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        var created = await service.OpenFromVerifiedRiskAsync(p,e,s);
        var manager = Guid.NewGuid();
        var technician = Guid.NewGuid();
        var assigned = await service.TransitionAsync(p.TenantId,p.CustomerId,created.Id,
            1,"Assign",manager,technician,"安排现场检查");
        Assert.Equal("Assigned",assigned.State);
        Assert.Equal(technician,assigned.AssignedTo);
        var running = await service.TransitionAsync(p.TenantId,p.CustomerId,created.Id,
            2,"Start",technician,null,"现场确认");
        Assert.Equal("InProgress", running.State);
        var completed = await service.TransitionAsync(p.TenantId,p.CustomerId,created.Id,
            3,"Complete",technician,null,"更换轴承并检测振动恢复");
        Assert.Equal("Completed",completed.State);
        Assert.Contains("轴承",completed.Resolution);
        var closed = await service.TransitionAsync(p.TenantId,p.CustomerId,created.Id,
            4,"Close",manager,null,"主管验收");
        Assert.Equal("Closed", closed.State);
        Assert.NotNull(closed.ClosedAtUtc);
        Assert.Equal(5, await db.Audits.CountAsync());
        // Feishu failure does not roll back the local repair order.
        Assert.Equal("Pending",(await db.Notifications.SingleAsync()).State);
    }

    [Fact]
    public async Task InvalidTransitionsCrossTenantAndReplayedVersionNeverMutate()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        var order = await service.OpenFromVerifiedRiskAsync(p,e,s);
        await Assert.ThrowsAsync<KeyNotFoundException>(() =>
            service.TransitionAsync(Guid.NewGuid(), p.CustomerId,order.Id,
                1,"Assign",Guid.NewGuid(),Guid.NewGuid(),"forbidden"));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.TransitionAsync(p.TenantId,p.CustomerId,order.Id,
                1,"Close",Guid.NewGuid(),null,"cannot close open"));
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() =>
            service.TransitionAsync(p.TenantId,p.CustomerId,order.Id,
                999,"Assign",Guid.NewGuid(),Guid.NewGuid(),"stale version"));
        Assert.Null(await service.GetAsync(Guid.NewGuid(),p.CustomerId,order.Id));
        Assert.Equal("Open",(await db.WorkOrders.AsNoTracking().SingleAsync()).State);
        Assert.Equal(1,await db.Audits.CountAsync());
    }

    [Fact]
    public async Task SyntheticUnverifiedUnknownOrInsufficientOccurrenceCannotOpenOrder()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        foreach (var broken in new[]
        {
            withRisk("Unknown"),
            withRisk("Normal"),
            withRisk("Warning", occurrences:1),
            withRisk("Warning", evidence:"{\"source\":\"SYNTHETIC\"}")
        })
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                service.OpenFromVerifiedRiskAsync(p,broken,s));
        p.PointMappingsVerified = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.OpenFromVerifiedRiskAsync(p,e,s));
        p.PointMappingsVerified = true;
        s.DataQuality = "Unknown";
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.OpenFromVerifiedRiskAsync(p,e,s));
        Assert.Equal(0, await db.WorkOrders.CountAsync());

        PdmRiskEvent withRisk(string risk, int occurrences=2, string? evidence=null) => new()
        {
            Id=e.Id, TenantId=e.TenantId, CustomerId=e.CustomerId, DeviceId=e.DeviceId,
            ProfileId=e.ProfileId, ProfileVersion=e.ProfileVersion,
            EventKey=e.EventKey, RiskType=e.RiskType, Status=e.Status,
            RiskLevel=risk, OccurrenceCount=occurrences,
            EvidenceJson=evidence??e.EvidenceJson,
            FirstObservedUtc=e.FirstObservedUtc,
            LastEvaluatedWindowEndUtc=e.LastEvaluatedWindowEndUtc
        };
    }

    [Fact]
    public async Task FeishuJournalNeverDuplicatesClaimsAndUnknownCannotBeRetried()
    {
        await using var store = new Store();
        var (db,service) = await store.OpenAsync(initialize:true);
        var (p,e,s) = VerifiedEvidence();
        var order = await service.OpenFromVerifiedRiskAsync(p,e,s);
        var notice = await db.Notifications.AsNoTracking().SingleAsync();
        var owner = Guid.NewGuid();
        Assert.True(await service.ClaimFeishuNotificationAsync(
            p.TenantId,p.CustomerId,notice.Id,owner));
        Assert.False(await service.ClaimFeishuNotificationAsync(
            p.TenantId,p.CustomerId,notice.Id,Guid.NewGuid()));
        var claimed = await db.Notifications.AsNoTracking().SingleAsync();
        var route = new PdmVolAiFeishuRoute(p.TenantId,p.CustomerId,
            "feishu-account","oc_abcdefghijklmnopqrstuvwxyz012345",
            Guid.NewGuid(),DateTimeOffset.UtcNow,true);
        var handoff = PdmInternalWorkOrderService.PrepareFeishuNotification(
            order,claimed,route,DateTimeOffset.UtcNow);
        Assert.Equal("send_feishu_message",handoff.ToolName);
        Assert.Equal(notice.DeliveryKey,handoff.DeliveryKey);
        Assert.Contains(order.WorkOrderNo,handoff.Content);
        Assert.False(handoff.IsDeliveryConfirmed);
        Assert.False(handoff.IsExternalWorkOrderCreated);
        Assert.True(await service.RecordFeishuResultAsync(
            p.TenantId,p.CustomerId,notice.Id,owner,false,""));
        Assert.False(await service.ClaimFeishuNotificationAsync(
            p.TenantId,p.CustomerId,notice.Id,Guid.NewGuid()));
        Assert.Equal("OutcomeUnknown",
            (await db.Notifications.AsNoTracking().SingleAsync()).State);
        Assert.Equal(1,await db.WorkOrders.CountAsync());
    }

    [Fact]
    public void ProductionConfigurationDefaultsOffAndRejectsMainSqlServerDatabase()
    {
        var disabled = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string,string?>()).Build();
        var services = new ServiceCollection();
        services.AddPdmInternalWorkOrders(disabled);
        Assert.DoesNotContain(services, x => x.ServiceType == typeof(PdmInternalWorkOrderService));
        var bad = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>
        {
            ["PredictiveMaintenance:Enabled"]="true",
            ["PredictiveMaintenance:SchemaReady"]="true",
            ["PredictiveMaintenance:SingleInstanceAcknowledged"]="true",
            ["PredictiveMaintenance:PointMappingsApproved"]="true",
            ["PredictiveMaintenance:HistoryQueryPlanApproved"]="true",
            ["PredictiveMaintenance:HistoryUtcContractApproved"]="true",
            ["PredictiveMaintenance:WorkOrders:Enabled"]="true",
            ["PredictiveMaintenance:WorkOrders:SchemaReady"]="true",
            ["ConnectionStrings:PdmWorkOrders"]="Server=.;Database=IOTSharp;Integrated Security=true;TrustServerCertificate=true"
        }).Build();
        Assert.Throws<InvalidOperationException>(() =>
            new ServiceCollection().AddPdmInternalWorkOrders(bad));
    }

    [Fact]
    public async Task ManagedFeishuProviderAcceptsExactlyOneClaimAndKeepsOrderPersistent()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        var order = await service.OpenFromVerifiedRiskAsync(p,e,s);
        var notice = await db.Notifications.AsNoTracking().SingleAsync();
        var fake = new FakeMcpSender();
        var dispatcher = new PdmInternalWorkOrderFeishuDispatcher(db,service,fake);
        var route = new PdmVolAiFeishuRoute(p.TenantId,p.CustomerId,
            "verified-account","oc_abcdefghijklmnopqrstuvwxyz012345",
            Guid.NewGuid(),DateTimeOffset.UtcNow,true);
        var first = await dispatcher.DispatchOneAsync(
            p.TenantId,p.CustomerId,notice.Id,Guid.NewGuid(),route,DateTimeOffset.UtcNow);
        Assert.True(first.Confirmed);
        Assert.True(first.Claimed);
        Assert.Equal("Confirmed",
            (await db.Notifications.AsNoTracking().SingleAsync()).State);
        var second = await dispatcher.DispatchOneAsync(
            p.TenantId,p.CustomerId,notice.Id,Guid.NewGuid(),route,DateTimeOffset.UtcNow);
        Assert.False(second.Claimed);
        Assert.Equal(1,fake.Calls);
        Assert.Equal(1,await db.WorkOrders.CountAsync());
        Assert.Equal(order.Id,(await db.WorkOrders.AsNoTracking().SingleAsync()).Id);
    }

    [Fact]
    public async Task UnknownFeishuOutcomeBlocksSecondSendAndNeverDeletesLocalWorkOrder()
    {
        await using var store = new Store();
        var (db, service) = await store.OpenAsync(initialize: true);
        var (p,e,s) = VerifiedEvidence();
        await service.OpenFromVerifiedRiskAsync(p,e,s);
        var notice = await db.Notifications.AsNoTracking().SingleAsync();
        var fake = new FakeMcpSender(true);
        var dispatcher = new PdmInternalWorkOrderFeishuDispatcher(db,service,fake);
        var route = new PdmVolAiFeishuRoute(p.TenantId,p.CustomerId,
            "verified-account","oc_abcdefghijklmnopqrstuvwxyz012345",
            Guid.NewGuid(),DateTimeOffset.UtcNow,true);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            dispatcher.DispatchOneAsync(p.TenantId,p.CustomerId,notice.Id,
                Guid.NewGuid(),route,DateTimeOffset.UtcNow));
        Assert.Equal("OutcomeUnknown",
            (await db.Notifications.AsNoTracking().SingleAsync()).State);
        var retry = await dispatcher.DispatchOneAsync(
            p.TenantId,p.CustomerId,notice.Id,Guid.NewGuid(),route,DateTimeOffset.UtcNow);
        Assert.False(retry.Claimed);
        Assert.Equal(1,fake.Calls);
        Assert.Equal(1,await db.WorkOrders.CountAsync());
    }
}
