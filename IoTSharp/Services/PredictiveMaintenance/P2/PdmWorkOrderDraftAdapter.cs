using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// Planning-only work-order envelope. There is no external endpoint, command or
/// real work order ID in this contract; never treat a dry-run receipt as issuance.
/// </summary>
public sealed record PdmWorkOrderDraft(
    Guid TenantId, Guid CustomerId, Guid DeviceId, Guid SourceReviewId,
    string CorrelationKey, string Title, string ReviewReason,
    bool IsExternalOrderCreated = false, bool RequiresHumanDispatchApproval = true);

public sealed record PdmDryRunReceipt(
    string CorrelationKey, Guid DraftId, bool IsExternalOrderCreated = false);

public interface IPdmWorkOrderDraftAdapter
{
    Task<PdmDryRunReceipt> PreviewAsync(
        PdmWorkOrderDraft draft, CancellationToken cancellationToken = default);
}

public static class PdmWorkOrderDraftFactory
{
    public static PdmWorkOrderDraft Prepare(
        PdmP2ReviewRecord record, PdmP2ReviewAudit approval,
        PdmP2TrustedActor requester)
    {
        ArgumentNullException.ThrowIfNull(record);
        ArgumentNullException.ThrowIfNull(approval);
        ArgumentNullException.ThrowIfNull(requester);
        if (!requester.IsAuthenticated || !requester.CanReview ||
            requester.TenantId != record.TenantId ||
            requester.CustomerId != record.CustomerId ||
            requester.UserId == Guid.Empty ||
            record.TenantId == Guid.Empty || record.CustomerId == Guid.Empty ||
            record.DeviceId == Guid.Empty || record.Id == Guid.Empty ||
            record.State != "ApprovedForPlanning" ||
            approval.ReviewId != record.Id ||
            approval.TenantId != record.TenantId ||
            approval.CustomerId != record.CustomerId ||
            approval.ActorId == Guid.Empty ||
            approval.Action != "ApprovedForPlanning" ||
            approval.AtUtc.Kind != DateTimeKind.Utc ||
            approval.AtUtc > DateTime.UtcNow.AddMinutes(1) ||
            approval.AtUtc < record.CreatedAtUtc ||
            record.UpdatedAtUtc < approval.AtUtc ||
            string.IsNullOrWhiteSpace(record.Title) ||
            string.IsNullOrWhiteSpace(record.Fingerprint))
            throw new InvalidOperationException("Only reviewed, audited, scoped proposals can become dry-run drafts");

        var raw = string.Join("|", "pdm-p2-dry-run-v1",
            record.TenantId.ToString("N"), record.CustomerId.ToString("N"),
            record.Id.ToString("N"), record.Fingerprint);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))
            .ToLowerInvariant();
        return new(record.TenantId, record.CustomerId, record.DeviceId,
            record.Id, key, record.Title, approval.Reason);
    }
}

/// <summary>
/// Only test/local dry-run implementation: never performs IO except in-process
/// storage; idempotent preview receipts do not signal a created work order.
/// </summary>
public sealed class PdmInMemoryDryRunAdapter : IPdmWorkOrderDraftAdapter
{
    private readonly ConcurrentDictionary<(Guid Tenant, Guid Customer, Guid Review, string Key), PdmDryRunReceipt> _receipts = new();

    public Task<PdmDryRunReceipt> PreviewAsync(
        PdmWorkOrderDraft draft, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(draft);
        if (draft.TenantId == Guid.Empty || draft.CustomerId == Guid.Empty ||
            draft.DeviceId == Guid.Empty || draft.SourceReviewId == Guid.Empty ||
            draft.CorrelationKey.Length != 64 ||
            !draft.CorrelationKey.All(char.IsAsciiHexDigit) ||
            draft.IsExternalOrderCreated || !draft.RequiresHumanDispatchApproval)
            throw new InvalidOperationException("Invalid unapproved dry-run work order envelope");
        var scopedKey = (draft.TenantId, draft.CustomerId, draft.SourceReviewId, draft.CorrelationKey);
        var receipt = _receipts.GetOrAdd(scopedKey,
            _ => new PdmDryRunReceipt(draft.CorrelationKey, Guid.NewGuid()));
        return Task.FromResult(receipt);
    }
}

