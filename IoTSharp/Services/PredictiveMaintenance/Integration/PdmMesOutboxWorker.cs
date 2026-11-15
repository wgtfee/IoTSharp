using System;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace IoTSharp.Services.PredictiveMaintenance.Integration;

public static class PdmMesIntegrationRegistration
{
    public static IServiceCollection AddPdmMesIntegration(
        this IServiceCollection services, IConfiguration config)
    {
        const string section = "PredictiveMaintenance:MesIntegration";
        services.Configure<PdmMesIntegrationOptions>(config.GetSection(section));
        if (!config.GetValue<bool>(section + ":Enabled")) return services;

        var options = config.GetSection(section).Get<PdmMesIntegrationOptions>()
            ?? new PdmMesIntegrationOptions();
        if (!config.GetValue<bool>("PredictiveMaintenance:Enabled") ||
            !config.GetValue<bool>("PredictiveMaintenance:SchemaReady") ||
            !config.GetValue<bool>("PredictiveMaintenance:SingleInstanceAcknowledged") ||
            !config.GetValue<bool>("PredictiveMaintenance:PointMappingsApproved") ||
            !config.GetValue<bool>("PredictiveMaintenance:HistoryQueryPlanApproved") ||
            !config.GetValue<bool>("PredictiveMaintenance:HistoryUtcContractApproved") ||
            !options.SchemaReady || options.KeyId is not { Length: >= 5 and <= 100 } ||
            Encoding.UTF8.GetByteCount(options.SharedSecret ?? "") < 32 ||
            options.MaxAttempts is < 1 or > 50 ||
            options.BatchSize is < 1 or > 50 ||
            options.RequestTimeoutSeconds is < 1 or > 30 ||
            config.GetValue<string>("PredictiveMaintenance:MetadataProvider") != "SqlServer")
            throw new InvalidOperationException("MES integration requires a reviewed SQL Server schema, approved real P1 telemetry and strong service credentials.");

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out var endpoint) ||
            (endpoint.Scheme != Uri.UriSchemeHttps &&
            !(config.GetValue<string>("ASPNETCORE_ENVIRONMENT") == "Development" &&
              options.AllowInsecureLoopbackForDevelopment && endpoint.Scheme == "http" &&
              endpoint.Host is "localhost" or "127.0.0.1")))
            throw new InvalidOperationException("MES integration endpoint must use HTTPS unless explicitly approved on Development loopback.");
        if (!endpoint.AbsolutePath.EndsWith("/api/integration/iotsharp/events", StringComparison.Ordinal))
            throw new InvalidOperationException("MES integration endpoint path is invalid.");
        services.AddHttpClient<PdmMesApiClient>().ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false
        });
        services.AddHostedService<PdmMesOutboxWorker>();
        if (config.GetValue<bool>("PredictiveMaintenance:WorkOrders:MesSync:Enabled"))
        {
            if (!config.GetValue<bool>("PredictiveMaintenance:WorkOrders:MesSync:SchemaReady") ||
                !config.GetValue<bool>("PredictiveMaintenance:WorkOrders:SchemaReady") ||
                !config.GetValue<bool>("PredictiveMaintenance:WorkOrders:Enabled"))
                throw new InvalidOperationException("MES repair events require the approved internal work-order schema.");
            services.AddHostedService<PdmWorkOrderMesOutboxWorker>();
        }
        return services;
    }
}

public sealed class PdmMesApiClient(HttpClient http, IOptions<PdmMesIntegrationOptions> options)
{
    public async Task<(bool Accepted, bool Permanent, string Code)> SendAsync(
        PdmIntegrationOutbox record, CancellationToken ct)
        => await SendAsync(record.EventId, record.PayloadJson, ct);

    public async Task<(bool Accepted, bool Permanent, string Code)> SendAsync(
        Guid eventId, string payloadJson, CancellationToken ct)
    {
        var cfg = options.Value;
        var endpoint = new Uri(cfg.Endpoint);
        var at = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var body = Encoding.UTF8.GetBytes(payloadJson);
        var signing = Encoding.UTF8.GetBytes(at + "\n" + nonce + "\n").Concat(body).ToArray();
        var digest = Convert.ToHexString(
            HMACSHA256.HashData(Encoding.UTF8.GetBytes(cfg.SharedSecret), signing)).ToLowerInvariant();

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation("X-Integration-Key-Id", cfg.KeyId);
        request.Headers.TryAddWithoutValidation("X-Integration-Timestamp", at);
        request.Headers.TryAddWithoutValidation("X-Integration-Nonce", nonce);
        request.Headers.TryAddWithoutValidation("X-Integration-Signature", "sha256=" + digest);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(cfg.RequestTimeoutSeconds));
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode is HttpStatusCode.Accepted or HttpStatusCode.OK)
        {
            // HTTP transport success alone is not a durable receipt. Verify the matching eventId.
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
            if (!json.RootElement.TryGetProperty("eventId", out var receiptEventId) ||
                !Guid.TryParse(receiptEventId.GetString(), out var received) ||
                received != eventId)
                return (false, false, "RECEIPT_MISMATCH");
            return (true, false, "ACK");
        }
        var code = (int)response.StatusCode;
        return (false, code is 400 or 401 or 403 or 409 or 422, "HTTP_" + code);
    }
}

public sealed class PdmMesOutboxWorker(
    IServiceScopeFactory scopes,
    PdmMesApiClient client,
    IOptions<PdmMesIntegrationOptions> options,
    ILogger<PdmMesOutboxWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled || !options.Value.SchemaReady) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        do
        {
            try { await DeliverBatchAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { log.LogError(ex, "MES integration outbox cycle failed"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task DeliverBatchAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        var batch = await db.IntegrationOutbox.Where(x =>
            x.DeliveryStatus == "Pending" && x.NextAttemptAtUtc <= DateTime.UtcNow)
            .OrderBy(x => x.CreatedAtUtc).Take(options.Value.BatchSize).ToListAsync(ct);
        foreach (var entry in batch)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var response = await client.SendAsync(entry, ct);
                if (response.Accepted)
                {
                    entry.DeliveryStatus = "Delivered";
                    entry.DeliveredAtUtc = DateTime.UtcNow;
                    entry.LastErrorCode = null;
                }
                else
                {
                    entry.LastErrorCode = response.Code;
                    RetryOrReview(entry, response.Permanent);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                entry.LastErrorCode = "UNKNOWN_DELIVERY_RESULT";
                RetryOrReview(entry, false);
                log.LogWarning(ex, "MES delivery uncertain for EventId {EventId}; will retry idempotently", entry.EventId);
            }
            // Each attempt is persisted. MES uniquely identifies an event across timeout/retry.
            await db.SaveChangesAsync(ct);
        }
    }

    private void RetryOrReview(PdmIntegrationOutbox entry, bool permanent)
    {
        entry.AttemptCount++;
        if (permanent || entry.AttemptCount >= options.Value.MaxAttempts)
        {
            entry.DeliveryStatus = "ManualReview";
            return;
        }
        entry.NextAttemptAtUtc = DateTime.UtcNow.AddSeconds(
            Math.Min(1800, 5 * Math.Pow(2, Math.Min(entry.AttemptCount, 8))));
    }
}
