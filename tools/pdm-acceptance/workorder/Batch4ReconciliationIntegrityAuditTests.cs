using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

public sealed record Batch4ReconciliationAuditResult(
    bool TwoPersonReviewIsInternallyConsistent,string Reason,
    bool ExternalOrderExistenceIndependentlyVerified=false,
    bool AutomaticRetryAllowed=false);

/// <summary>
/// Read-only, tenant-scoped cross-table integrity inspection after manual
/// work-order reconciliation. It does not resolve remote uncertainty, and can
/// never grant permission to send or retry a work order.
/// </summary>
public static class Batch4ReconciliationIntegrityAudit
{
    public static async Task<Batch4ReconciliationAuditResult> InspectAsync(
        SqliteConnection db,string key,Guid tenant,Guid customer,
        string evidenceSha256,CancellationToken ct=default)
    {
        if(string.IsNullOrWhiteSpace(key) || tenant==Guid.Empty || customer==Guid.Empty ||
           evidenceSha256 is not {Length:64} ||
           evidenceSha256.Any(x=>x is not (>= 'a' and <= 'f' or >= '0' and <= '9')))
            return new(false,"Invalid audit scope, idempotency key or provenance.");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            SELECT r.Tenant,r.Customer,r.Review,r.EvidenceSha256,
                   r.RequestedBy,r.ReviewedBy,r.State,
                   o.Tenant,o.Customer,o.Review,o.State
            FROM PdmSandboxManualReconcile r
            JOIN PdmSandboxLease o ON o.Key=r.Key
            WHERE r.Key=$key AND r.Tenant=$tenant AND r.Customer=$customer
              AND o.Tenant=$tenant AND o.Customer=$customer
            """;
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        await using var reader=await cmd.ExecuteReaderAsync(ct);
        if(!await reader.ReadAsync(ct))
            return new(false,"No tenant-scoped joined review and pending outbox found.");

        var requestor=reader.GetString(4);
        var reviewer=reader.IsDBNull(5)?null:reader.GetString(5);
        var state=reader.GetString(6);
        if(reader.GetString(0)!=reader.GetString(7) ||
           reader.GetString(1)!=reader.GetString(8) ||
           reader.GetString(2)!=reader.GetString(9) ||
           reader.GetString(3)!=evidenceSha256 ||
           !Guid.TryParse(requestor,out var requester) || requester==Guid.Empty ||
           !Guid.TryParse(reviewer,out var reviewerId) || reviewerId==Guid.Empty ||
           string.Equals(requestor,reviewer,StringComparison.Ordinal) ||
           state is not ("ExternalExistsManuallyReviewed" or
               "NoExternalOrderManuallyReviewed") ||
           reader.GetString(10)!="ReconciliationRequired")
            return new(false,"Evidence, reviewer separation or unresolved outbox status mismatch.");

        return new(true,"Two-person database reconciliation is internally consistent; " +
            "remote order existence and automatic retry remain unverified.");
    }
}

public sealed class Batch4ReconciliationIntegrityAuditTests
{
    private static readonly DateTimeOffset At =
        new(2026,11,14,0,0,0,TimeSpan.Zero);
    private const string Key="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly string Sha=new('a',64);

    private sealed record Setup(
        SqliteConnection Db,NextSandboxLeaseJournal Outbox,
        Batch3ManualReconciliationJournal Manual,
        Guid Tenant,Guid Customer,PdmP2TrustedActor First);

    private static PdmP2TrustedActor Actor(Guid tenant,Guid customer) =>
        new(tenant,customer,Guid.NewGuid(),true,false,true);

    private static async Task<Setup> CreateAsync(string connectionString)
    {
        var db=new SqliteConnection(connectionString);
        await db.OpenAsync();
        var outbox=new NextSandboxLeaseJournal(db);
        await outbox.InitializeAsync();
        var manual=new Batch3ManualReconciliationJournal(db,outbox);
        await manual.InitializeAsync();
        var tenant=Guid.NewGuid();
        var customer=Guid.NewGuid();
        var first=Actor(tenant,customer);
        var review=Guid.NewGuid();
        await outbox.PrepareAsync(Key,tenant,customer,review,first);
        Assert.True(await outbox.ClaimAsync(Key,tenant,customer,review,
            first,"unknown-worker",At,TimeSpan.FromSeconds(5)));
        Assert.True(await outbox.ExpireToReconciliationAsync(Key,At.AddMinutes(1)));
        await manual.BeginAsync(Key,tenant,customer,first,Sha,At.AddMinutes(2));
        return new(db,outbox,manual,tenant,customer,first);
    }

    [Fact]
    public async Task SecondReviewerCreatesAuditableButNonExecutableConclusion()
    {
        var s=await CreateAsync("Data Source=:memory:");
        await using var db=s.Db;
        var pending=await Batch4ReconciliationIntegrityAudit.InspectAsync(
            db,Key,s.Tenant,s.Customer,Sha);
        Assert.False(pending.TwoPersonReviewIsInternallyConsistent);
        Assert.True(await s.Manual.SecondReviewAsync(Key,s.Tenant,s.Customer,
            Actor(s.Tenant,s.Customer),Sha,true,At.AddMinutes(3)));
        var audited=await Batch4ReconciliationIntegrityAudit.InspectAsync(
            db,Key,s.Tenant,s.Customer,Sha);
        Assert.True(audited.TwoPersonReviewIsInternallyConsistent,audited.Reason);
        Assert.False(audited.ExternalOrderExistenceIndependentlyVerified);
        Assert.False(audited.AutomaticRetryAllowed);
    }

    [Fact]
    public async Task TamperedOutboxTransitionMakesPreviouslyReviewedCaseInvalid()
    {
        var s=await CreateAsync("Data Source=:memory:");
        await using var db=s.Db;
        Assert.True(await s.Manual.SecondReviewAsync(Key,s.Tenant,s.Customer,
            Actor(s.Tenant,s.Customer),Sha,false,At.AddMinutes(3)));
        await using(var tamper=db.CreateCommand())
        {
            tamper.CommandText="UPDATE PdmSandboxLease SET State='Pending' WHERE Key=$key";
            tamper.Parameters.AddWithValue("$key",Key);
            await tamper.ExecuteNonQueryAsync();
        }
        var audit=await Batch4ReconciliationIntegrityAudit.InspectAsync(
            db,Key,s.Tenant,s.Customer,Sha);
        Assert.False(audit.TwoPersonReviewIsInternallyConsistent);
        Assert.False(audit.AutomaticRetryAllowed);
    }

    [Fact]
    public async Task CrossTenantOrChangedEvidenceHasNoJoinedApproval()
    {
        var s=await CreateAsync("Data Source=:memory:");
        await using var db=s.Db;
        Assert.True(await s.Manual.SecondReviewAsync(Key,s.Tenant,s.Customer,
            Actor(s.Tenant,s.Customer),Sha,false,At.AddMinutes(3)));
        Assert.False((await Batch4ReconciliationIntegrityAudit.InspectAsync(
            db,Key,Guid.NewGuid(),s.Customer,Sha)).TwoPersonReviewIsInternallyConsistent);
        Assert.False((await Batch4ReconciliationIntegrityAudit.InspectAsync(
            db,Key,s.Tenant,s.Customer,new string('b',64))).TwoPersonReviewIsInternallyConsistent);
    }

    [Fact]
    public async Task RestartPreservesTwoPersonReviewAndNeverIssuesRemoteOrder()
    {
        var file=Path.Combine(Path.GetTempPath(),
            "pdm-batch4-workorder-"+Guid.NewGuid().ToString("N")+".db");
        try
        {
            var s=await CreateAsync("Data Source="+file+";Pooling=False");
            Assert.True(await s.Manual.SecondReviewAsync(Key,s.Tenant,s.Customer,
                Actor(s.Tenant,s.Customer),Sha,true,At.AddMinutes(3)));
            await s.Db.DisposeAsync();
            await using var db=new SqliteConnection("Data Source="+file+";Pooling=False");
            await db.OpenAsync();
            var audit=await Batch4ReconciliationIntegrityAudit.InspectAsync(
                db,Key,s.Tenant,s.Customer,Sha);
            Assert.True(audit.TwoPersonReviewIsInternallyConsistent,audit.Reason);
            Assert.False(audit.ExternalOrderExistenceIndependentlyVerified);
        }
        finally {if(File.Exists(file))File.Delete(file);}
    }
}

