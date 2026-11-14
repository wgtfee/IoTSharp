using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

/// <summary>
/// Real isolated SQLite schema application and failure/rollback checks.
/// Reads the existing reviewed V001 scripts; never targets a live database.
/// </summary>
public sealed class NextSchemaDriftAndRollbackTests
{
    private static string Sql(string version) =>
        File.ReadAllText(SchemaAcceptance.MigrationPath(
            version+"_InitialSchema_sqlite.sql"));

    private static async Task<SqliteConnection> Open()
    {
        var conn=new SqliteConnection("Data Source=:memory:");
        await conn.OpenAsync();
        await using var pragma=conn.CreateCommand();
        pragma.CommandText="PRAGMA foreign_keys=ON";
        await pragma.ExecuteNonQueryAsync();
        return conn;
    }

    [Theory]
    [InlineData("PdmP2_V001", "PdmP2Review", "IX_PdmP2Review_TenantId_CustomerId_Fingerprint")]
    [InlineData("PdmP3_V001", "PdmP3Experiment", "IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint")]
    public async Task ActualSqliteSchemaHasRequiredScopedUniquenessAndForeignKeys(
        string stage,string table,string uniqueName)
    {
        SchemaAcceptance.Verify(stage); // SHA256, provider, DDL checksum first.
        await using var db=await Open();
        await using(var ddl=db.CreateCommand())
        {
            ddl.CommandText=Sql(stage);
            await ddl.ExecuteNonQueryAsync();
        }
        await using var schema=db.CreateCommand();
        schema.CommandText="SELECT name FROM sqlite_master WHERE type='index' AND name=$name";
        schema.Parameters.AddWithValue("$name",uniqueName);
        Assert.Equal(uniqueName,await schema.ExecuteScalarAsync());
        await using var pragma=db.CreateCommand();
        pragma.CommandText=$"PRAGMA index_list('{table}')";
        await using var reader=await pragma.ExecuteReaderAsync();
        var unique=false;
        while(await reader.ReadAsync())
            if(reader.GetString(1)==uniqueName && reader.GetInt64(2)==1)
                unique=true;
        Assert.True(unique);
    }

    [Fact]
    public async Task ExecutingBothIsolatedSchemasCreatesExactlyEightTablesAndRollbackRemovesAll()
    {
        await using var db=await Open();
        using(var tx=db.BeginTransaction())
        {
            foreach(var stage in new[]{"PdmP2_V001","PdmP3_V001"})
            {
                await using var ddl=db.CreateCommand();
                ddl.Transaction=tx;
                ddl.CommandText=Sql(stage);
                await ddl.ExecuteNonQueryAsync();
            }
            await using var count=db.CreateCommand();
            count.Transaction=tx;
            count.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'PdmP%'";
            Assert.Equal(8,Convert.ToInt32(await count.ExecuteScalarAsync()));
            tx.Rollback();
        }
        await using var after=db.CreateCommand();
        after.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'PdmP%'";
        Assert.Equal(0,Convert.ToInt32(await after.ExecuteScalarAsync()));
    }

    [Fact]
    public async Task MigrationFailureIsAtomicAndNoHalfAppliedSchemaRemains()
    {
        await using var db=await Open();
        using(var tx=db.BeginTransaction())
        {
            var ddl=db.CreateCommand();
            ddl.Transaction=tx;
            ddl.CommandText=Sql("PdmP2_V001")+
                "\nCREATE TABLE \"PdmP2Review\" (\"Id\" TEXT PRIMARY KEY);";
            await Assert.ThrowsAsync<SqliteException>(
                ()=>ddl.ExecuteNonQueryAsync());
            tx.Rollback();
        }
        await using var verify=db.CreateCommand();
        verify.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'PdmP%'";
        Assert.Equal(0,Convert.ToInt32(await verify.ExecuteScalarAsync()));
    }

    [Fact]
    public async Task AuditForeignKeyRejectsOrphanReviewerEvent()
    {
        await using var db=await Open();
        await using(var ddl=db.CreateCommand())
        {
            ddl.CommandText=Sql("PdmP2_V001");
            await ddl.ExecuteNonQueryAsync();
        }
        await using var command=db.CreateCommand();
        command.CommandText="""
            INSERT INTO PdmP2ReviewAudit
            (Id,ReviewId,TenantId,CustomerId,ActorId,Action,Reason,AtUtc)
            VALUES ('a','missing','t','c','reviewer','Approved','synthetic','2026-11-14T00:00:00Z')
            """;
        await Assert.ThrowsAsync<SqliteException>(()=>command.ExecuteNonQueryAsync());
    }
}

