using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.Ingestion;

public sealed record ReliableEventBusinessResult(bool Success, string Message)
{
    public static ReliableEventBusinessResult Ok(string message = "OK") => new(true, message);
    public static ReliableEventBusinessResult Fail(string message) => new(false, message);
}

public interface IReliableEventBusinessHandler
{
    bool CanHandle(string eventType);
    Task<ReliableEventBusinessResult> HandleAsync(
        ApplicationDbContext dbContext,
        Device gateway,
        Device targetDevice,
        ReliableEventEnvelope envelope,
        CancellationToken cancellationToken);
}

internal sealed class AlarmReliableEventBusinessHandler : IReliableEventBusinessHandler
{
    private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();

    public bool CanHandle(string eventType)
        => string.Equals(eventType, "Alarm", StringComparison.OrdinalIgnoreCase);

    public async Task<ReliableEventBusinessResult> HandleAsync(
        ApplicationDbContext dbContext,
        Device gateway,
        Device targetDevice,
        ReliableEventEnvelope envelope,
        CancellationToken cancellationToken)
    {
        CreateAlarmDto alarm;
        try
        {
            alarm = JsonSerializer.Deserialize<CreateAlarmDto>(envelope.Payload.GetRawText(), JsonOptions);
        }
        catch (JsonException ex)
        {
            return ReliableEventBusinessResult.Fail($"Alarm payload is invalid: {ex.Message}");
        }

        if (alarm is null || string.IsNullOrWhiteSpace(alarm.AlarmType))
            return ReliableEventBusinessResult.Fail("Alarm payload requires alarmType.");

        alarm.OriginatorName = targetDevice.Id.ToString("D");
        alarm.OriginatorType = targetDevice.DeviceType == DeviceType.Gateway
            ? OriginatorType.Gateway
            : OriginatorType.Device;
        alarm.CreateDateTime = envelope.OccurredAt;

        var result = await dbContext.OccurredAlarm(alarm);
        return result.Code == (int)ApiCode.Success || result.Code == (int)ApiCode.NothingToDo
            ? ReliableEventBusinessResult.Ok(result.Msg ?? "OK")
            : ReliableEventBusinessResult.Fail($"Alarm persistence failed: {result.Code}-{result.Msg}");
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNameCaseInsensitive = true
        };
        options.Converters.Add(new JsonStringEnumConverter());
        return options;
    }
}

internal sealed record ReliableEventProcessResult(
    bool Success,
    bool Duplicate,
    bool Conflict,
    string Message)
{
    public static ReliableEventProcessResult Completed(bool duplicate, string message)
        => new(true, duplicate, false, message);
    public static ReliableEventProcessResult Failed(string message)
        => new(false, false, false, message);
    public static ReliableEventProcessResult Conflicted(string message)
        => new(false, false, true, message);
}

