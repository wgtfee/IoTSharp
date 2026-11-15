using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace IoTSharp.Services.PredictiveMaintenance.Integration;

/// <summary>Independent reliable delivery for the work-order SQL database.</summary>
public sealed class PdmWorkOrderMesOutboxWorker(
    IServiceScopeFactory scopes,
    PdmMesApiClient client,
    IOptions<PdmMesIntegrationOptions> options,
    ILogger<PdmWorkOrderMesOutboxWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken token)
    {
        if (!options.Value.Enabled || !options.Value.SchemaReady) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        do
        {
            try { await DeliverAsync(token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception ex) { log.LogError(ex, "IoTSharp MES repair-event delivery failed"); }
        } while (await timer.WaitForNextTickAsync(token));
    }

    private async Task DeliverAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>();
        const string resource = "IoTSharp.PdmWorkOrderMesOutbox.Dispatch";
        if (!await PdmMesSqlDispatchLock.TryAcquireAsync(db, resource, ct)) return;
        try
        {
            var batch = await db.MesOutbox.Where(x =>
                    x.DeliveryStatus == "Pending" && x.NextAttemptAtUtc <= DateTime.UtcNow)
                .OrderBy(x => x.CreatedAtUtc).ThenBy(x => x.SourceSequence)
                .Take(options.Value.BatchSize).ToListAsync(ct);
            foreach (var entry in batch)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    var result = await client.SendAsync(entry.EventId, entry.PayloadJson, ct);
                    if (result.Accepted)
                    {
                        entry.DeliveryStatus = "Delivered";
                        entry.DeliveredAtUtc = DateTime.UtcNow;
                        entry.LastErrorCode = null;
                    }
                    else
                    {
                        entry.LastErrorCode = result.Code;
                        RetryOrReview(entry, result.Permanent);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    entry.LastErrorCode = "UNKNOWN_DELIVERY_RESULT";
                    RetryOrReview(entry, false);
                    log.LogWarning(ex, "MES repair-event result uncertain, reusing EventId {EventId}", entry.EventId);
                }
                await db.SaveChangesAsync(ct);
            }
        }
        finally
        {
            await PdmMesSqlDispatchLock.ReleaseAsync(db, resource);
        }
    }

    private void RetryOrReview(PdmWorkOrderMesOutbox row, bool permanent)
    {
        row.AttemptCount++;
        if (permanent || row.AttemptCount >= options.Value.MaxAttempts)
        {
            row.DeliveryStatus = "ManualReview";
            return;
        }
        row.NextAttemptAtUtc = DateTime.UtcNow.AddSeconds(
            Math.Min(1800, 5 * Math.Pow(2, Math.Min(8, row.AttemptCount))));
    }
}
