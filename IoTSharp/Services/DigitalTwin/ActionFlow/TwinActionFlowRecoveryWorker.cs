using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>服务启动后恢复未结束 Run，并周期清理过期 lease / 推进到期等待。</summary>
public sealed class TwinActionFlowRecoveryWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TwinActionFlowRecoveryWorker> _logger;

    public TwinActionFlowRecoveryWorker(IServiceScopeFactory scopeFactory, ILogger<TwinActionFlowRecoveryWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await RecoverAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var runtime = scope.ServiceProvider.GetRequiredService<TwinActionFlowRuntimeService>();
                await runtime.MaintenanceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception exception) { _logger.LogError(exception, "Action Flow maintenance failed."); }
        }
    }

    private async Task RecoverAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var runtime = scope.ServiceProvider.GetRequiredService<TwinActionFlowRuntimeService>();
            await runtime.RecoverActiveRunsAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception) { _logger.LogError(exception, "Action Flow startup recovery failed."); }
    }
}
