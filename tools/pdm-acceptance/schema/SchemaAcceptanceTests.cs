using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

public static class SchemaAcceptance
{
    public static string LocateRoot()
    {
        foreach(var start in new[]{Directory.GetCurrentDirectory(),AppContext.BaseDirectory})
        {
            var path=new DirectoryInfo(start);
            for(var depth=0;depth<12 && path!=null;path=path.Parent,depth++)
                if(File.Exists(Path.Combine(path.FullName,"IoTSharp.sln")) ||
                   Directory.Exists(Path.Combine(path.FullName,"design-plans","predictive-maintenance","migrations")))
                    return path.FullName;
        }
        throw new DirectoryNotFoundException("Repository root not found; refusing to infer schema paths");
    }

    public static string MigrationPath(string file) =>
        Path.Combine(LocateRoot(),"design-plans","predictive-maintenance","migrations",file);

    public static IReadOnlyList<(string Provider,string File,string Sha)> Verify(string stage)
    {
        if(stage is not ("PdmP2_V001" or "PdmP3_V001"))
            throw new ArgumentException("Only isolated P2/P3 schema allowed");
        using var doc=JsonDocument.Parse(File.ReadAllText(MigrationPath(stage+"_checksums.json")));
        var entries=new List<(string Provider,string File,string Sha)>();
        foreach(var item in doc.RootElement.EnumerateArray())
        {
            var provider=item.GetProperty("provider").GetString()!;
            var file=item.GetProperty("file").GetString()!;
            var expected=item.GetProperty("sha256").GetString()!;
            if(provider is not ("sqlite" or "sqlserver" or "postgresql") ||
               file!=stage+"_InitialSchema_"+provider+".sql" ||
               expected.Length!=64 || item.GetProperty("applied").GetBoolean())
                throw new InvalidOperationException("Unsafe or previously applied schema manifest");
            var bytes=File.ReadAllBytes(MigrationPath(file));
            var actual=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if(actual!=expected) throw new InvalidOperationException("Schema hash mismatch");
            var sql=System.Text.Encoding.UTF8.GetString(bytes);
            var prefix=stage=="PdmP2_V001"?"PdmP2":"PdmP3";
            foreach(var table in (prefix=="PdmP2"?
                new[]{"PdmP2Review","PdmP2ReviewAudit","PdmP2PolicyRevision","PdmP2PolicyAudit"}:
                new[]{"PdmP3FaultCase","PdmP3FaultCaseAudit","PdmP3Experiment","PdmP3ExperimentAudit"}))
                if(!sql.Contains(table,StringComparison.Ordinal))
                    throw new InvalidOperationException("Required isolated table missing");
            if(System.Text.RegularExpressions.Regex.IsMatch(sql,
                @"\b(DROP\s+TABLE|ALTER\s+DATABASE|TRUNCATE\s+TABLE)\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new InvalidOperationException("Destructive schema statement prohibited");
            entries.Add((provider,file,actual));
        }
        if(entries.Count!=3 || entries.Select(x=>x.Provider).Distinct().Count()!=3)
            throw new InvalidOperationException("Three distinct provider variants required");
        return entries;
    }
}

public sealed class SchemaAcceptanceTests
{
    [Theory]
    [InlineData("PdmP2_V001")]
    [InlineData("PdmP3_V001")]
    public void OfflineThreeProviderManifestHasValidSHAAndNoDestructiveDDL(string stage)
    {
        var found=SchemaAcceptance.Verify(stage);
        Assert.Equal(3,found.Count);
        Assert.Equal(3,found.Select(x=>x.Provider).Distinct().Count());
    }

    [Theory]
    [InlineData("PdmP2_V001")]
    [InlineData("PdmP3_V001")]
    public async Task SQLiteInitialMigrationRollsBackWithoutTouchingProduction(string stage)
    {
        var entries=SchemaAcceptance.Verify(stage);
        var file=entries.Single(x=>x.Provider=="sqlite").File;
        var sql=await File.ReadAllTextAsync(SchemaAcceptance.MigrationPath(file));
        await using var connection=new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using(var tx=await connection.BeginTransactionAsync())
        {
            await using(var cmd=connection.CreateCommand())
            {
                cmd.Transaction=(SqliteTransaction)tx;
                cmd.CommandText=sql;
                await cmd.ExecuteNonQueryAsync();
            }
            await using(var read=connection.CreateCommand())
            {
                read.Transaction=(SqliteTransaction)tx;
                read.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'PdmP%'";
                var count=Convert.ToInt32(await read.ExecuteScalarAsync());
                Assert.Equal(4,count);
            }
            await tx.RollbackAsync(); // Real SQLite DDL rollback test.
        }
        await using(var after=connection.CreateCommand())
        {
            after.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'PdmP%'";
            Assert.Equal(0,Convert.ToInt32(await after.ExecuteScalarAsync()));
        }
    }

    [Fact]
    public void ValidatorRejectsUnknownMigrationTarget()
    {
        Assert.Throws<ArgumentException>(()=>SchemaAcceptance.Verify("ApplicationDbContext"));
    }
}

