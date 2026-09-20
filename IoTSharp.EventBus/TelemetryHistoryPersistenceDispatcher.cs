using IoTSharp.Contracts;
using IoTSharp.Storage;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.Diagnostics;

namespace IoTSharp.EventBus;

/// <summary>
/// Drains the provider-neutral durable History queue into the active History provider.
/// A provider participates only when it explicitly advertises materialized-row replay.
/// </summary>
public sealed class TelemetryHistoryPersistenceDispatcher : BackgroundService
{
    private readonly ITelemetryHistoryRowStorage? _storage;
    private readonly IDurableTelemetryHistoryQueue _queue;
    private readonly ILogger<TelemetryHistoryPersistenceDispatcher> _logger;
    private readonly TelemetryPersistenceMonitor _persistence;
    private readonly int _retryDelayMilliseconds;
    private readonly int _idleDelayMilliseconds;

    public TelemetryHistoryPersistenceDispatcher(
        IStorage storage,
        IDurableTelemetryHistoryQueue queue,
        EventBusOption eventBusOption,
        ILogger<TelemetryHistoryPersistenceDispatcher> logger)
    {
        _storage = storage as ITelemetryHistoryRowStorage;
        _queue = queue;
        _logger = logger;
        _persistence = eventBusOption.TelemetryPersistence;

        var settings = eventBusOption.AppSettings.TelemetryHistorySpool ?? new TelemetryHistorySpoolSetting();
        _retryDelayMilliseconds = Math.Clamp(settings.RetryDelayMilliseconds, 50, 60_000);
        _idleDelayMilliseconds = Math.Clamp(settings.IdleDelayMilliseconds, 25, 5_000);
    }

    public bool IsSupported => _storage?.SupportsTelemetryHistoryRowReplay == true;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await _queue.RecoverAsync(stoppingToken);

        if (!IsSupported)
        {
            _logger.LogInformation(
                "Telemetry History durable queue is enabled but the active History provider does not support materialized row replay. Durable dispatch remains inactive for this provider.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var current = await _queue.PeekOldestAsync(stoppingToken);
            if (current is null)
            {
                try
                {
                    await _queue.WaitForDataAsync(TimeSpan.FromMilliseconds(_idleDelayMilliseconds), stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                continue;
            }

            try
            {
                var started = Stopwatch.GetTimestamp();
                var result = await _storage!.StoreTelemetryHistoryRowsAsync(current.Rows, current.MessageCount);
                if (!result.Result)
                {
                    throw new InvalidOperationException(
                        $"Telemetry History drain failed. MessageCount={current.MessageCount}, Rows={current.Rows.Count}");
                }

                await _queue.AckAsync(current, stoppingToken);
                _persistence.RecordDurableDrainSuccess(current.Rows.Count, Stopwatch.GetElapsedTime(started));
                _logger.LogDebug(
                    "Telemetry History durable batch drained. Messages={MessageCount}, Rows={Rows}, Token={Token}",
                    current.MessageCount,
                    current.Rows.Count,
                    current.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _persistence.RecordDurableRetry(current.Rows.Count);
                await _queue.NackAsync(current, stoppingToken);
                _logger.LogError(
                    ex,
                    "Telemetry History durable dispatch failed. Token={Token}; batch will be retried.",
                    current.Token);
                try
                {
                    await Task.Delay(_retryDelayMilliseconds, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
    }
}
