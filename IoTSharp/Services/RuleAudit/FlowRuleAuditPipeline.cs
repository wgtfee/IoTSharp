using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace IoTSharp.Services.RuleAudit;

public sealed class FlowRuleAuditOptions
{
    public const string SectionName = "FlowRuleAudit";
    public int Capacity { get; set; } = 8192;
    public int BatchSize { get; set; } = 256;
    public int FlushIntervalMilliseconds { get; set; } = 50;
    public int RetryDelayMilliseconds { get; set; } = 250;
}

public sealed record FlowRuleAuditRecord(
    Guid EventId, string EventName, string EventDesc, int EventStatus,
    FlowRuleRunType Type, string Metadata, Guid Creator, Guid RuleId,
    string BizId, DateTime CreatedAt, string BizData);

public sealed class FlowRuleAuditPipeline : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<FlowRuleAuditPipeline> _logger;
    private readonly FlowRuleAuditOptions _options;
    private readonly Channel<FlowRuleAuditRecord> _channel;
    private readonly CancellationTokenSource _drainCancellationSource = new();
    private int _stopping;

    public FlowRuleAuditPipeline(IServiceScopeFactory scopeFactory, IOptions<FlowRuleAuditOptions> options, ILogger<FlowRuleAuditPipeline> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _options = Normalize(options.Value);
        _channel = Channel.CreateBounded<FlowRuleAuditRecord>(new BoundedChannelOptions(_options.Capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
    }

    public ValueTask EnqueueAsync(FlowRuleAuditRecord record, CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return ValueTask.CompletedTask;

        return _channel.Writer.TryWrite(record)
            ? ValueTask.CompletedTask
            : EnqueueSlowAsync(record, cancellationToken);
    }

    private async ValueTask EnqueueSlowAsync(FlowRuleAuditRecord record, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return;

        try
        {
            await _channel.Writer.WriteAsync(record, cancellationToken);
        }
        catch (ChannelClosedException) when (Volatile.Read(ref _stopping) != 0)
        {
            // Graceful shutdown completed the writer after the fast-path check.
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref _stopping, 1);
        _channel.Writer.TryComplete();
        using var registration = cancellationToken.Register(static state =>
        {
            ((CancellationTokenSource)state!).Cancel();
        }, _drainCancellationSource);

        await base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _ = stoppingToken;
        var drainToken = _drainCancellationSource.Token;
        var batch = new List<FlowRuleAuditRecord>(_options.BatchSize);
        try
        {
            while (await _channel.Reader.WaitToReadAsync(drainToken))
            {
                batch.Clear();
                if (!_channel.Reader.TryRead(out var first))
                    continue;

                batch.Add(first);
                var deadline = DateTime.UtcNow.AddMilliseconds(_options.FlushIntervalMilliseconds);
                while (batch.Count < _options.BatchSize)
                {
                    while (batch.Count < _options.BatchSize && _channel.Reader.TryRead(out var next))
                        batch.Add(next);

                    if (batch.Count >= _options.BatchSize)
                        break;

                    var remaining = deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero)
                        break;

                    var waitToRead = _channel.Reader.WaitToReadAsync(drainToken).AsTask();
                    var delay = Task.Delay(remaining, drainToken);
                    var completed = await Task.WhenAny(waitToRead, delay);
                    if (completed == delay || !await waitToRead)
                        break;
                }

                await PersistWithRetryAsync(batch, drainToken);
            }
        }
        catch (OperationCanceledException) when (drainToken.IsCancellationRequested)
        {
            _logger.LogWarning("Flow rule audit drain was cancelled before the queue was fully persisted.");
        }
    }

    public override void Dispose()
    {
        _drainCancellationSource.Cancel();
        _drainCancellationSource.Dispose();
        base.Dispose();
    }

    private async Task PersistWithRetryAsync(IReadOnlyCollection<FlowRuleAuditRecord> batch, CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PersistBatchAsync(batch, stoppingToken);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Flow rule audit batch persistence failed. Count={Count}; retrying.", batch.Count);
                await Task.Delay(_options.RetryDelayMilliseconds, stoppingToken);
            }
        }
    }

    private async Task PersistBatchAsync(IReadOnlyCollection<FlowRuleAuditRecord> batch, CancellationToken cancellationToken)
    {
        using var scope = _scopeFactory.CreateScope();
        await using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var ruleIds = batch.Select(x => x.RuleId).Distinct().ToArray();
        var ruleReferences = await dbContext.FlowRules.AsNoTracking()
            .Where(x => ruleIds.Contains(x.RuleId))
            .Select(x => new RuleAuditReference(
                x.RuleId,
                EF.Property<Guid?>(x, "CustomerId"),
                EF.Property<Guid?>(x, "TenantId")))
            .ToDictionaryAsync(x => x.RuleId, cancellationToken);

        var eventCount = 0;
        foreach (var item in batch)
        {
            if (!ruleReferences.TryGetValue(item.RuleId, out var ruleReference))
            {
                _logger.LogWarning("Flow rule {RuleId} no longer exists; audit event {EventId} was skipped.", item.RuleId, item.EventId);
                continue;
            }

            var auditEvent = new BaseEvent
            {
                EventId = item.EventId,
                EventName = item.EventName,
                EventDesc = item.EventDesc,
                EventStaus = item.EventStatus,
                Type = item.Type,
                MataData = item.Metadata,
                Creator = item.Creator,
                Bizid = item.BizId,
                CreaterDateTime = item.CreatedAt,
                BizData = item.BizData
            };

            var entry = dbContext.BaseEvents.Add(auditEvent);
            entry.Property("FlowRuleRuleId").CurrentValue = item.RuleId;
            entry.Property("CustomerId").CurrentValue = ruleReference.CustomerId;
            entry.Property("TenantId").CurrentValue = ruleReference.TenantId;
            eventCount++;
        }

        if (eventCount == 0)
            return;

        await dbContext.SaveChangesAsync(cancellationToken);
    }

    private sealed record RuleAuditReference(Guid RuleId, Guid? CustomerId, Guid? TenantId);

    private static FlowRuleAuditOptions Normalize(FlowRuleAuditOptions source) => new()
    {
        Capacity = Math.Max(1, source.Capacity),
        BatchSize = Math.Max(1, source.BatchSize),
        FlushIntervalMilliseconds = Math.Max(1, source.FlushIntervalMilliseconds),
        RetryDelayMilliseconds = Math.Max(1, source.RetryDelayMilliseconds)
    };
}
