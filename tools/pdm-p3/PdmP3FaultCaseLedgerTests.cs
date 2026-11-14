using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3FaultCaseLedgerTests
{
    private static PdmP2TrustedActor Submitter(PdmP3SeriesScope scope) =>
        new(scope.TenantId,scope.CustomerId,Guid.NewGuid(),true,true,false);
    private static PdmP2TrustedActor Reviewer(PdmP3SeriesScope scope) =>
        new(scope.TenantId,scope.CustomerId,Guid.NewGuid(),true,false,true);

    private static async Task<(SqliteConnection Connection,PdmP3FaultCaseDbContext Db)> Open()
    {
        var connection=new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var db=new PdmP3FaultCaseDbContext(
            new DbContextOptionsBuilder<PdmP3FaultCaseDbContext>()
                .UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        return (connection,db);
    }

    [Fact]
    public async Task HumanReviewCreatesAuditedVerifiedLabelsOnlyAfterApproval()
    {
        var (con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope);
            var reviewer=Reviewer(scope);
            var service=new PdmP3FaultCaseLedger(db);
            var time=PdmP3Fixtures.Start.AddMinutes(15);
            var item=await service.SubmitAsync(scope,time,"maint-case-A","evidence-ticket-A",author);
            Assert.Equal("PendingReview",item.State);
            Assert.Empty(await service.GetVerifiedLabelsAsync(scope,DateTimeOffset.UtcNow,author));
            var verified=await service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedFault,
                "人工核验磨损证据",reviewer);
            Assert.Equal("ConfirmedFault",verified.State);
            Assert.Equal(2,verified.Revision);
            db.ChangeTracker.Clear();
            var labels=await service.GetVerifiedLabelsAsync(scope,DateTimeOffset.UtcNow,author);
            Assert.Single(labels);
            Assert.Equal(PdmP3FaultTruth.ConfirmedFault,labels[0].Truth);
            Assert.Equal("maint-case-A",labels[0].CaseReference);
            Assert.Equal(2,await db.Audits.CountAsync());
            Assert.All(await db.Audits.ToListAsync(),
                audit=>Assert.Equal(scope.TenantId,audit.TenantId));
        }
    }

    [Fact]
    public async Task AuthorAndCrossTenantCannotConfirmTheSameCase()
    {
        var (con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope);
            var reviewer=Reviewer(scope);
            var service=new PdmP3FaultCaseLedger(db);
            var item=await service.SubmitAsync(scope,PdmP3Fixtures.Start,
                "case-1","evidence-1",author);
            await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
                service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedNormal,"self",author with {CanReview=true}));
            await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
                service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedFault,"cross",
                    reviewer with {TenantId=Guid.NewGuid()}));
            Assert.Equal(1,await db.Audits.CountAsync());
        }
    }

    [Fact]
    public async Task DuplicateCaseAndOutdatedRevisionFailClosed()
    {
        var (con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope); var reviewer=Reviewer(scope);
            var service=new PdmP3FaultCaseLedger(db);
            var item=await service.SubmitAsync(scope,PdmP3Fixtures.Start,
                "case-A","evidence-A",author);
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                service.SubmitAsync(scope,PdmP3Fixtures.Start,"case-A2","evidence-A2",author));
            await service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedNormal,
                "正常工况人工确认",reviewer);
            await Assert.ThrowsAsync<DbUpdateConcurrencyException>(()=>
                service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedFault,
                    "stale review",reviewer));
            Assert.Equal(2,await db.Audits.CountAsync());
        }
    }

    [Fact]
    public async Task UnverifiedCaseOrAsOfBeforeReviewNeverBecomesGroundTruth()
    {
        var (con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope); var reviewer=Reviewer(scope);
            var service=new PdmP3FaultCaseLedger(db);
            var item=await service.SubmitAsync(scope,PdmP3Fixtures.Start,
                "case-A","evidence-A",author);
            var oldAsOf=PdmP3Fixtures.Start.AddMinutes(60);
            Assert.Empty(await service.GetVerifiedLabelsAsync(scope,oldAsOf,author));
            await service.VerifyAsync(item.Id,1,PdmP3FaultTruth.ConfirmedFault,
                "verified later",reviewer);
            Assert.Empty(await service.GetVerifiedLabelsAsync(scope,oldAsOf,author));
        }
    }

    [Fact]
    public async Task MoreThanFiveHundredReviewedLabelsMustFailInsteadOfTruncating()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope);
            var start=PdmP3Fixtures.Start.UtcDateTime;
            var now=DateTime.UtcNow;
            db.Cases.AddRange(Enumerable.Range(0,501).Select(i=>new PdmP3FaultCase {
                TenantId=scope.TenantId,CustomerId=scope.CustomerId,
                DeviceId=scope.DeviceId,ProfileId=scope.ProfileId,
                ProfileVersion=scope.ProfileVersion,PointKey=scope.PointKey,
                EngineeringUnit=scope.EngineeringUnit,OperatingMode=scope.OperatingMode,
                EventTimeUtc=start.AddMinutes(i),CaseReference="case-"+i,
                EvidenceReference="audited-source-"+i,
                State="ConfirmedNormal",Revision=2,SubmittedBy=Guid.NewGuid(),
                ReviewedBy=Guid.NewGuid(),SubmittedAtUtc=now,ReviewedAtUtc=now
            }));
            await db.SaveChangesAsync();
            db.ChangeTracker.Clear();
            var ledger=new PdmP3FaultCaseLedger(db);
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                ledger.GetVerifiedLabelsAsync(scope,DateTimeOffset.UtcNow,author));
        }
    }
    [Fact]
    public async Task UnverifiedScopeCannotCreateLabelCase()
    {
        var (con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Submitter(scope);
            var service=new PdmP3FaultCaseLedger(db);
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                service.SubmitAsync(scope with {UnitVerified=false},
                    PdmP3Fixtures.Start,"case","evidence",author));
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                service.SubmitAsync(scope,PdmP3Fixtures.Start,"case","",author));
            Assert.Empty(await db.Cases.ToListAsync());
        }
    }
}

