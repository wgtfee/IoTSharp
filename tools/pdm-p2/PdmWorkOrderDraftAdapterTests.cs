using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmWorkOrderDraftAdapterTests
{
    private static (PdmP2ReviewRecord Review, PdmP2ReviewAudit Audit, PdmP2TrustedActor Actor)
        Valid()
    {
        var tenant = Guid.NewGuid(); var customer = Guid.NewGuid(); var id = Guid.NewGuid();
        var time = DateTime.UtcNow.AddMinutes(-2);
        var record = new PdmP2ReviewRecord
        {
            Id = id, TenantId = tenant, CustomerId = customer,
            DeviceId = Guid.NewGuid(), ProfileId = Guid.NewGuid(), ProfileVersion = 2,
            RiskEventId = Guid.NewGuid(), State = "ApprovedForPlanning",
            Fingerprint = new string('a', 64), Title = "设备巡检建议",
            CreatedAtUtc = time, UpdatedAtUtc = time.AddMinutes(1), Revision = 2
        };
        var audit = new PdmP2ReviewAudit
        {
            ReviewId = id, TenantId = tenant, CustomerId = customer,
            ActorId = Guid.NewGuid(), Action = "ApprovedForPlanning",
            AtUtc = time.AddMinutes(1), Reason = "现场审核，允许规划"
        };
        var actor = new PdmP2TrustedActor(tenant, customer, Guid.NewGuid(), true, false, true);
        return (record, audit, actor);
    }

    [Fact]
    public async Task ApprovedAuditCanProduceRepeatableDryRunButNotRealOrder()
    {
        var (review, audit, actor) = Valid();
        var draft = PdmWorkOrderDraftFactory.Prepare(review, audit, actor);
        Assert.False(draft.IsExternalOrderCreated);
        Assert.True(draft.RequiresHumanDispatchApproval);
        Assert.Equal(64, draft.CorrelationKey.Length);
        var sink = new PdmInMemoryDryRunAdapter();
        var first = await sink.PreviewAsync(draft);
        var again = await sink.PreviewAsync(draft);
        Assert.Equal(first.DraftId, again.DraftId);
        Assert.False(first.IsExternalOrderCreated);
    }

    [Fact]
    public void MissingAuditOrWrongTenantCannotPrepare()
    {
        var (review, audit, actor) = Valid();
        var wrongAudit = new PdmP2ReviewAudit
        {
            ReviewId = Guid.NewGuid(), TenantId = audit.TenantId, CustomerId = audit.CustomerId,
            ActorId = audit.ActorId, Action = "ApprovedForPlanning", AtUtc = audit.AtUtc,
            Reason = audit.Reason
        };
        Assert.Throws<InvalidOperationException>(() =>
            PdmWorkOrderDraftFactory.Prepare(review, wrongAudit, actor));
        Assert.Throws<InvalidOperationException>(() =>
            PdmWorkOrderDraftFactory.Prepare(review, audit,
                actor with { TenantId = Guid.NewGuid() }));
    }

    [Fact]
    public async Task CancelledOrForgedDraftsAreNeverAcceptedAsIssued()
    {
        var (review, audit, actor) = Valid();
        var draft = PdmWorkOrderDraftFactory.Prepare(review, audit, actor);
        var sink = new PdmInMemoryDryRunAdapter();
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await sink.PreviewAsync(draft with { IsExternalOrderCreated = true }));
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await sink.PreviewAsync(draft with { CorrelationKey = "invalid" }));
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await sink.PreviewAsync(draft, cts.Token));
    }

    [Fact]
    public async Task IdenticalSyntheticKeysNeverShareReceiptsAcrossTenantOrReview()
    {
        var (record, audit, actor) = Valid();
        var original = PdmWorkOrderDraftFactory.Prepare(record, audit, actor);
        var sink = new PdmInMemoryDryRunAdapter();
        var own = await sink.PreviewAsync(original);
        var otherTenant = await sink.PreviewAsync(original with
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid()
        });
        var otherReview = await sink.PreviewAsync(original with
        {
            SourceReviewId = Guid.NewGuid()
        });
        Assert.NotEqual(own.DraftId, otherTenant.DraftId);
        Assert.NotEqual(own.DraftId, otherReview.DraftId);
        Assert.False(otherTenant.IsExternalOrderCreated);
    }
    [Fact]
    public void UnreviewedRecordNeverBecomesDryRunDraft()
    {
        var (review, audit, actor) = Valid();
        Assert.Throws<InvalidOperationException>(() =>
            PdmWorkOrderDraftFactory.Prepare(
                new PdmP2ReviewRecord { Id=review.Id, TenantId=review.TenantId, CustomerId=review.CustomerId, DeviceId=review.DeviceId, State="AwaitingHumanReview" }, audit, actor));
    }
}

