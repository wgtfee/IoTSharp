using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

/// <summary>真实临时 SQLite 文件上的独立 P2/P3 并发唯一索引及事务回滚。</summary>
public sealed class Batch6DurableConcurrentMigrationTests
{
    private static string Temp() => Path.Combine(Path.GetTempPath(),
        "pdm-batch6-concurrency-" + Guid.NewGuid().ToString("N") + ".sqlite");

    private static async Task<SqliteConnection> Open(string path)
    {
        var db = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        await db.OpenAsync();
        await using var pragma = db.CreateCommand();
        pragma.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000";
        await pragma.ExecuteNonQueryAsync();
        return db;
    }

    private static async Task<bool> Insert(
        SqliteConnection db, Guid tenant, Guid customer, string fingerprint,
        SqliteTransaction? tx = null)
    {
        await using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO PdmP2Review
            (Id,TenantId,CustomerId,DeviceId,ProfileId,ProfileVersion,RiskEventId,
             Fingerprint,Title,State,Revision,CreatedAtUtc,UpdatedAtUtc)
            VALUES ($id,$tenant,$customer,$device,$profile,1,$risk,
                    $fingerprint,'offline','Draft',1,'2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')
            """;
        cmd.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        cmd.Parameters.AddWithValue("$tenant", tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer", customer.ToString("N"));
        cmd.Parameters.AddWithValue("$device", Guid.NewGuid().ToString("N"));
        cmd.Parameters.AddWithValue("$profile", Guid.NewGuid().ToString("N"));
        cmd.Parameters.AddWithValue("$risk", Guid.NewGuid().ToString("N"));
        cmd.Parameters.AddWithValue("$fingerprint", fingerprint);
        try { return await cmd.ExecuteNonQueryAsync() == 1; }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19) { return false; }
    }

    private static async Task<long> Count(SqliteConnection db)
    {
        await using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM PdmP2Review";
        return (long)(await command.ExecuteScalarAsync())!;
    }

    [Fact]
    public async Task ConcurrentSeparateConnectionsAllowOneScopedFingerprintButOtherTenant()
    {
        var path = Temp();
        try
        {
            await using (var init = await Open(path))
                await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(init);
            var tenant = Guid.NewGuid(); var customer = Guid.NewGuid();
            async Task<bool> Attempt()
            {
                await using var db = await Open(path);
                return await Insert(db, tenant, customer, new string('a',64));
            }
            var outcomes = await Task.WhenAll(Attempt(), Attempt());
            Assert.Single(outcomes, x => x);
            await using (var db = await Open(path))
            {
                Assert.Equal(1, await Count(db));
                Assert.True(await Insert(db, Guid.NewGuid(), customer, new string('a',64)));
                Assert.Equal(2, await Count(db));
                var baseline = await Batch4IsolatedSchemaCatalog.CaptureAsync(db);
                Assert.True(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(db, baseline));
            }
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(path); }
    }

    [Fact]
    public async Task DataChangesRolledBackOnPhysicalConnectionRestart()
    {
        var path = Temp();
        try
        {
            await using (var init = await Open(path))
                await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(init);
            await using (var db = await Open(path))
            {
                using var tx = db.BeginTransaction();
                Assert.True(await Insert(db, Guid.NewGuid(), Guid.NewGuid(),
                    new string('f',64), tx));
                tx.Rollback();
            }
            await using (var reopened = await Open(path))
                Assert.Equal(0, await Count(reopened));
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(path); }
    }
}
