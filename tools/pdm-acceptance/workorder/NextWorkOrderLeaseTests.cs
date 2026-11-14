using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>
/// Isolated durable lease journal for testing work order failure semantics.
/// It cannot send, acknowledge or create any external work order.
/// </summary>
public sealed class NextSandboxLeaseJournal(SqliteConnection db)
{
    public async Task InitializeAsync()
    {
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
          CREATE TABLE IF NOT EXISTS PdmSandboxLease(
            Key TEXT PRIMARY KEY, Tenant TEXT NOT NULL, Customer TEXT NOT NULL,
            Review TEXT NOT NULL, State TEXT NOT NULL,
            Owner TEXT NULL, LeaseUntilUtc TEXT NULL, Attempts INTEGER NOT NULL DEFAULT 0);
          """;
        await cmd.ExecuteNonQueryAsync();
    }

    private static void Authorized(
        PdmP2TrustedActor actor,Guid tenant,Guid customer)
    {
        if(!actor.IsAuthenticated || !actor.CanReview ||
           actor.UserId==Guid.Empty || tenant==Guid.Empty || customer==Guid.Empty ||
           actor.TenantId!=tenant || actor.CustomerId!=customer)
            throw new UnauthorizedAccessException("Untrusted tenant/customer reviewer scope.");
    }

    public async Task PrepareAsync(string key,Guid tenant,Guid customer,
        Guid review,PdmP2TrustedActor actor)
    {
        Authorized(actor,tenant,customer);
        if(key.Length!=64 || key.Any(c=>c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
           review==Guid.Empty)
            throw new ArgumentException("Untrusted idempotency key or review identity.");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            INSERT INTO PdmSandboxLease(Key,Tenant,Customer,Review,State)
            VALUES($key,$tenant,$customer,$review,'Pending')
            ON CONFLICT(Key) DO NOTHING
            """;
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        cmd.Parameters.AddWithValue("$review",review.ToString("N"));
        await cmd.ExecuteNonQueryAsync();
        var row=await ReadAsync(key);
        if(row.TenantId!=tenant || row.CustomerId!=customer ||
           row.ReviewId!=review)
            throw new InvalidOperationException("Cross-scope idempotency collision.");
    }

    public sealed record State(
        string Key,Guid TenantId,Guid CustomerId,Guid ReviewId,
        string Status,string? Owner,DateTimeOffset? LeaseEnd,int Attempts,
        bool ExternalOrderCreated=false);

    public async Task<State> ReadAsync(string key)
    {
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            SELECT Tenant,Customer,Review,State,Owner,LeaseUntilUtc,Attempts
            FROM PdmSandboxLease WHERE Key=$key
            """;
        cmd.Parameters.AddWithValue("$key",key);
        await using var r=await cmd.ExecuteReaderAsync();
        if(!await r.ReadAsync())
            throw new KeyNotFoundException("No prepared draft.");
        return new(key,Guid.ParseExact(r.GetString(0),"N"),
            Guid.ParseExact(r.GetString(1),"N"),
            Guid.ParseExact(r.GetString(2),"N"),r.GetString(3),
            r.IsDBNull(4)?null:r.GetString(4),
            r.IsDBNull(5)?null:DateTimeOffset.Parse(
                r.GetString(5),System.Globalization.CultureInfo.InvariantCulture),
            r.GetInt32(6));
    }

    public async Task<bool> ClaimAsync(string key,Guid tenant,Guid customer,
        Guid review,PdmP2TrustedActor actor,string owner,
        DateTimeOffset nowUtc,TimeSpan lease)
    {
        Authorized(actor,tenant,customer);
        if(nowUtc.Offset!=TimeSpan.Zero || lease<TimeSpan.FromSeconds(5) ||
           lease>TimeSpan.FromMinutes(10) || string.IsNullOrWhiteSpace(owner) ||
           owner.Length>80)
            throw new ArgumentException("Invalid lease clock or owner.");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            UPDATE PdmSandboxLease
            SET State='Leased',Owner=$owner,LeaseUntilUtc=$until,Attempts=Attempts+1
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer AND Review=$review
              AND State='Pending' AND Owner IS NULL
            """;
        cmd.Parameters.AddWithValue("$owner",owner);
        cmd.Parameters.AddWithValue("$until",nowUtc.Add(lease).ToString("O"));
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        cmd.Parameters.AddWithValue("$review",review.ToString("N"));
        return await cmd.ExecuteNonQueryAsync()==1;
    }

