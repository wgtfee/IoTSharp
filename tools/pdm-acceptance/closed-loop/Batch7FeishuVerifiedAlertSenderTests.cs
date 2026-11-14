using System.Net;
using System.Text;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PdM.Acceptance.ClosedLoop;

public sealed class Batch7FeishuVerifiedAlertSenderTests
{
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send)
        : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(send(request));
        }
    }

    private static PdmFieldAlertNotification Valid() => new(
        Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
        Guid.NewGuid(), 1, "verified-field-episode", new string('c', 64),
        PdmRiskLevel.Warning, new DateTimeOffset(2026, 11, 14, 5, 0, 0, TimeSpan.Zero),
        true, true, true, true);

    private static Uri Webhook() =>
        new("https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaaaaaaaaaaaaaaaaaa");

    [Fact]
    public async Task OfficialWebhookAcceptsOnlyVerifiedFieldRulePayloadAndNeverCreatesWorkOrder()
    {
        var handler = new Handler(req =>
        {
            Assert.Equal(HttpMethod.Post, req.Method);
            Assert.Equal("open.feishu.cn", req.RequestUri!.Host);
            var body = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            Assert.Contains("IoTSharp", body);
            Assert.DoesNotContain("work_order_id", body);
            Assert.Contains("msg_type", body);
            return new(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"code\":0,\"msg\":\"success\"}",
                    Encoding.UTF8, "application/json")
            };
        });
        var sender = new PdmFeishuVerifiedAlertSender(new HttpClient(handler));
        var receipt = await sender.SendAsync(Webhook(), Valid());
        Assert.True(receipt.FeishuAccepted);
        Assert.False(receipt.IsExternalWorkOrderCreated);
        Assert.False(receipt.IsIoTSharpAlarmPersisted);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task SyntheticEventsAndUnapprovedMapsOrStatesNeverGoOut()
    {
        var handler = new Handler(_ => throw new Exception("Should not be called."));
        var sender = new PdmFeishuVerifiedAlertSender(new HttpClient(handler));
        var valid = Valid();
        foreach (var bad in new[]
        {
            valid with { IsSynthetic = true },
            valid with { SourceIsRealFieldTelemetry = false },
            valid with { PhysicalSensorMappingsApproved = false },
            valid with { OperatingStateApproved = false },
            valid with { ApprovalGateSatisfied = false },
            valid with { Risk = PdmRiskLevel.Unknown },
            valid with { ProposalKey = "bad" }
        })
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                sender.SendAsync(Webhook(), bad));
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task WebhookCannotRedirectToNonFeishuHostOrArbitraryPort()
    {
        var handler = new Handler(_ => throw new Exception("Should not be called."));
        var sender = new PdmFeishuVerifiedAlertSender(new HttpClient(handler));
        foreach (var bad in new[]
        {
            "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/aaaaaaaaaaaaaaaaaaaaaaaa",
            "http://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaaaaaaaaaaaaaaaaaa",
            "https://open.feishu.cn:8443/open-apis/bot/v2/hook/aaaaaaaaaaaaaaaaaaaaaaaa",
            "https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaa?extra=bad"
        })
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                sender.SendAsync(new Uri(bad), Valid()));
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task UnknownAcknowledgementAndServerErrorsDoNotClaimDeliveryOrAutoRetry()
    {
        foreach (var (status, body) in new[]
        {
            (HttpStatusCode.OK, "{\"code\":10002}"),
            (HttpStatusCode.OK, "{\"msg\":\"no code\"}"),
            (HttpStatusCode.BadGateway, "{\"code\":0}")
        })
        {
            var handler = new Handler(_ => new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            });
            var sender = new PdmFeishuVerifiedAlertSender(new HttpClient(handler));
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                sender.SendAsync(Webhook(), Valid()));
            Assert.Equal(1, handler.Calls);
        }
    }
}
