using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

public sealed record Batch3ReconciliationSnapshot(
    string IdempotencyKey,string State,Guid RequestedBy,
    Guid? ReviewedBy,string EvidenceSha256,
    bool AllowsAutomaticRetry=false,bool CreatedExternalOrder=false);

/// <summary>
/// Only fake SQLite: two-person review of a lease that timed out with unknown
/// remote effect. A review is NOT permission to dispatch or retry. This
/// component never makes HTTP calls, sends PLC instructions, or creates orders.
/// </summary>
public sealed class Batch3ManualReconciliationJournal(
    SqliteConnection db,NextSandboxLeaseJournal original)
{
    public async Task InitializeAsync()
    {
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            CREATE TABLE IF NOT EXISTS PdmSandboxManualReconcile(
              Key TEXT PRIMARY KEY REFERENCES PdmSandboxLease(Key) ON DELETE RESTRICT,
              Tenant TEXT NOT NULL, Customer TEXT NOT NULL, Review TEXT NOT NULL,
              EvidenceSha256 TEXT NOT NULL, RequestedBy TEXT NOT NULL,
              ReviewedBy TEXT NULL, State TEXT NOT NULL, AtUtc TEXT NOT NULL
            );
            """;
        await cmd.ExecuteNonQueryAsync();
    }

    private static void Guard(
        PdmP2TrustedActor actor,Guid tenant,Guid customer)
    {
        if(!actor.IsAuthenticated || !actor.CanReview ||
            actor.UserId==Guid.Empty || actor.TenantId!=tenant ||
            actor.CustomerId!=customer || tenant==Guid.Empty ||
            customer==Guid.Empty)
            throw new UnauthorizedAccessException("Reviewer identity or tenant scope invalid.");
    }

    public async Task BeginAsync(string key,Guid tenant,Guid customer,
        PdmP2TrustedActor actor,string evidenceSha256,DateTimeOffset atUtc)
    {
        Guard(actor,tenant,customer);
        if(atUtc.Offset!=TimeSpan.Zero ||
           evidenceSha256 is not {Length:64} ||
           evidenceSha256.Any(c=> c is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            throw new ArgumentException("A UTC review event and verifiable evidence SHA are required.");
        var source=await original.ReadAsync(key);
        if(source.StateNotReconcilable() || source.TenantId!=tenant ||
           source.CustomerId!=customer)
            throw new InvalidOperationException("Only the trusted scoped unknown-result outbox may be reconciled.");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            INSERT INTO PdmSandboxManualReconcile
            (Key,Tenant,Customer,Review,EvidenceSha256,RequestedBy,State,AtUtc)
            VALUES($key,$tenant,$customer,$review,$sha,$actor,'PendingSecondReview',$at)
            """;
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        cmd.Parameters.AddWithValue("$review",source.ReviewId.ToString("N"));
        cmd.Parameters.AddWithValue("$sha",evidenceSha256);
        cmd.Parameters.AddWithValue("$actor",actor.UserId.ToString("N"));
        cmd.Parameters.AddWithValue("$at",atUtc.ToString("O"));
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<bool> SecondReviewAsync(string key,Guid tenant,Guid customer,
        PdmP2TrustedActor actor,string evidenceSha256,
        bool externalExists,DateTimeOffset atUtc)
    {
        Guard(actor,tenant,customer);
        if(atUtc.Offset!=TimeSpan.Zero || evidenceSha256 is not {Length:64})
            throw new ArgumentException("Evidence SHA and UTC timestamp required.");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            UPDATE PdmSandboxManualReconcile
            SET State=$state,ReviewedBy=$actor
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
            AND EvidenceSha256=$sha AND State='PendingSecondReview'
            AND RequestedBy<>$actor AND AtUtc<=$at
            """;
        cmd.Parameters.AddWithValue("$state",externalExists
            ?"ExternalExistsManuallyReviewed":"NoExternalOrderManuallyReviewed");
        cmd.Parameters.AddWithValue("$actor",actor.UserId.ToString("N"));
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        cmd.Parameters.AddWithValue("$sha",evidenceSha256);
        cmd.Parameters.AddWithValue("$at",atUtc.ToString("O"));
        return await cmd.ExecuteNonQueryAsync()==1;
    }

    public async Task<Batch3ReconciliationSnapshot> ReadAsync(string key)
    {
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            SELECT State,RequestedBy,ReviewedBy,EvidenceSha256
            FROM PdmSandboxManualReconcile WHERE Key=$key
            """;
        cmd.Parameters.AddWithValue("$key",key);
        await using var r=await cmd.ExecuteReaderAsync();
        if(!await r.ReadAsync())
            throw new KeyNotFoundException("No reconciliation review row.");
        return new(key,r.GetString(0),Guid.ParseExact(r.GetString(1),"N"),
            r.IsDBNull(2)?null:Guid.ParseExact(r.GetString(2),"N"),
            r.GetString(3));
    }
}

internal static class Batch3ReconcileGuardExtension
{
    internal static bool StateNotReconcilable(
        this NextSandboxLeaseJournal.State row)
        => row.Status!="ReconciliationRequired";
}

public sealed class Batch3WorkOrderReconciliationTests
{
    private const string Key="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTimeOffset At =
        new(2026,11,14,0,0,0,TimeSpan.Zero);
    private static readonly string Sha=new('a',64);

    private static PdmP2TrustedActor Actor(Guid tenant,Guid customer)=>
        new(tenant,customer,Guid.NewGuid(),true,false,true);

    private static async Task<(SqliteConnection Db,NextSandboxLeaseJournal Outbox,
        Batch3ManualReconciliationJournal Review,Guid Tenant,Guid Customer,
        PdmP2TrustedActor Author)> OpenUnknown(string uri)
    {
        var db=new SqliteConnection(uri);
        await db.OpenAsync();
        var outbox=new NextSandboxLeaseJournal(db);
        await outbox.InitializeAsync();
        var review=new Batch3ManualReconciliationJournal(db,outbox);
        await review.InitializeAsync();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();
        var sourceReview=Guid.NewGuid();var actor=Actor(tenant,customer);
        await outbox.PrepareAsync(Key,tenant,customer,sourceReview,actor);
        Assert.True(await outbox.ClaimAsync(Key,tenant,customer,sourceReview,
            actor,"simulated-worker",At,TimeSpan.FromSeconds(5)));
        Assert.True(await outbox.ExpireToReconciliationAsync(Key,At.AddMinutes(2)));
        return(db,outbox,review,tenant,customer,actor);
    }

    [Fact]
    public async Task SecondReviewerRequiredAndNoAutoRetryAfterUnknownRemoteResult()
    {
        var state=await OpenUnknown("Data Source=:memory:");
        await using var db=state.Db;
        await state.Review.BeginAsync(Key,state.Tenant,state.Customer,
            state.Author,Sha,At.AddMinutes(3));
        Assert.False(await state.Review.SecondReviewAsync(Key,state.Tenant,
            state.Customer,state.Author,Sha,true,At.AddMinutes(4)));
        var other=Actor(state.Tenant,state.Customer);
        Assert.True(await state.Review.SecondReviewAsync(Key,state.Tenant,
            state.Customer,other,Sha,true,At.AddMinutes(4)));
        var final=await state.Review.ReadAsync(Key);
        Assert.Equal("ExternalExistsManuallyReviewed",final.State);
        Assert.Equal(other.UserId,final.ReviewedBy);
        Assert.False(final.AllowsAutomaticRetry);
        Assert.False(final.CreatedExternalOrder);
        Assert.False(await state.Review.SecondReviewAsync(Key,state.Tenant,
            state.Customer,Actor(state.Tenant,state.Customer),Sha,false,
            At.AddMinutes(5)));
        Assert.Equal("ReconciliationRequired",(await state.Outbox.ReadAsync(Key)).Status);
    }

    [Fact]
    public async Task IncorrectScopeOrChangedEvidenceCannotApprove()
    {
        var state=await OpenUnknown("Data Source=:memory:");
        await using var db=state.Db;
        await state.Review.BeginAsync(Key,state.Tenant,state.Customer,
            state.Author,Sha,At.AddMinutes(3));
        var secondary=Actor(state.Tenant,state.Customer);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
            state.Review.SecondReviewAsync(Key,Guid.NewGuid(),state.Customer,
                secondary,Sha,false,At.AddMinutes(4)));
        Assert.False(await state.Review.SecondReviewAsync(Key,state.Tenant,
            state.Customer,secondary,new string('c',64),false,At.AddMinutes(4)));
        Assert.Equal("PendingSecondReview",(await state.Review.ReadAsync(Key)).State);
    }

    [Fact]
    public async Task ReconciliationReviewSurvivesSQLiteConnectionRestart()
    {
        var file=Path.Combine(Path.GetTempPath(),
            "pdm-batch3-reconcile-"+Guid.NewGuid().ToString("N")+".db");
        try
        {
            var initial=await OpenUnknown("Data Source="+file+";Pooling=False");
            await initial.Review.BeginAsync(Key,initial.Tenant,initial.Customer,
                initial.Author,Sha,At.AddMinutes(3));
            await initial.Db.DisposeAsync();
            await using var reopened=new SqliteConnection("Data Source="+file+";Pooling=False");
            await reopened.OpenAsync();
            var restored=new Batch3ManualReconciliationJournal(
                reopened,new NextSandboxLeaseJournal(reopened));
            var result=await restored.ReadAsync(Key);
            Assert.Equal("PendingSecondReview",result.State);
            Assert.False(result.AllowsAutomaticRetry);
        }
        finally {if(File.Exists(file))File.Delete(file);}
    }
}