public sealed class ReliableEventProcessor
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly GatewayChildDeviceResolver _resolver;
    private readonly IReadOnlyList<IReliableEventBusinessHandler> _handlers;
    private readonly ILogger<ReliableEventProcessor> _logger;
    private readonly ConcurrentDictionary<string, EventGate> _gates = new(StringComparer.Ordinal);

    public ReliableEventProcessor(
        IServiceScopeFactory scopeFactory,
        GatewayChildDeviceResolver resolver,
        IEnumerable<IReliableEventBusinessHandler> handlers,
        ILogger<ReliableEventProcessor> logger)
    {
        _scopeFactory = scopeFactory;
        _resolver = resolver;
        _handlers = handlers.ToArray();
        _logger = logger;
    }

    internal async Task<ReliableEventProcessResult> ProcessAsync(
        Device gateway,
        ReliableEventEnvelope envelope,
        string payloadHash,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(gateway);
        ArgumentNullException.ThrowIfNull(envelope);
        var key = $"{gateway.Id:N}:{envelope.EventId}";
        await using var lease = await AcquireGateAsync(key, cancellationToken);
        return await ProcessCoreAsync(gateway, envelope, payloadHash, cancellationToken, allowConcurrentRetry: true);
    }

    private async Task<ReliableEventProcessResult> ProcessCoreAsync(
        Device gateway,
        ReliableEventEnvelope envelope,
        string payloadHash,
        CancellationToken cancellationToken,
        bool allowConcurrentRetry)
    {
        var handler = _handlers.FirstOrDefault(item => item.CanHandle(envelope.Type));
        if (handler is null)
            return ReliableEventProcessResult.Failed($"No reliable event handler is registered for '{envelope.Type}'.");

        Device targetDevice;
        if (IsGatewayTarget(gateway, envelope.DeviceId))
        {
            targetDevice = gateway;
        }
        else
        {
            var children = await _resolver.ResolveManyAsync(gateway, new[] { envelope.DeviceId }, cancellationToken);
            if (!children.TryGetValue(envelope.DeviceId, out targetDevice))
                return ReliableEventProcessResult.Failed($"Gateway child device '{envelope.DeviceId}' could not be resolved.");
        }

        using var scope = _scopeFactory.CreateScope();
        await using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        IDbContextTransaction transaction = null;
        if (dbContext.Database.IsRelational())
            transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

        ReliableEventReceipt receipt = null;
        var created = false;
        try
        {
            receipt = await dbContext.ReliableEventReceipts
                .SingleOrDefaultAsync(item => item.GatewayId == gateway.Id && item.EventId == envelope.EventId, cancellationToken);

            if (receipt is not null)
            {
                if (!string.Equals(receipt.PayloadHash, payloadHash, StringComparison.Ordinal))
                {
                    if (transaction is not null) await transaction.RollbackAsync(cancellationToken);
                    return ReliableEventProcessResult.Conflicted("The same eventId was already used with a different payload.");
                }
                if (string.Equals(receipt.Status, ReliableEventReceiptStatuses.Completed, StringComparison.Ordinal))
                {
                    if (transaction is not null) await transaction.CommitAsync(cancellationToken);
                    return ReliableEventProcessResult.Completed(true, "Event was already processed.");
                }
                receipt.Status = ReliableEventReceiptStatuses.Processing;
                receipt.LastError = null;
            }
            else
            {
                created = true;
                receipt = new ReliableEventReceipt
                {
                    GatewayId = gateway.Id,
                    EventId = envelope.EventId,
                    EventType = envelope.Type,
                    DeviceId = targetDevice.Id,
                    OccurredAt = envelope.OccurredAt,
                    ReceivedAt = DateTime.UtcNow,
                    PayloadHash = payloadHash,
                    Payload = envelope.Payload.GetRawText(),
                    Status = ReliableEventReceiptStatuses.Processing
                };
                dbContext.ReliableEventReceipts.Add(receipt);
            }

            try
            {
                await dbContext.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException) when (created && allowConcurrentRetry)
            {
                if (transaction is not null) await transaction.RollbackAsync(cancellationToken);
                return await ProcessCoreAsync(gateway, envelope, payloadHash, cancellationToken, allowConcurrentRetry: false);
            }

            var businessResult = await handler.HandleAsync(dbContext, gateway, targetDevice, envelope, cancellationToken);
            if (!businessResult.Success)
                throw new ReliableEventBusinessException(businessResult.Message);

            receipt.DeviceId = targetDevice.Id;
            receipt.Status = ReliableEventReceiptStatuses.Completed;
            receipt.ProcessedAt = DateTime.UtcNow;
            receipt.LastError = null;
            await dbContext.SaveChangesAsync(cancellationToken);
            if (transaction is not null) await transaction.CommitAsync(cancellationToken);

            return ReliableEventProcessResult.Completed(false, businessResult.Message);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (transaction is not null)
            {
                try { await transaction.RollbackAsync(cancellationToken); }
                catch (Exception rollbackEx) { _logger.LogWarning(rollbackEx, "Reliable event transaction rollback failed."); }
            }

            await PersistFailureAsync(gateway.Id, targetDevice.Id, envelope, payloadHash, ex.Message, cancellationToken);
            _logger.LogWarning(ex, "Reliable event processing failed. Gateway={GatewayId}, EventId={EventId}", gateway.Id, envelope.EventId);
            return ReliableEventProcessResult.Failed(ex.Message);
        }
        finally
        {
            if (transaction is not null) await transaction.DisposeAsync();
        }
    }

    private async Task PersistFailureAsync(
        Guid gatewayId,
        Guid deviceId,
        ReliableEventEnvelope envelope,
        string payloadHash,
        string error,
        CancellationToken cancellationToken)
    {
        using var scope = _scopeFactory.CreateScope();
        await using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var receipt = await dbContext.ReliableEventReceipts
            .SingleOrDefaultAsync(item => item.GatewayId == gatewayId && item.EventId == envelope.EventId, cancellationToken);

        if (receipt is not null)
        {
            if (string.Equals(receipt.Status, ReliableEventReceiptStatuses.Completed, StringComparison.Ordinal)
                || !string.Equals(receipt.PayloadHash, payloadHash, StringComparison.Ordinal))
                return;
            receipt.Status = ReliableEventReceiptStatuses.Failed;
            receipt.LastError = Truncate(error, 2048);
            receipt.ProcessedAt = null;
        }
        else
        {
            dbContext.ReliableEventReceipts.Add(new ReliableEventReceipt
            {
                GatewayId = gatewayId,
                EventId = envelope.EventId,
                EventType = envelope.Type,
                DeviceId = deviceId,
                OccurredAt = envelope.OccurredAt,
                ReceivedAt = DateTime.UtcNow,
                PayloadHash = payloadHash,
                Payload = envelope.Payload.GetRawText(),
                Status = ReliableEventReceiptStatuses.Failed,
                LastError = Truncate(error, 2048)
            });
        }

        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex)
        {
            _logger.LogWarning(ex, "Persisting reliable event failure state raced with another node. Gateway={GatewayId}, EventId={EventId}", gatewayId, envelope.EventId);
        }
    }

    private static bool IsGatewayTarget(Device gateway, string deviceId)
        => string.Equals(deviceId, "me", StringComparison.OrdinalIgnoreCase)
           || string.Equals(deviceId, gateway.Name, StringComparison.OrdinalIgnoreCase)
           || string.Equals(deviceId, gateway.Id.ToString("D"), StringComparison.OrdinalIgnoreCase)
           || string.Equals(deviceId, gateway.Id.ToString("N"), StringComparison.OrdinalIgnoreCase);

    private static string Truncate(string value, int maxLength)
        => string.IsNullOrEmpty(value) || value.Length <= maxLength ? value : value[..maxLength];

    private async ValueTask<EventGateLease> AcquireGateAsync(string key, CancellationToken cancellationToken)
    {
        while (true)
        {
            var gate = _gates.GetOrAdd(key, _ => new EventGate());
            Interlocked.Increment(ref gate.RefCount);
            if (_gates.TryGetValue(key, out var current) && ReferenceEquals(current, gate))
            {
                await gate.Semaphore.WaitAsync(cancellationToken);
                return new EventGateLease(this, key, gate);
            }
            Interlocked.Decrement(ref gate.RefCount);
        }
    }

    private void ReleaseGate(string key, EventGate gate)
    {
        gate.Semaphore.Release();
        if (Interlocked.Decrement(ref gate.RefCount) == 0)
            _gates.TryRemove(new KeyValuePair<string, EventGate>(key, gate));
    }

    private sealed class EventGate
    {
        public readonly SemaphoreSlim Semaphore = new(1, 1);
        public int RefCount;
    }

    private sealed class EventGateLease : IAsyncDisposable
    {
        private ReliableEventProcessor _owner;
        private readonly string _key;
        private readonly EventGate _gate;

        public EventGateLease(ReliableEventProcessor owner, string key, EventGate gate)
        {
            _owner = owner;
            _key = key;
            _gate = gate;
        }

        public ValueTask DisposeAsync()
        {
            var owner = Interlocked.Exchange(ref _owner, null);
            owner?.ReleaseGate(_key, _gate);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ReliableEventBusinessException : Exception
    {
        public ReliableEventBusinessException(string message) : base(message) { }
    }
}
