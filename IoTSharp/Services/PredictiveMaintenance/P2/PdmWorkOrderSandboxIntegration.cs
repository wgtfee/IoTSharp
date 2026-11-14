using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmSandboxWorkOrderState
{
    AcceptedForSimulation, CompensatedInMemory
}

/// <summary>Only a synthetic receipt. No external work order ID is supplied or accepted.</summary>
public sealed record PdmSandboxWorkOrderReceipt(
    Guid TenantId, Guid CustomerId, Guid SourceReviewId,
    string CorrelationKey, PdmSandboxWorkOrderState State,
    int Attempts, string Detail,
    bool IsExternalOrderCreated = false,
    bool IsProductionNotificationSent = false);

public interface IPdmSandboxWorkOrderTokenValidator
{
    /// <summary>Validate synthetic credentials; never log or persist the bearer token.</summary>
    bool IsValid(string token, PdmP2TrustedActor actor);
}

public interface IPdmSandboxWorkOrderTransport
{
    /// <summary>
    /// Must implement a no-network, fake transport only.
    /// A future external provider MUST NOT reuse this sandbox coordinator.
    /// </summary>
    Task<bool> SimulateSendAsync(
        PdmWorkOrderDraft draft, CancellationToken cancellationToken);
}

/// <summary>
/// Bounded, in-memory sandbox outbox with scoped idempotency and explicit
/// compensation on retry exhaustion. NEVER registered in production DI.
/// This is not a durable queue and does not send real work orders.
/// </summary>
public sealed class PdmSandboxWorkOrderCoordinator(
    IPdmSandboxWorkOrderTokenValidator tokenValidator,
    IPdmSandboxWorkOrderTransport transport)
{
    private sealed class Entry
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public PdmSandboxWorkOrderReceipt? Receipt;
    }

    private readonly ConcurrentDictionary<
        (Guid Tenant, Guid Customer, Guid Review, string Key), Entry> _outbox = new();

    public async Task<PdmSandboxWorkOrderReceipt> PreviewAsync(
        PdmWorkOrderDraft draft, PdmP2TrustedActor actor, string syntheticBearerToken,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(draft);
        ArgumentNullException.ThrowIfNull(actor);
        if (!actor.IsAuthenticated || !actor.CanReview ||
            actor.UserId == Guid.Empty ||
            actor.TenantId == Guid.Empty || actor.CustomerId == Guid.Empty ||
            actor.TenantId != draft.TenantId ||
            actor.CustomerId != draft.CustomerId ||
            draft.DeviceId == Guid.Empty || draft.SourceReviewId == Guid.Empty ||
            draft.CorrelationKey.Length != 64 ||
            !System.Linq.Enumerable.All(draft.CorrelationKey, char.IsAsciiHexDigit) ||
            !draft.RequiresHumanDispatchApproval || draft.IsExternalOrderCreated)
            throw new UnauthorizedAccessException("Untrusted scoped sandbox dispatch request");
        if (string.IsNullOrWhiteSpace(syntheticBearerToken) ||
            !tokenValidator.IsValid(syntheticBearerToken, actor))
            throw new UnauthorizedAccessException("Invalid sandbox authorization token");

        var key = (draft.TenantId, draft.CustomerId,
            draft.SourceReviewId, draft.CorrelationKey.ToLowerInvariant());
        var entry = _outbox.GetOrAdd(key, _ => new Entry());
        await entry.Gate.WaitAsync(cancellationToken);
        try
        {
            if (entry.Receipt is not null) return entry.Receipt;
            var attempts = 0;
            for (; attempts < 3;)
            {
                cancellationToken.ThrowIfCancellationRequested();
                attempts++;
                try
                {
                    var simulated = await transport.SimulateSendAsync(draft, cancellationToken);
                    if (simulated)
                    {
                        var accepted = new PdmSandboxWorkOrderReceipt(
                            draft.TenantId, draft.CustomerId, draft.SourceReviewId,
                            key.Item4, PdmSandboxWorkOrderState.AcceptedForSimulation,
                            attempts, "仅模拟连接成功；未创建任何真实工单");
                        entry.Receipt = accepted;
                        return accepted;
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception)
                {
                    // Only the isolated fake transport may be retried.
                    // Do not leak external exception messages or credentials to results.
                }
            }

            var compensated = new PdmSandboxWorkOrderReceipt(
                draft.TenantId, draft.CustomerId, draft.SourceReviewId,
                key.Item4, PdmSandboxWorkOrderState.CompensatedInMemory,
                attempts, "模拟发送失败，已在内存标记补偿；无外部事务或工单创建");
            entry.Receipt = compensated;
            return compensated;
        }
        finally { entry.Gate.Release(); }
    }
}

