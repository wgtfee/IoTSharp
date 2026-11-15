using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.Test;

public sealed class PdmMesApiClientTests
{
    private static readonly string Secret = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes("disposable-e2e-secret-not-for-production")));

    private static PdmMesIntegrationOptions Options() => new()
    {
        Enabled = true,
        SchemaReady = true,
        Endpoint = "https://mes-isolated.example.invalid/api/integration/iotsharp/events",
        KeyId = "iotsharp_e2e_only",
        SharedSecret = Secret,
        RequestTimeoutSeconds = 5
    };

    private static PdmIntegrationOutbox Entry() => new()
    {
        EventId = Guid.NewGuid(),
        TenantId = Guid.NewGuid(),
        CustomerId = Guid.NewGuid(),
        SourceEventKey = "unit-test-episode",
        SourceSequence = 1,
        EventType = "ALARM_OPENED",
        PayloadJson = "{\"schemaVersion\":\"1.0\",\"sourceSystem\":\"IoTSharp\",\"isSynthetic\":true}"
    };

    [Theory]
    [InlineData(HttpStatusCode.Accepted)]
    [InlineData(HttpStatusCode.OK)]
    public async Task SignedRequest_IsAuthentic_AndMatchingReceiptIsAccepted(HttpStatusCode code)
    {
        var entry = Entry();
        var handler = new FuncHandler(async request =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("/api/integration/iotsharp/events", request.RequestUri?.AbsolutePath);
            Assert.Equal(Options().KeyId, request.Headers.GetValues("X-Integration-Key-Id").Single());
            var stamp = request.Headers.GetValues("X-Integration-Timestamp").Single();
            var nonce = request.Headers.GetValues("X-Integration-Nonce").Single();
            var signature = request.Headers.GetValues("X-Integration-Signature").Single();
            var content = await request.Content!.ReadAsByteArrayAsync();
            Assert.Equal(Encoding.UTF8.GetBytes(entry.PayloadJson), content);

            var payload = Encoding.UTF8.GetBytes(stamp + "\n" + nonce + "\n")
                .Concat(content).ToArray();
            var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(
                Encoding.UTF8.GetBytes(Secret), payload)).ToLowerInvariant();
            Assert.Equal(expected, signature);
            return new HttpResponseMessage(code)
            {
                Content = new StringContent("{\"code\":\"ACCEPTED\",\"eventId\":\"" +
                    entry.EventId + "\"}", Encoding.UTF8, "application/json")
            };
        });
        using var http = new HttpClient(handler);
        var client = new PdmMesApiClient(http, Microsoft.Extensions.Options.Options.Create(Options()));
        var result = await client.SendAsync(entry, CancellationToken.None);
        Assert.True(result.Accepted);
        Assert.False(result.Permanent);
        Assert.Equal("ACK", result.Code);
        Assert.Equal(1, handler.CallCount);
    }

    [Fact]
    public async Task ReceiptForDifferentEvent_CannotMarkSourceOutboxDelivered()
    {
        var entry = Entry();
        using var http = new HttpClient(new FuncHandler(_ => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent("{\"eventId\":\"" + Guid.NewGuid() + "\"}")
            })));
        var client = new PdmMesApiClient(http, Microsoft.Extensions.Options.Options.Create(Options()));
        var result = await client.SendAsync(entry, CancellationToken.None);
        Assert.False(result.Accepted);
        Assert.Equal("RECEIPT_MISMATCH", result.Code);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, true)]
    [InlineData(HttpStatusCode.ServiceUnavailable, false)]
    public async Task HttpError_IsNotAcknowledged_AndUsesCorrectRetryPolicy(
        HttpStatusCode status, bool permanent)
    {
        using var http = new HttpClient(new FuncHandler(_ => Task.FromResult(
            new HttpResponseMessage(status))));
        var client = new PdmMesApiClient(http, Microsoft.Extensions.Options.Options.Create(Options()));
        var result = await client.SendAsync(Entry(), CancellationToken.None);
        Assert.False(result.Accepted);
        Assert.Equal(permanent, result.Permanent);
        Assert.Equal("HTTP_" + (int)status, result.Code);
    }

    private sealed class FuncHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> reply)
        : HttpMessageHandler
    {
        public int CallCount { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return reply(request);
        }
    }
}
