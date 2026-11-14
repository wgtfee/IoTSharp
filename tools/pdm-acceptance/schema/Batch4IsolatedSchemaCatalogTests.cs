using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

public sealed record Batch4SchemaFingerprint(
    string Sha256,int ObjectsCount,bool CanApplyProductionMigration=false);

/// <summary>
/// Actual, deterministic SQLite catalog fingerprint. It is not a SQLServer/PG
/// migration approval and does not modify any existing project DB.
/// </summary>
public static class Batch4IsolatedSchemaCatalog
{
    public static async Task<Batch4SchemaFingerprint> CaptureAsync(
        SqliteConnection connection,CancellationToken ct=default)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var lines=new List<string>();
        await using var command=connection.CreateCommand();
        command.CommandText="""
            SELECT type,name,tbl_name,COALESCE(sql,'')
            FROM sqlite_master
            WHERE name LIKE 'PdmP2%' OR name LIKE 'PdmP3%'
               OR tbl_name LIKE 'PdmP2%' OR tbl_name LIKE 'PdmP3%'
            ORDER BY type,name
            """;
        await using(var reader=await command.ExecuteReaderAsync(ct))
            while(await reader.ReadAsync(ct))
                lines.Add(string.Join("\u001f",
                    reader.GetString(0),reader.GetString(1),
                    reader.GetString(2),reader.GetString(3)));
        return new(Convert.ToHexString(SHA256.HashData(
                Encoding.UTF8.GetBytes(string.Join("\n",lines)))).ToLowerInvariant(),
            lines.Count);
    }

    public static async Task<Batch4SchemaFingerprint> CreateReviewedBaselineAsync(
        SqliteConnection connection,CancellationToken ct=default)
    {
        await using(var enable=connection.CreateCommand())
        {
            enable.CommandText="PRAGMA foreign_keys=ON";
            await enable.ExecuteNonQueryAsync(ct);
        }
        foreach(var stage in new[]{"PdmP2_V001","PdmP3_V001"})
        {
            SchemaAcceptance.Verify(stage);
            await using var ddl=connection.CreateCommand();
            ddl.CommandText=File.ReadAllText(SchemaAcceptance.MigrationPath(
                stage+"_InitialSchema_sqlite.sql"));
            await ddl.ExecuteNonQueryAsync(ct);
        }
        return await CaptureAsync(connection,ct);
    }

    public static async Task<bool> HasApprovedShapeAsync(
        SqliteConnection connection,Batch4SchemaFingerprint expected,
        CancellationToken ct=default)
    {
        var actual=await CaptureAsync(connection,ct);
        if(expected.ObjectsCount<8 || actual.ObjectsCount!=expected.ObjectsCount ||
           actual.Sha256!=expected.Sha256)
            return false;
        await using var pragma=connection.CreateCommand();
        pragma.CommandText="PRAGMA foreign_keys";
        return Convert.ToInt32(await pragma.ExecuteScalarAsync(ct))==1;
    }
}

public sealed class Batch4IsolatedSchemaCatalogTests
{
    private static async Task<SqliteConnection> Open()
    {
        var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        return c;
    }

    [Fact]
    public async Task ReviewedP2P3ScriptProducesRepeatableCatalogFingerprints()
    {
        await using var one=await Open();
        await using var two=await Open();
        var first=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(one);
        var second=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(two);
        Assert.Equal(first,second);
        Assert.True(first.ObjectsCount>=8);
        Assert.False(first.CanApplyProductionMigration);
        Assert.True(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(one,first));
    }

    [Fact]
    public async Task MissingUniqueIndexProducesDriftEvenIfAllTablesExist()
    {
        await using var c=await Open();
        var initial=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(c);
        await using(var alter=c.CreateCommand())
        {
            alter.CommandText="DROP INDEX IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint";
            await alter.ExecuteNonQueryAsync();
        }
        Assert.False(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(c,initial));
    }

    [Fact]
    public async Task InjectedExtraPdmTableIsDetectedRatherThanSilentlyAccepted()
    {
        await using var c=await Open();
        var initial=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(c);
        await using(var add=c.CreateCommand())
        {
            add.CommandText="CREATE TABLE PdmP3UnreviewedSchema(Id TEXT PRIMARY KEY)";
            await add.ExecuteNonQueryAsync();
        }
        Assert.False(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(c,initial));
    }

    [Fact]
    public async Task DisabledForeignKeyEnforcementCannotPass()
    {
        await using var c=await Open();
        var initial=await Batch4IsolatedSchemaCatalog.CreateReviewedBaselineAsync(c);
        await using(var disable=c.CreateCommand())
        {
            disable.CommandText="PRAGMA foreign_keys=OFF";
            await disable.ExecuteNonQueryAsync();
        }
        Assert.False(await Batch4IsolatedSchemaCatalog.HasApprovedShapeAsync(c,initial));
    }

    [Fact]
    public async Task FailedMigrationTransactionLeavesIdenticalPreTransactionFingerprint()
    {
        await using var c=await Open();
        var empty=await Batch4IsolatedSchemaCatalog.CaptureAsync(c);
        await using(var transaction=await c.BeginTransactionAsync())
        {
            await using(var ddl=c.CreateCommand())
            {
                ddl.Transaction=(SqliteTransaction)transaction;
                ddl.CommandText=File.ReadAllText(SchemaAcceptance.MigrationPath(
                    "PdmP2_V001_InitialSchema_sqlite.sql"));
                await ddl.ExecuteNonQueryAsync();
            }
            await transaction.RollbackAsync();
        }
        Assert.Equal(empty,await Batch4IsolatedSchemaCatalog.CaptureAsync(c));
    }
}

