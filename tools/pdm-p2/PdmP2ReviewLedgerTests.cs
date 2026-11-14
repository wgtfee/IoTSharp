using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmP2ReviewLedgerTests
{
    private static (PdmReviewPacket Packet, PdmP2TrustedActor Author, PdmP2TrustedActor Reviewer)
        Data()
    {
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var actor = new PdmP2TrustedActor(tenant, customer, Guid.NewGuid(), true, true, false);
        var reviewer = new PdmP2TrustedActor(tenant, customer, Guid.NewGuid(), true, false, true);
        var packet = new PdmReviewPacket(
            tenant, customer, Guid.NewGuid(), Guid.NewGuid(), 2, Guid.NewGuid(),
            new string('a', 64), PdmReviewPacketState.AwaitingHumanReview,
            "validated", "仅供人工复核", new[] { "确认振动监测点" });
        return (packet, actor, reviewer);
    }

    [Fact]
    public async Task CreateAndRepeatDraft_AreIdempotentAndAuditedInSQLite()
    {
        await using var db = await Db();
        var (packet, author, _) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var first = await ledger.CreateDraftAsync(packet, author);
        var repeat = await ledger.CreateDraftAsync(packet, author);
        Assert.Equal(first.Id, repeat.Id);
        Assert.Equal(1, await db.Reviews.CountAsync());
        Assert.Equal(1, await db.Audits.CountAsync());
        Assert.Equal("DraftCreated", (await db.Audits.SingleAsync()).Action);
        Assert.Equal("AwaitingHumanReview", first.State);
    }

    [Fact]
    public async Task ReviewerDecision_IsPersistentButNeverExecutesAnOrder()
    {
        await using var db = await Db();
        var (packet, author, reviewer) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var created = await ledger.CreateDraftAsync(packet, author);
        var decided = await ledger.DecideAsync(created.Id, 1, true, "现场审核通过，仅进入规划", reviewer);
        Assert.Equal("ApprovedForPlanning", decided.State);
        Assert.Equal(2, decided.Revision);
        Assert.Equal(2, await db.Audits.CountAsync());
        Assert.Equal("ApprovedForPlanning", (await db.Audits.OrderBy(x => x.AtUtc)
            .LastAsync()).Action);
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(async () =>
            await ledger.DecideAsync(created.Id, 1, false, "重复操作", reviewer));
        Assert.Equal(2, await db.Audits.CountAsync());
    }

    [Fact]
    public async Task RejectionIsAuditedAndCannotBeOverturnedSilently()
    {
        await using var db = await Db();
        var (packet, author, reviewer) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var created = await ledger.CreateDraftAsync(packet, author);
        var result = await ledger.DecideAsync(created.Id, 1, false, "证据不足", reviewer);
        Assert.Equal("Rejected", result.State);
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(async () =>
            await ledger.DecideAsync(created.Id, 2, true, "尝试覆盖", reviewer));
        Assert.Equal(2, await db.Audits.CountAsync());
    }

    [Fact]
    public async Task CrossScopeOrUnverifiedReviewerCannotReadOrDecideAnotherTenant()
    {
        await using var db = await Db();
        var (packet, author, reviewer) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var created = await ledger.CreateDraftAsync(packet, author);
        var wrongTenant = reviewer with { TenantId = Guid.NewGuid() };
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await ledger.DecideAsync(created.Id, 1, true, "cross-tenant", wrongTenant));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await ledger.DecideAsync(created.Id, 1, true, "not reviewer", author));
        var wrongAuthor = author with { CustomerId = Guid.NewGuid() };
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await ledger.CreateDraftAsync(packet, wrongAuthor));
        Assert.Equal("AwaitingHumanReview", (await db.Reviews.SingleAsync()).State);
    }

    [Fact]
    public async Task IncompleteOrForgedPacketIsNeverPersisted()
    {
        await using var db = await Db();
        var (packet, author, _) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await ledger.CreateDraftAsync(packet with { Fingerprint = "invalid" }, author));
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await ledger.CreateDraftAsync(packet with { IsWorkOrderCreated = true }, author));
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await ledger.CreateDraftAsync(packet with { State = PdmReviewPacketState.Blocked }, author));
        Assert.Equal(0, await db.Reviews.CountAsync());
        Assert.Equal(0, await db.Audits.CountAsync());
    }

    [Fact]
    public async Task AuthorCannotApproveOwnDraft_EvenWithReviewerRole()
    {
        await using var db = await Db();
        var (packet, author, _) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var draft = await ledger.CreateDraftAsync(packet, author);
        var selfReviewer = author with { CanReview = true };
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await ledger.DecideAsync(draft.Id, 1, true, "Self approval forbidden", selfReviewer));
        Assert.Equal("AwaitingHumanReview", (await db.Reviews.SingleAsync()).State);
        Assert.Equal(1, await db.Audits.CountAsync());
    }

    [Fact]
    public async Task UppercaseFingerprintsAreSameDraftAndProduceOneAudit()
    {
        await using var db = await Db();
        var (packet, author, _) = Data();
        var initial = packet with { Fingerprint = new string('A', 64) };
        var ledger = new PdmP2ReviewLedger(db);
        var first = await ledger.CreateDraftAsync(initial, author);
        var again = await ledger.CreateDraftAsync(
            initial with { Fingerprint = new string('a', 64) }, author);
        Assert.Equal(first.Id, again.Id);
        Assert.Equal(1, await db.Reviews.CountAsync());
        Assert.Equal(1, await db.Audits.CountAsync());
    }
    [Fact]
    public async Task PersistedReviewAndAuditTimesRoundTripAsUtc()
    {
        await using var db = await Db();
        var (packet, author, reviewer) = Data();
        var ledger = new PdmP2ReviewLedger(db);
        var record = await ledger.CreateDraftAsync(packet, author);
        await ledger.DecideAsync(record.Id, 1, true, "审核记录 UTC 核验", reviewer);
        db.ChangeTracker.Clear();

        var roundtrip = await db.Reviews.AsNoTracking().SingleAsync();
        var audits = await db.Audits.AsNoTracking().OrderBy(x => x.AtUtc).ToListAsync();
        Assert.Equal(DateTimeKind.Utc, roundtrip.CreatedAtUtc.Kind);
        Assert.Equal(DateTimeKind.Utc, roundtrip.UpdatedAtUtc.Kind);
        Assert.All(audits, x => Assert.Equal(DateTimeKind.Utc, x.AtUtc.Kind));
        Assert.Equal(2, audits.Count);
    }
    private static async Task<PdmP2ReviewDbContext> Db()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<PdmP2ReviewDbContext>()
            .UseSqlite(connection).Options;
        var db = new PdmP2ReviewDbContext(options);
        await db.Database.EnsureCreatedAsync();
        // SQLite in-memory connection is owned by the provider until test disposal.
        return db;
    }
}

