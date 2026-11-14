using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

/// <summary>
/// The real P2/P3 V001 DDL is rehearsed in a disposable, durable SQLite file
/// and checked after all connections close. No project or live database access.
/// </summary>
public sealed class Batch5DurableSchemaRecoveryTests
{
    private static string NewPath()=>Path.Combine(Path.GetTempPath(),
        "pdm-v001-restart-"+Guid.NewGuid().ToString("N")+".sqlite");

    private static async Task<SqliteConnection> Open(string path)
    {
        var connection=new SqliteConnection(new SqliteConnectionStringBuilder {
            DataSource=path,Pooling=false
        }.ToString());
        await connection.OpenAsync();
        await using var cmd=connection.CreateCommand();
        cmd.CommandText="PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000";
        await cmd.ExecuteNonQueryAsync();
        return connection;
    }

    [Fact]
    public async Task ReviewedP2P3SchemaPersistsAcrossPhysicalConnectionRestart()
    {
        var file=NewPath();
        Batch4SchemaFingerprint expected;
        try
        {
            await using(var db=await Open(file))
                expected=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(db);
            await using(var restarted=await Open(file))
            {
                Assert.True(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(
                    restarted,expected));
                Assert.Equal(expected,await Batch4IsolatedSchemaCatalog.CaptureAsync(restarted));
            }
        }
        finally {SqliteConnection.ClearAllPools();File.Delete(file);}
    }

    [Fact]
    public async Task CrashLikeIncompleteMigrationIsRolledBackOnNextOpen()
    {
        var file=NewPath();
        try
        {
            Batch4SchemaFingerprint before;
            await using(var db=await Open(file))
            {
                before=await Batch4IsolatedSchemaCatalog.CaptureAsync(db);
                using(var transaction=db.BeginTransaction())
                {
                    await using var ddl=db.CreateCommand();
                    ddl.Transaction=transaction;
                    ddl.CommandText=File.ReadAllText(SchemaAcceptance.MigrationPath(
                        "PdmP3_V001_InitialSchema_sqlite.sql"));
                    await ddl.ExecuteNonQueryAsync();
                    // Simulate an unsuccessful installer, not a successful deploy.
                    transaction.Rollback();
                }
            }
            await using(var recovered=await Open(file))
            {
                var after=await Batch4IsolatedSchemaCatalog.CaptureAsync(recovered);
                Assert.Equal(before,after);
                Assert.False(after.ObjectsCount>=8);
            }
        }
        finally {SqliteConnection.ClearAllPools();File.Delete(file);}
    }

    [Fact]
    public async Task DriftDetectedAfterRestartAndRepairCannotBeAssumed()
    {
        var file=NewPath();
        try
        {
            Batch4SchemaFingerprint expected;
            await using(var db=await Open(file))
            {
                expected=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(db);
                await using var cmd=db.CreateCommand();
                cmd.CommandText="DROP INDEX IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint";
                await cmd.ExecuteNonQueryAsync();
            }
            await using(var restarted=await Open(file))
            {
                Assert.False(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(
                    restarted,expected));
                // Schema audit must never attempt auto-migration or schema repair.
                Assert.NotEqual(expected,await Batch4IsolatedSchemaCatalog.CaptureAsync(restarted));
            }
        }
        finally {SqliteConnection.ClearAllPools();File.Delete(file);}
    }

    [Fact]
    public async Task ScopedUniqueFingerprintSurvivesRestart()
    {
        var file=NewPath();
        try
        {
            await using(var db=await Open(file))
                await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(db);
            await using(var recovered=await Open(file))
            {
                // Actual unique index remains present and unique after restart.
                await using var cmd=recovered.CreateCommand();
                cmd.CommandText="PRAGMA index_list('PdmP3Experiment')";
                await using var reader=await cmd.ExecuteReaderAsync();
                var found=false;
                while(await reader.ReadAsync())
                {
                    if(reader.GetString(1)=="IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint")
                        found=reader.GetInt64(2)==1;
                }
                Assert.True(found);
            }
        }
        finally {SqliteConnection.ClearAllPools();File.Delete(file);}
    }
}

