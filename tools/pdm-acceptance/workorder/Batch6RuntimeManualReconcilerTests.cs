using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.WorkOrder;

/// <summary>实际运行时工单双人复核实现的磁盘 SQLite 集成，完全不发出外部指令。</summary>
public sealed class Batch6RuntimeManualReconcilerTests
{
    private static readonly string Key = new('e',64);
    private static readonly string Sha = new('a',64);
    private static readonly DateTimeOffset BaseUtc =
        new(2026,11,14,0,0,0,TimeSpan.Zero);
    private static PdmP2TrustedActor Actor(Guid tenant,Guid customer) =>
        new(tenant,customer,Guid.NewGuid(),true,false,true);

    [Fact]
    public async Task RuntimeReconcilerEnforcesTwoPersonReviewAfterPhysicalRestart()
    {
        var path=Path.Combine(Path.GetTempPath(),
            "pdm-batch6-workorder-"+Guid.NewGuid().ToString("N")+".sqlite");
        try
        {
            var tenant=Guid.NewGuid();var customer=Guid.NewGuid();var review=Guid.NewGuid();
            var first=Actor(tenant,customer);
            await using(var db=new SqliteConnection("Data Source="+path+";Pooling=False"))
            {
                await db.OpenAsync();
                var outbox=new NextSandboxLeaseJournal(db);
                await outbox.InitializeAsync();
                var journal=new Batch3ManualReconciliationJournal(db,outbox);
                await journal.InitializeAsync();
                await outbox.PrepareAsync(Key,tenant,customer,review,first);
                Assert.True(await outbox.ClaimAsync(Key,tenant,customer,review,first,
                    "isolated-worker",BaseUtc,TimeSpan.FromSeconds(5)));
                Assert.True(await outbox.ExpireToReconciliationAsync(Key,BaseUtc.AddMinutes(2)));
                await journal.BeginAsync(Key,tenant,customer,first,Sha,BaseUtc.AddMinutes(3));
            }
            await using(var restarted=new SqliteConnection("Data Source="+path+";Pooling=False"))
            {
                await restarted.OpenAsync();
                var guarded=new PdmWorkOrderManualReconciler(restarted);
                Assert.False(await guarded.ConfirmAsync(Key,tenant,customer,first,
                    Sha,true,BaseUtc.AddMinutes(4)));
                Assert.False(await guarded.ConfirmAsync(Key,tenant,customer,
                    Actor(tenant,customer),new string('b',64),true,BaseUtc.AddMinutes(4)));
                Assert.True(await guarded.ConfirmAsync(Key,tenant,customer,
                    Actor(tenant,customer),Sha,false,BaseUtc.AddMinutes(4)));
                Assert.False(await guarded.ConfirmAsync(Key,tenant,customer,
                    Actor(tenant,customer),Sha,false,BaseUtc.AddMinutes(5)));
                var source=new NextSandboxLeaseJournal(restarted);
                Assert.Equal("ReconciliationRequired",(await source.ReadAsync(Key)).Status);
            }
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(path); }
    }
}