    /// <summary>
    /// Unknown result after a lease EXPIRES must never be retried blindly:
    /// the remote API might have committed before the timeout.
    /// </summary>
    public async Task<bool> ExpireToReconciliationAsync(
        string key,DateTimeOffset nowUtc)
    {
        if(nowUtc.Offset!=TimeSpan.Zero)
            throw new ArgumentException("Lease clock must be UTC");
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            UPDATE PdmSandboxLease
            SET State='ReconciliationRequired'
            WHERE Key=$key AND State='Leased' AND LeaseUntilUtc < $now
            """;
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$now",nowUtc.ToString("O"));
        return await cmd.ExecuteNonQueryAsync()==1;
    }

    public async Task<bool> MarkSandboxAcceptedAsync(
        string key,string owner,Guid tenant,Guid customer,
        PdmP2TrustedActor actor)
    {
        Authorized(actor,tenant,customer);
        await using var cmd=db.CreateCommand();
        cmd.CommandText="""
            UPDATE PdmSandboxLease SET State='AcceptedInSandbox'
            WHERE Key=$key AND Owner=$owner AND Tenant=$tenant AND Customer=$customer
            AND State='Leased'
            """;
        cmd.Parameters.AddWithValue("$key",key);
        cmd.Parameters.AddWithValue("$owner",owner);
        cmd.Parameters.AddWithValue("$tenant",tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer",customer.ToString("N"));
        return await cmd.ExecuteNonQueryAsync()==1;
    }
}

public sealed class NextWorkOrderLeaseTests
{
    private static readonly DateTimeOffset Time=new(
        2026,11,14,0,0,0,TimeSpan.Zero);
    private static readonly string Key=new('a',64);
    private static (Guid Tenant,Guid Customer,Guid Review,
        PdmP2TrustedActor Actor) Setup()
    {
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();
        var review=Guid.NewGuid();
        return(tenant,customer,review,
            new(tenant,customer,Guid.NewGuid(),true,false,true));
    }
    private static async Task<SqliteConnection> Open(string file)
    {
        var db=new SqliteConnection("Data Source="+file+";Pooling=False");
        await db.OpenAsync();
        return db;
    }

    [Fact]
    public async Task OnePendingDraftCanHaveOnlyOneActiveLeaseAcrossConnections()
    {
        var file=Path.Combine(Path.GetTempPath(),"pdm-lease-"+Guid.NewGuid().ToString("N")+".db");
        var x=Setup();
        try
        {
            await using var a=await Open(file);
            await using var b=await Open(file);
            var first=new NextSandboxLeaseJournal(a);
            var second=new NextSandboxLeaseJournal(b);
            await first.InitializeAsync();
            await first.PrepareAsync(Key,x.Tenant,x.Customer,x.Review,x.Actor);
            Assert.True(await first.ClaimAsync(Key,x.Tenant,x.Customer,x.Review,
                x.Actor,"worker-1",Time,TimeSpan.FromSeconds(30)));
            Assert.False(await second.ClaimAsync(Key,x.Tenant,x.Customer,x.Review,
                x.Actor,"worker-2",Time,TimeSpan.FromSeconds(30)));
            Assert.Equal(1,(await second.ReadAsync(Key)).Attempts);
        }
        finally {if(File.Exists(file))File.Delete(file);}
    }

    [Fact]
    public async Task RestartAfterExpiredLeaseRequiresManualReconciliationNotResend()
    {
        var file=Path.Combine(Path.GetTempPath(),"pdm-lease-"+Guid.NewGuid().ToString("N")+".db");
        var x=Setup();
        try
        {
            await using(var db=await Open(file))
            {
                var journal=new NextSandboxLeaseJournal(db);
                await journal.InitializeAsync();
                await journal.PrepareAsync(Key,x.Tenant,x.Customer,x.Review,x.Actor);
                Assert.True(await journal.ClaimAsync(Key,x.Tenant,x.Customer,x.Review,
                    x.Actor,"crashed",Time,TimeSpan.FromSeconds(10)));
            }
            await using(var reopened=await Open(file))
            {
                var recovered=new NextSandboxLeaseJournal(reopened);
                Assert.True(await recovered.ExpireToReconciliationAsync(
                    Key,Time.AddMinutes(1)));
                Assert.Equal("ReconciliationRequired",(await recovered.ReadAsync(Key)).Status);
                Assert.False(await recovered.ClaimAsync(Key,x.Tenant,x.Customer,
                    x.Review,x.Actor,"retry",Time.AddMinutes(2),TimeSpan.FromSeconds(10)));
            }
        }
        finally {if(File.Exists(file))File.Delete(file);}
    }

    [Fact]
    public async Task CrossTenantAndWrongOwnerCannotAcceptOrClaim()
    {
        await using var db=new SqliteConnection("Data Source=:memory:");
        await db.OpenAsync();
        var journal=new NextSandboxLeaseJournal(db);
        await journal.InitializeAsync();
        var x=Setup();
        await journal.PrepareAsync(Key,x.Tenant,x.Customer,x.Review,x.Actor);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            journal.ClaimAsync(Key,Guid.NewGuid(),x.Customer,
                x.Review,x.Actor,"other",Time,TimeSpan.FromSeconds(10)));
        Assert.True(await journal.ClaimAsync(Key,x.Tenant,x.Customer,
            x.Review,x.Actor,"worker",Time,TimeSpan.FromSeconds(10)));
        Assert.False(await journal.MarkSandboxAcceptedAsync(
            Key,"forged",x.Tenant,x.Customer,x.Actor));
        Assert.Equal("Leased",(await journal.ReadAsync(Key)).Status);
        Assert.True(await journal.MarkSandboxAcceptedAsync(
            Key,"worker",x.Tenant,x.Customer,x.Actor));
        Assert.False((await journal.ReadAsync(Key)).ExternalOrderCreated);
    }

    [Fact]
    public async Task DuplicatePrepareSameKeyIsIdempotentButCrossReviewCollisionFails()
    {
        await using var db=new SqliteConnection("Data Source=:memory:");
        await db.OpenAsync();
        var journal=new NextSandboxLeaseJournal(db);
        await journal.InitializeAsync();
        var x=Setup();
        await journal.PrepareAsync(Key,x.Tenant,x.Customer,x.Review,x.Actor);
        await journal.PrepareAsync(Key,x.Tenant,x.Customer,x.Review,x.Actor);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>
            journal.PrepareAsync(Key,x.Tenant,x.Customer,Guid.NewGuid(),x.Actor));
        Assert.Equal(0,(await journal.ReadAsync(Key)).Attempts);
    }
}

