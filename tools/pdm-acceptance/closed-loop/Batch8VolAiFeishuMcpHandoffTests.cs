using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PdM.Acceptance.ClosedLoop;

public sealed class Batch8VolAiFeishuMcpHandoffTests
{
    private static readonly DateTimeOffset Now =
        new(2026, 11, 14, 5, 0, 0, TimeSpan.Zero);
    private static PdmFieldAlertNotification Alert() => new(
        Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), 3,
        "verified-real-rule-episode", new string('a', 64), PdmRiskLevel.Warning,
        Now.AddMinutes(-15), true, true, true, true);
    private static PdmVolAiFeishuRoute Route(PdmFieldAlertNotification a) => new(
        a.TenantId, a.CustomerId,
        "configured-account-id", "oc_abcdefghijklmnopqrstuvwxyz012345",
        Guid.NewGuid(), Now.AddMinutes(-3), true);

    [Fact]
    public void VerifiedFieldAlertUsesExistingMcpToolAndStableIdempotencyKey()
    {
        var alert = Alert();
        var route = Route(alert);
        var first = PdmVolAiFeishuMcpHandoffFactory.Prepare(alert, route, Now);
        var again = PdmVolAiFeishuMcpHandoffFactory.Prepare(alert, route, Now);
        Assert.Equal(first, again);
        Assert.Equal("send_feishu_message", first.ToolName);
        Assert.Equal("iotsharp-pdm:" + alert.ProposalKey, first.DeliveryKey);
        Assert.Equal(77, first.DeliveryKey.Length);
        Assert.Equal(first.DeliveryKey, first.ToolArguments()["delivery_key"]);
        Assert.Equal(route.ChannelAccountId, first.ToolArguments()["account_id"]);
        Assert.Equal(route.ExternalConversationId, first.ToolArguments()["chat_id"]);
        Assert.DoesNotContain(alert.TenantId.ToString("N"), first.Content);
        Assert.DoesNotContain(alert.CustomerId.ToString("N"), first.Content);
        Assert.False(first.IsDeliveryConfirmed);
        Assert.False(first.IsExternalWorkOrderCreated);
    }

    [Fact]
    public void RefusesSyntheticOrUnreviewedOrOtherTenantOrCustomer()
    {
        var alert = Alert(); var route = Route(alert);
        foreach (var invalid in new[]
        {
            alert with { IsSynthetic = true },
            alert with { SourceIsRealFieldTelemetry = false },
            alert with { ApprovalGateSatisfied = false },
            alert with { PhysicalSensorMappingsApproved = false },
            alert with { OperatingStateApproved = false },
            alert with { ProposalKey = "bad" }
        })
            Assert.Throws<InvalidOperationException>(() =>
                PdmVolAiFeishuMcpHandoffFactory.Prepare(invalid, route, Now));
        Assert.Throws<InvalidOperationException>(() =>
            PdmVolAiFeishuMcpHandoffFactory.Prepare(
                alert, route with { TenantId = Guid.NewGuid() }, Now));
        Assert.Throws<InvalidOperationException>(() =>
            PdmVolAiFeishuMcpHandoffFactory.Prepare(
                alert, route with { CustomerId = Guid.NewGuid() }, Now));
    }

    [Fact]
    public void DoesNotUseLastSeenConversationOrStaleUnapprovedRoute()
    {
        var alert = Alert(); var route = Route(alert);
        foreach (var invalid in new[]
        {
            route with { ApprovedAtUtc = Now.AddDays(-31) },
            route with { Enabled = false },
            route with { ExternalConversationId = "" },
            route with { ExternalConversationId = "ou_some_direct_user" },
            route with { ApprovedBy = Guid.Empty }
        })
            Assert.Throws<InvalidOperationException>(() =>
                PdmVolAiFeishuMcpHandoffFactory.Prepare(alert, invalid, Now));
    }

    [Fact]
    public void OldWindowsFutureEventsAndLocalOffsetsCannotBeSentAsCurrent()
    {
        var alert = Alert(); var route = Route(alert);
        Assert.Throws<InvalidOperationException>(() =>
            PdmVolAiFeishuMcpHandoffFactory.Prepare(
                alert with { WindowEndUtc = Now.AddDays(-2) }, route, Now));
        Assert.Throws<InvalidOperationException>(() =>
            PdmVolAiFeishuMcpHandoffFactory.Prepare(
                alert with { WindowEndUtc = Now.AddMinutes(10) }, route, Now));
        Assert.Throws<InvalidOperationException>(() =>
            PdmVolAiFeishuMcpHandoffFactory.Prepare(
                alert, route, Now.ToOffset(TimeSpan.FromHours(8))));
    }
}
