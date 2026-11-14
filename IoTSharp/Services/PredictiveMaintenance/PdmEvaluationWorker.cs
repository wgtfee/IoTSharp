using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using IoTSharp.Services.PredictiveMaintenance.P2;

namespace IoTSharp.Services.PredictiveMaintenance;

/// <summary>未在配置中显式批准前，P1-04 Worker 不启动。</summary>
public sealed class PdmWorkerOptions
{
    public const string SectionName = "PredictiveMaintenance";
    public bool Enabled { get; set; } = false;
    public bool SchemaReady { get; set; } = false;
    public bool SingleInstanceAcknowledged { get; set; } = false;
    public bool PointMappingsApproved { get; set; } = false;
    public bool HistoryQueryPlanApproved { get; set; } = false;
    public bool HistoryUtcContractApproved { get; set; } = false;
    public string MetadataProvider { get; set; } = string.Empty;
    public int PollSeconds { get; set; } = 60;
    public int MaxProfilesPerCycle { get; set; } = 5;
    public int MaxPointsPerDevice { get; set; } = 12;
    public int MaxHistoryRowsPerDevice { get; set; } = 5000;
    public int RecoveryConsecutiveWindows { get; set; } = 3;
    public int HistoryQueryTimeoutSeconds { get; set; } = 15;
}

/// <summary>
/// 低频、顺序、限批次执行；不触碰 MQTT、CAP、规则链写入链。
/// 只支持单应用实例配置，不含分布式 lease，未批准前必须保持禁用。
/// </summary>
public sealed class PdmEvaluationWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly PdmWorkerOptions _options;
    private readonly ILogger<PdmEvaluationWorker> _logger;
    private int _page;

    public PdmEvaluationWorker(
        IServiceScopeFactory scopeFactory,
        IOptions<PdmWorkerOptions> options,
        ILogger<PdmEvaluationWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Even if registered accidentally, an incomplete rollout must not access a real DB.
        if (!_options.Enabled || !_options.SchemaReady ||
            !_options.SingleInstanceAcknowledged || !_options.PointMappingsApproved ||
            !_options.HistoryQueryPlanApproved || !_options.HistoryUtcContractApproved)
        {
            _logger.LogWarning("PdM Worker is disabled: rollout gates are not satisfied.");
            return;
        }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(
            Math.Clamp(_options.PollSeconds, 30, 3600)));

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { await RunCycleAsync(stoppingToken); }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception error) { _logger.LogError(error, "PdM Worker cycle failed; will retry next poll."); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    public async Task RunCycleAsync(CancellationToken cancellationToken = default)
    {
        if (!_options.Enabled || !_options.SchemaReady ||
            !_options.SingleInstanceAcknowledged || !_options.PointMappingsApproved ||
            !_options.HistoryQueryPlanApproved || !_options.HistoryUtcContractApproved)
            return;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        // Each device will use its own scope so a failed SaveChanges cannot poison the next device.

        // Schema probe. If migration is missing, fail before any history query or write.
        _ = await db.DeviceProfiles.AsNoTracking().Take(1).CountAsync(cancellationToken);
        _ = await db.PointPolicies.AsNoTracking().Take(1).CountAsync(cancellationToken);
        _ = await db.HealthSnapshots.AsNoTracking().Take(1).CountAsync(cancellationToken);
        _ = await db.RiskEvents.AsNoTracking().Take(1).CountAsync(cancellationToken);

        var take = Math.Clamp(_options.MaxProfilesPerCycle, 1, 20);
        var query = db.DeviceProfiles.AsNoTracking()
            .Where(p => p.Enabled && p.PointMappingsVerified && p.RunStateVerified)
            .OrderBy(p => p.Id);
        var profiles = await query.Skip(_page * take).Take(take).ToListAsync(cancellationToken);
        if (profiles.Count == 0 && _page > 0)
        {
            _page = 0;
            profiles = await query.Take(take).ToListAsync(cancellationToken);
        }
        else if (profiles.Count == take && _page < 100_000)
            _page++;
        else
            _page = 0;

        foreach (var profile in profiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (profile.WindowMinutes is <= 0 or > 60) continue;
                var blockSeconds = profile.WindowMinutes * 60L;
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                var endSeconds = now / blockSeconds * blockSeconds;
                var endUtc = DateTimeOffset.FromUnixTimeSeconds(endSeconds);
                using var deviceScope = _scopeFactory.CreateScope();
                var processor = deviceScope.ServiceProvider.GetRequiredService<PdmCycleProcessor>();
                using var queryTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                queryTimeout.CancelAfter(TimeSpan.FromSeconds(
                    Math.Clamp(_options.HistoryQueryTimeoutSeconds, 1, 120)));
                var result = await processor.ProcessAsync(profile.Id, endUtc,
                    Math.Clamp(_options.MaxPointsPerDevice, 1, 32),
                    Math.Clamp(_options.MaxHistoryRowsPerDevice, 1, 100_000),
                    Math.Clamp(_options.RecoveryConsecutiveWindows, 1, 100),
                    queryTimeout.Token);
                // Independent, strictly opt-in internal ticket generation.
                // Never touches ingestion hot path and never delivers Feishu here.
                if (result.Committed && result.DataQuality == "Good" &&
                    result.Risk is PdmRiskLevel.Warning or PdmRiskLevel.Critical &&
                    deviceScope.ServiceProvider.GetService<PdmInternalWorkOrderAutoCreator>()
                        is { } creator)
                    await creator.AfterCommittedWindowAsync(profile.Id, endUtc, queryTimeout.Token);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("PdM device history query timed out: {ProfileId}", profile.Id);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "PdM profile processing failed: {ProfileId}; other devices continue.", profile.Id);
            }
        }
    }
}

