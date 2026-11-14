using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmP2PolicyStoreTests
{
    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
        DeviceId = Guid.NewGuid(), Version = 2,
        Enabled = true, PointMappingsVerified = true, RunStateVerified = true
    };

    private static PdmP2TrustedActor Submit(PdmDeviceProfile p) =>
        new(p.TenantId, p.CustomerId, Guid.NewGuid(), true, true, false);

    [Fact]
    public async Task DraftAndIndependentReviewPersistAuditAndNeverActivateProduction()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new PdmP2PolicyDbContext(
            new DbContextOptionsBuilder<PdmP2PolicyDbContext>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        var p = Profile();
        var submitter = Submit(p);
        var reviewer = new PdmP2TrustedActor(p.TenantId, p.CustomerId,
            Guid.NewGuid(), true, false, true);
        var store = new PdmP2PolicyStore(db);
        var created = await store.CreateAsync(p,
            new PdmAlertPolicy(MinimumOccurrences: 3, CooldownMinutes: 90), 1, submitter);
        Assert.Equal("Draft", created.Status);
        Assert.Null(await store.ResolveShadowAsync(p, submitter));
        var approved = await store.ReviewAsync(created.Id, 1, true,
            "Reviewed for dry-run shadow only", reviewer);
        Assert.Equal("ReviewedForShadow", approved.Status);
        Assert.False(approved.ProductionEnabled);
        var chosen = await store.ResolveShadowAsync(p, submitter);
        Assert.Equal(3, chosen!.MinimumOccurrences);
        Assert.Equal(90, chosen.CooldownMinutes);
        Assert.Equal(2, await db.Audits.CountAsync());
        db.ChangeTracker.Clear();
        var persisted = await db.Policies.SingleAsync();
        Assert.Equal(DateTimeKind.Utc, persisted.CreatedAtUtc.Kind);
        Assert.Equal(DateTimeKind.Utc, persisted.ReviewedAtUtc!.Value.Kind);
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(async () =>
            await store.ReviewAsync(created.Id, 1, false, "Stale", reviewer));
    }

    [Fact]
    public async Task SelfReviewCrossTenantAndDuplicateVersionFailClosed()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new PdmP2PolicyDbContext(
            new DbContextOptionsBuilder<PdmP2PolicyDbContext>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        var p = Profile();
        var author = Submit(p);
        var store = new PdmP2PolicyStore(db);
        var created = await store.CreateAsync(p, new PdmAlertPolicy(), 1, author);
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await store.CreateAsync(p, new PdmAlertPolicy(), 1, author));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await store.ReviewAsync(created.Id, 1, true, "own",
                author with { CanReview = true }));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await store.ReviewAsync(created.Id, 1, true, "foreign",
                author with { TenantId = Guid.NewGuid(), CanReview = true }));
        Assert.Equal(1, await db.Audits.CountAsync());
        Assert.Equal("Draft", (await db.Policies.SingleAsync()).Status);
    }

    [Fact]
    public async Task WithdrawalCannotBeTreatedAsPublishedShadowPolicy()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new PdmP2PolicyDbContext(
            new DbContextOptionsBuilder<PdmP2PolicyDbContext>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        var p = Profile();
        var author = Submit(p);
        var reviewer = new PdmP2TrustedActor(p.TenantId,p.CustomerId,
            Guid.NewGuid(),true,false,true);
        var store = new PdmP2PolicyStore(db);
        var item = await store.CreateAsync(p, new PdmAlertPolicy(), 3, author);
        await store.ReviewAsync(item.Id, 1, false, "No validated evidence", reviewer);
        Assert.Null(await store.ResolveShadowAsync(p, author));
        Assert.Equal(2, await db.Audits.CountAsync());
    }
}

