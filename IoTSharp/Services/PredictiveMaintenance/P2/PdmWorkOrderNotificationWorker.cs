using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// Explicitly gated, bounded internal work-order notification outbox worker.
/// Only the dedicated PdM SQL Server DB is accessed; no PLC/MES/telemetry
/// write chain or application business DbContext is touched.
/// </summary>
public sealed class PdmWorkOrderNotificationWorker(
    IServiceScopeFactory scopes,
    IOptions<PdmWorkOrderFeishuOptions> options,
    ILogger<PdmWorkOrderNotificationWorker> logger) : BackgroundService
{
    private readonly PdmWorkOrderFeishuOptions _options = options.Value;
    private readonly Guid _workerId = Guid.NewGuid();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled) return;
        _options.Validate();
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(
            Math.Clamp(_options.PollSeconds, 30, 3600)));
        do
        {
            try
            {
                await RunCycleAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                // Do not emit MCP error text, bearer tokens, chat IDs or
                // potentially confidential business payload to the log.
                logger.LogWarning("PdM Feishu outbox cycle held: {ErrorType}",
                    error.GetType().Name);
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task<int> RunCycleAsync(CancellationToken ct = default)
    {
        _options.Validate();
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>();
        var sender = scope.ServiceProvider.GetRequiredService<PdmFeishuPushMcpSender>();
        var dispatcher = scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderFeishuDispatcher>();

        // The DB is queried ONLY after all route and runtime gates pass.
        var ids = await db.Notifications.AsNoTracking()
            .Where(x => x.TenantId == _options.TenantId &&
                        x.CustomerId == _options.CustomerId &&
                        x.Channel == "feishu" && x.State == "Pending")
            .OrderBy(x => x.CreatedAtUtc)
            .Take(_options.MaxPerCycle)
            .Select(x => x.Id)
            .ToArrayAsync(ct);
        if (ids.Length == 0) return 0;

        // Do not claim pending records while the local managed provider is
        // known to be unavailable. No automatic retries of claimed records.
        if (!await sender.IsProviderReadyAsync(ct)) return 0;
        var delivered = 0;
        var route = _options.ApprovedRoute();
        foreach (var id in ids)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var outcome = await dispatcher.DispatchOneAsync(
                    _options.TenantId, _options.CustomerId, id,
                    _workerId, route, DateTimeOffset.UtcNow, ct);
                if (outcome.Confirmed) delivered++;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                logger.LogWarning(
                    "PdM Feishu notification {NotificationId} requires manual reconciliation ({ErrorType})",
                    id, error.GetType().Name);
            }
        }
        return delivered;
    }
}
