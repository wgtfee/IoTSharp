using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

public sealed class Batch11ManagedFeishuMcpSenderTests
{
    private static PdmWorkOrderFeishuOptions LocalReadOnlyOptions() => new()
    {
        // The account/route values in this test are intentionally fictional.
        // The only operation is get_feishu_status; NO SEND TOOL IS CALLED.
        Enabled = true,
        RouteApproved = true,
        SingleInstanceAcknowledged = true,
        TenantId = Guid.NewGuid(),
        CustomerId = Guid.NewGuid(),
        ApprovedBy = Guid.NewGuid(),
        ApprovedAtUtc = DateTimeOffset.UtcNow,
        AccountId = "readonly-probe-placeholder",
        ChatId = "oc_readonlyprobefictional0000000000",
        ProviderExecutable = @"H:\code\Industrial.Platform\FeishuPushMCP\_audit_build\FeishuPushMcp.exe",
        ProviderWorkingDirectory = @"H:\code\Industrial.Platform\FeishuPushMCP",
        PollSeconds = 60, MaxPerCycle = 1, TimeoutSeconds = 25
    };

    [Fact]
    public void InvalidCommandsAndUnapprovedRoutesCannotBecomeLiveTransport()
    {
        var approved = LocalReadOnlyOptions();
        Assert.Throws<InvalidOperationException>(() =>
        {
            approved.ProviderExecutable = @"C:\Windows\System32\cmd.exe";
            approved.Validate();
        });
        var unapproved = LocalReadOnlyOptions();
        unapproved.RouteApproved = false;
        Assert.Throws<InvalidOperationException>(unapproved.Validate);
        var wrongAccount = LocalReadOnlyOptions();
        wrongAccount.ChatId = "ou_direct-user-is-not-approved-group";
        Assert.Throws<InvalidOperationException>(wrongAccount.Validate);
    }

    [Fact]
    public async Task ReadOnlyLocalMcpHandshakeCanQueryVolAiFeishuStatusWithoutSending()
    {
        if (Environment.GetEnvironmentVariable("PDM_LOCAL_FEISHU_READONLY") != "1")
            return;
        var settings = LocalReadOnlyOptions();
        settings.Validate();
        var sender = new PdmFeishuPushMcpSender(Options.Create(settings));
        Assert.True(await sender.IsProviderReadyAsync());
    }
}
