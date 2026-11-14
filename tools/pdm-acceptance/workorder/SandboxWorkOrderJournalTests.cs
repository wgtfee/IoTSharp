using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>
/// Only the ISOLATED test database contains this table. Production systems
/// must use a separately designed, audited outbox + provider contract.
/// </summary>
public sealed record SandboxWorkOrderRow(
    string Key, Guid TenantId, Guid CustomerId, Guid ReviewId,
    Guid DeviceId, string State, int Attempts,
    bool ExternalOrderCreated = false);

public interface ISandboxWorkOrderSender
{
    Task<bool> SimulateAsync(string key, CancellationToken ct);
}

public sealed class SandboxWorkOrderJournal(SqliteConnection connection, ISandboxWorkOrderSender sender)
{
    public async Task InitializeAsync()
    {
        await using var command=connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS PdmSandboxWorkOrderJournal (
              IdempotencyKey TEXT PRIMARY KEY,
              TenantId TEXT NOT NULL,
              CustomerId TEXT NOT NULL,
              ReviewId TEXT NOT NULL,
              DeviceId TEXT NOT NULL,
              State TEXT NOT NULL,
              Attempts INTEGER NOT NULL DEFAULT 0
            );
            """;
        await command.ExecuteNonQueryAsync();
    }

    private static void Authenticate(PdmWorkOrderDraft draft,PdmP2TrustedActor actor,string token)
    {
        if(!actor.IsAuthenticated || !actor.CanReview ||
           actor.UserId==Guid.Empty || actor.TenantId==Guid.Empty ||
           actor.CustomerId==Guid.Empty || actor.TenantId!=draft.TenantId ||
           actor.CustomerId!=draft.CustomerId ||
           draft.SourceReviewId==Guid.Empty || draft.DeviceId==Guid.Empty ||
           draft.IsExternalOrderCreated || !draft.RequiresHumanDispatchApproval ||
           draft.CorrelationKey is not {Length:64} ||
           draft.CorrelationKey.Any(c=>c is not (>= '0' and <= '9' or >= 'a' and <= 'f')) ||
           token!="isolated-sandbox-token-not-for-production")
            throw new UnauthorizedAccessException("Sandbox token or review scope not authorized");
    }

    public async Task<SandboxWorkOrderRow> PrepareAsync(PdmWorkOrderDraft draft,
        PdmP2TrustedActor actor,string token,CancellationToken ct=default)
    {
        Authenticate(draft,actor,token);
        await using(var insert=connection.CreateCommand())
        {
            insert.CommandText = """
                INSERT OR IGNORE INTO PdmSandboxWorkOrderJournal
                (IdempotencyKey,TenantId,CustomerId,ReviewId,DeviceId,State,Attempts)
                VALUES ($key,$tenant,$customer,$review,$device,'Pending',0)
                """;
            insert.Parameters.AddWithValue("$key",draft.CorrelationKey);
            insert.Parameters.AddWithValue("$tenant",draft.TenantId.ToString("N"));
            insert.Parameters.AddWithValue("$customer",draft.CustomerId.ToString("N"));
            insert.Parameters.AddWithValue("$review",draft.SourceReviewId.ToString("N"));
            insert.Parameters.AddWithValue("$device",draft.DeviceId.ToString("N"));
            await insert.ExecuteNonQueryAsync(ct);
        }
        var existing=await ReadAsync(draft.CorrelationKey,ct)
            ?? throw new InvalidOperationException("Sandbox outbox write failed");
        if(existing.TenantId!=draft.TenantId ||
           existing.CustomerId!=draft.CustomerId ||
           existing.ReviewId!=draft.SourceReviewId ||
           existing.DeviceId!=draft.DeviceId)
            throw new InvalidOperationException("Idempotency key collision across review scope");
        return existing;
    }

    public async Task<SandboxWorkOrderRow?> ReadAsync(string key,CancellationToken ct=default)
    {
        await using var cmd=connection.CreateCommand();
        cmd.CommandText="""
            SELECT TenantId,CustomerId,ReviewId,DeviceId,State,Attempts
            FROM PdmSandboxWorkOrderJournal WHERE IdempotencyKey=$key
            """;
        cmd.Parameters.AddWithValue("$key",key);
        await using var r=await cmd.ExecuteReaderAsync(ct);
        if(!await r.ReadAsync(ct))return null;
        return new(key,Guid.ParseExact(r.GetString(0),"N"),
            Guid.ParseExact(r.GetString(1),"N"),
            Guid.ParseExact(r.GetString(2),"N"),
            Guid.ParseExact(r.GetString(3),"N"),
            r.GetString(4),r.GetInt32(5));
    }

    /// <summary>
    /// Fake-only send. Does not claim multi-process exactly-once dispatch.
    /// Pending survives a process restart; a separate reviewer must handle
    /// CompensationRequired. A real adapter MUST NOT reuse this class.
    /// </summary>
    public async Task<SandboxWorkOrderRow> DispatchOnceAsync(
        PdmWorkOrderDraft draft,PdmP2TrustedActor actor,string token,
        CancellationToken ct=default)
    {
        Authenticate(draft,actor,token);
        var item=await ReadAsync(draft.CorrelationKey,ct)
            ?? throw new InvalidOperationException("Prepare must persist before dispatch");
        if(item.TenantId!=draft.TenantId || item.CustomerId!=draft.CustomerId ||
           item.ReviewId!=draft.SourceReviewId || item.DeviceId!=draft.DeviceId)
            throw new UnauthorizedAccessException("Outbox row not in trusted scope");
        if(item.State!="Pending")return item;
        ct.ThrowIfCancellationRequested();
        var succeeded=false;
        try {succeeded=await sender.SimulateAsync(item.Key,ct);}
        catch(OperationCanceledException) when(ct.IsCancellationRequested) {throw;}
        catch(Exception) {succeeded=false;}
        var attempts=item.Attempts+1;
        var next=succeeded?"AcceptedInSandbox":
            attempts>=3?"CompensationRequired":"Pending";
        await using(var cmd=connection.CreateCommand())
        {
            cmd.CommandText="""
                UPDATE PdmSandboxWorkOrderJournal SET State=$state, Attempts=$attempts
                WHERE IdempotencyKey=$key AND State='Pending' AND Attempts=$previous
                """;
            cmd.Parameters.AddWithValue("$state",next);
            cmd.Parameters.AddWithValue("$attempts",attempts);
            cmd.Parameters.AddWithValue("$key",item.Key);
            cmd.Parameters.AddWithValue("$previous",item.Attempts);
            if(await cmd.ExecuteNonQueryAsync(ct)!=1)
                throw new InvalidOperationException("Concurrent sandbox write requires re-evaluation");
        }
        return (await ReadAsync(item.Key,ct))!;
    }
}

public sealed class SandboxWorkOrderJournalTests
{
    private const string Token="isolated-sandbox-token-not-for-production";
    private sealed class Fake(int failures=0) : ISandboxWorkOrderSender
    {
        public int Calls;
        public Task<bool> SimulateAsync(string key,CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult(Calls>failures);
        }
    }
    private static (PdmWorkOrderDraft Draft,PdmP2TrustedActor Actor) Data()
    {
        var tenant=Guid.NewGuid();
        var customer=Guid.NewGuid();
        var actor=new PdmP2TrustedActor(tenant,customer,Guid.NewGuid(),true,false,true);
        var draft=new PdmWorkOrderDraft(tenant,customer,Guid.NewGuid(),Guid.NewGuid(),
            new string('a',64),"Only sandbox testing","Approved planning, not dispatch");
        return(draft,actor);
    }

    [Fact]
    public async Task PersistedPendingSurvivesCoordinatorRestartAndReusesReceipt()
    {
        // Shared isolated SQLite in-memory DB simulates a new process with the same durable DB.
        await using var connection=new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var fake=new Fake();
        var first=new SandboxWorkOrderJournal(connection,fake);
        await first.InitializeAsync();
        var(draft,actor)=Data();
        Assert.Equal("Pending",(await first.PrepareAsync(draft,actor,Token)).State);
        var afterRestart=new SandboxWorkOrderJournal(connection,fake);
        var pending=await afterRestart.ReadAsync(draft.CorrelationKey);
        Assert.Equal("Pending",pending!.State);
        var finished=await afterRestart.DispatchOnceAsync(draft,actor,Token);
        Assert.Equal("AcceptedInSandbox",finished.State);
        Assert.False(finished.ExternalOrderCreated);
        var duplicate=await afterRestart.DispatchOnceAsync(draft,actor,Token);
        Assert.Equal(1,fake.Calls);
        Assert.Equal(finished,duplicate);
    }

    [Fact]
    public async Task ThreeIsolatedFailuresRequireCompensationAndNeverExternalSuccess()
    {
        await using var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        var fake=new Fake(10);
        var journal=new SandboxWorkOrderJournal(c,fake);
        await journal.InitializeAsync();
        var(draft,actor)=Data();
        await journal.PrepareAsync(draft,actor,Token);
        var first=await journal.DispatchOnceAsync(draft,actor,Token);
        var second=await journal.DispatchOnceAsync(draft,actor,Token);
        var last=await journal.DispatchOnceAsync(draft,actor,Token);
        Assert.Equal("Pending",first.State);
        Assert.Equal("Pending",second.State);
        Assert.Equal("CompensationRequired",last.State);
        Assert.Equal(3,last.Attempts);
        Assert.False(last.ExternalOrderCreated);
        await journal.DispatchOnceAsync(draft,actor,Token);
        Assert.Equal(3,fake.Calls);
    }

    [Fact]
    public async Task SQLiteFileReopensAfterRestartAndRetainsUndeliveredDraft()
    {
        var filename=Path.Combine(Path.GetTempPath(),
            "pdm-isolated-outbox-"+Guid.NewGuid().ToString("N")+".db");
        var(draft,actor)=Data();
        var fake=new Fake();
        try
        {
            await using(var first=new SqliteConnection("Data Source="+filename+";Pooling=False"))
            {
                await first.OpenAsync();
                var journal=new SandboxWorkOrderJournal(first,fake);
                await journal.InitializeAsync();
                Assert.Equal("Pending",(await journal.PrepareAsync(draft,actor,Token)).State);
            }
            await using(var reopened=new SqliteConnection("Data Source="+filename+";Pooling=False"))
            {
                await reopened.OpenAsync();
                var journal=new SandboxWorkOrderJournal(reopened,fake);
                var recovered=await journal.ReadAsync(draft.CorrelationKey);
                Assert.NotNull(recovered);
                Assert.Equal("Pending",recovered!.State);
                var sent=await journal.DispatchOnceAsync(draft,actor,Token);
                Assert.Equal("AcceptedInSandbox",sent.State);
                Assert.False(sent.ExternalOrderCreated);
            }
            Assert.Equal(1,fake.Calls);
        }
        finally {if(File.Exists(filename))File.Delete(filename);}
    }
    [Fact]
    public async Task InvalidTokenCrossTenantAndKeyCollisionNeverDispatch()
    {
        await using var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        var fake=new Fake();
        var journal=new SandboxWorkOrderJournal(c,fake);
        await journal.InitializeAsync();
        var(draft,actor)=Data();
        await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
            journal.PrepareAsync(draft,actor,"bad-token"));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
            journal.PrepareAsync(draft,actor with {TenantId=Guid.NewGuid()},Token));
        await journal.PrepareAsync(draft,actor,Token);
        var other=draft with {SourceReviewId=Guid.NewGuid()};
        await Assert.ThrowsAsync<InvalidOperationException>(()=>
            journal.PrepareAsync(other,actor,Token));
        Assert.Equal(0,fake.Calls);
    }

    [Fact]
    public async Task NoPreparationOrCancellationMeansNoFakeExternalOrder()
    {
        await using var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        var fake=new Fake();
        var journal=new SandboxWorkOrderJournal(c,fake);
        await journal.InitializeAsync();
        var(draft,actor)=Data();
        await Assert.ThrowsAsync<InvalidOperationException>(()=>
            journal.DispatchOnceAsync(draft,actor,Token));
        using var cts=new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>
            journal.PrepareAsync(draft,actor,Token,cts.Token));
        Assert.Equal(0,fake.Calls);
    }
}

