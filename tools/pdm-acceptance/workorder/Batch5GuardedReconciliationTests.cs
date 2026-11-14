using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>
/// Atomic, tenant-scoped second-review guard over durable isolated outbox.
/// The original unknown external outcome is never reset or retransmitted.
/// No HTTP/MES/PLC/production service dependency.
/// </summary>
public sealed class Batch5GuardedReconciliation(SqliteConnection db)
{
    public async Task<bool> ConfirmAsync(
        string key,Guid tenant,Guid customer,PdmP2TrustedActor reviewer,
        string evidenceSha256,bool externalExists,DateTimeOffset atUtc,
        CancellationToken ct=default)
    {
        ct.ThrowIfCancellationRequested();
        if(!reviewer.IsAuthenticated || !reviewer.CanReview ||
           reviewer.UserId==Guid.Empty || reviewer.TenantId!=tenant ||
           reviewer.CustomerId!=customer ||
           tenant==Guid.Empty || customer==Guid.Empty)
            throw new UnauthorizedAccessException("Reviewer must be authenticated in the same tenant/customer.");
        if(string.IsNullOrWhiteSpace(key) || evidenceSha256 is not {Length:64} ||
           evidenceSha256.Any(c=>c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
           atUtc.Offset!=TimeSpan.Zero)
            throw new ArgumentException("Invalid reconciliation provenance or UTC time.");

        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            UPDATE PdmSandboxManualReconcile
            SET State=$state, ReviewedBy=$reviewer
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
              AND EvidenceSha256=$sha
              AND State='PendingSecondReview'
              AND RequestedBy<>$reviewer
              AND AtUtc<=$now
              AND EXISTS (
                SELECT 1 FROM PdmSandboxLease o
                WHERE o.Key=PdmSandboxManualReconcile.Key
                  AND o.Tenant=PdmSandboxManualReconcile.Tenant
                  AND o.Customer=PdmSandboxManualReconcile.Customer
                  AND o.Review=PdmSandboxManualReconcile.Review
                  AND o.State='ReconciliationRequired'
              )
            """;
        cmd.Parameters.AddWithValue("$state",
            externalExists?"ExternalExistsManuallyReviewed":"NoExternalOrderManuallyReviewed");
        cmd.Parameters.AddWithValue("$reviewer",reviewer.UserId.ToString("N"));
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        cmd.Parameters.AddWithValue("$sha",evidenceSha256);
        cmd.Parameters.AddWithValue("$now",atUtc.ToString("O"));
        return await cmd.ExecuteNonQueryAsync(ct)==1;
    }
}

public sealed class Batch5GuardedReconciliationTests
{
    private const string Key="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private static readonly DateTimeOffset At=new(2026,11,14,0,0,0,TimeSpan.Zero);
    private static readonly string Sha=new('a',64);
    private static PdmP2TrustedActor Actor(Guid tenant,Guid customer)=>
        new(tenant,customer,Guid.NewGuid(),true,false,true);

    private static async Task<(SqliteConnection Db,NextSandboxLeaseJournal Source,
        Batch3ManualReconciliationJournal Manual,Guid Tenant,Guid Customer,
        PdmP2TrustedActor First)> Prepared(string connection)
    {
        var db=new SqliteConnection(connection);
        await db.OpenAsync();
        var outbox=new NextSandboxLeaseJournal(db);
        await outbox.InitializeAsync();
        var manual=new Batch3ManualReconciliationJournal(db,outbox);
        await manual.InitializeAsync();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();
        var user=Actor(tenant,customer);
        var review=Guid.NewGuid();
        await outbox.PrepareAsync(Key,tenant,customer,review,user);
        Assert.True(await outbox.ClaimAsync(Key,tenant,customer,review,
            user,"worker",At,TimeSpan.FromSeconds(5)));
        Assert.True(await outbox.ExpireToReconciliationAsync(Key,At.AddMinutes(2)));
        await manual.BeginAsync(Key,tenant,customer,user,Sha,At.AddMinutes(3));
        return(db,outbox,manual,tenant,customer,user);
    }

    [Fact]
    public async Task AuthorizedDifferentReviewerCanConfirmOnlyOnce()
    {
        var x=await Prepared("Data Source=:memory:");
        await using var db=x.Db;
        var reviewer=Actor(x.Tenant,x.Customer);
        var guarded=new Batch5GuardedReconciliation(db);
        Assert.True(await guarded.ConfirmAsync(
            Key,x.Tenant,x.Customer,reviewer,Sha,true,At.AddMinutes(4)));
        Assert.False(await guarded.ConfirmAsync(
            Key,x.Tenant,x.Customer,Actor(x.Tenant,x.Customer),Sha,false,At.AddMinutes(5)));
        Assert.Equal("ReconciliationRequired",(await x.Source.ReadAsync(Key)).Status);
    }

    [Fact]
    public async Task AlteredOutboxBeforeSecondReviewMustBlockWithoutMarkingReviewAccepted()
    {
        var x=await Prepared("Data Source=:memory:");
        await using var db=x.Db;
        await using(var tamper=db.CreateCommand())
        {
            tamper.CommandText="UPDATE PdmSandboxLease SET State='Pending' WHERE Key=$key";
            tamper.Parameters.AddWithValue("$key",Key);
            await tamper.ExecuteNonQueryAsync();
        }
        var guarded=new Batch5GuardedReconciliation(db);
        Assert.False(await guarded.ConfirmAsync(Key,x.Tenant,x.Customer,
            Actor(x.Tenant,x.Customer),Sha,false,At.AddMinutes(4)));
        Assert.Equal("PendingSecondReview",(await x.Manual.ReadAsync(Key)).State);
    }

    [Fact]
    public async Task WrongTenantOrSelfReviewNeverConfirms()
    {
        var x=await Prepared("Data Source=:memory:");
        await using var db=x.Db;
        var guard=new Batch5GuardedReconciliation(db);
        Assert.False(await guard.ConfirmAsync(Key,x.Tenant,x.Customer,x.First,
            Sha,true,At.AddMinutes(4)));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>guard.ConfirmAsync(
            Key,Guid.NewGuid(),x.Customer,Actor(x.Tenant,x.Customer),
            Sha,false,At.AddMinutes(4)));
        Assert.Equal("PendingSecondReview",(await x.Manual.ReadAsync(Key)).State);
    }

    [Fact]
    public async Task RestartStillEnforcesOriginalOutboxStateAndEvidenceSha()
    {
        var path=Path.Combine(Path.GetTempPath(),"pdm-batch5-reconcile-"+Guid.NewGuid().ToString("N")+".sqlite");
        try
        {
            var x=await Prepared("Data Source="+path+";Pooling=False");
            var tenant=x.Tenant;var customer=x.Customer;
            await x.Db.DisposeAsync();
            await using var reopened=new SqliteConnection("Data Source="+path+";Pooling=False");
            await reopened.OpenAsync();
            var guard=new Batch5GuardedReconciliation(reopened);
            Assert.False(await guard.ConfirmAsync(Key,tenant,customer,
                Actor(tenant,customer),new string('b',64),false,At.AddMinutes(4)));
            Assert.True(await guard.ConfirmAsync(Key,tenant,customer,
                Actor(tenant,customer),Sha,true,At.AddMinutes(4)));
            var audit=await Batch4ReconciliationIntegrityAudit.InspectAsync(
                reopened,Key,tenant,customer,Sha);
            Assert.True(audit.TwoPersonReviewIsInternallyConsistent,audit.Reason);
            Assert.False(audit.AutomaticRetryAllowed);
        }
        finally{SqliteConnection.ClearAllPools();File.Delete(path);}
    }
}

