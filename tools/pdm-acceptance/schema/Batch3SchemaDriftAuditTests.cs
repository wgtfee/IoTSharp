using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Schema;

public sealed record Batch3SchemaDriftResult(
    bool MatchesReviewedV001, IReadOnlyList<string> Differences,
    bool SQLServerProductionMigrated=false);

/// <summary>
/// Reconciles real SQLite metadata against the approved P2/P3 V001 structure.
/// This detects drift before experimentation; no runtime database migration.
/// </summary>
public static class Batch3SchemaDriftAudit
{
    private static readonly IReadOnlyDictionary<string,string[]> Required = new Dictionary<string,string[]>
    {
        ["PdmP2Review"] = ["TenantId","CustomerId","Fingerprint","State","Revision"],
        ["PdmP2ReviewAudit"] = ["TenantId","CustomerId","ReviewId","AtUtc"],
        ["PdmP2PolicyRevision"] = ["TenantId","CustomerId","PolicyVersion","Status","Revision"],
        ["PdmP2PolicyAudit"] = ["TenantId","CustomerId","PolicyId","AtUtc"],
        ["PdmP3FaultCase"] = ["TenantId","CustomerId","DeviceId","CaseReference","EventTimeUtc"],
        ["PdmP3FaultCaseAudit"] = ["TenantId","CustomerId","CaseId","AtUtc"],
        ["PdmP3Experiment"] = ["TenantId","CustomerId","Fingerprint","DatasetSha256","Revision"],
        ["PdmP3ExperimentAudit"] = ["TenantId","CustomerId","ExperimentId","AtUtc"]
    };

    public static async Task<Batch3SchemaDriftResult> InspectAsync(
        SqliteConnection connection,string stage,CancellationToken ct=default)
    {
        if(stage is not ("PdmP2_V001" or "PdmP3_V001"))
            throw new ArgumentException("Only reviewed P2/P3 V001 isolation is accepted.");
        var issues=new List<string>();
        await using(var fk=connection.CreateCommand())
        {
            fk.CommandText="PRAGMA foreign_keys";
            if(Convert.ToInt32(await fk.ExecuteScalarAsync(ct))!=1)
                issues.Add("SQLite FK enforcement is not active");
        }
        var prefix=stage=="PdmP2_V001"?"PdmP2":"PdmP3";
        foreach(var (table,names) in Required.Where(x=>x.Key.StartsWith(prefix,StringComparison.Ordinal)))
        {
            var discovered=new HashSet<string>(StringComparer.Ordinal);
            // Names are from fixed internal allow-list, never untrusted input.
            await using var column=connection.CreateCommand();
            column.CommandText="PRAGMA table_info('"+table+"')";
            await using(var reader=await column.ExecuteReaderAsync(ct))
                while(await reader.ReadAsync(ct))
                    discovered.Add(reader.GetString(1));
            if(discovered.Count==0)issues.Add("required table not present: "+table);
            foreach(var name in names)
                if(!discovered.Contains(name))
                    issues.Add(table+" missing column "+name);
        }
        var index=prefix=="PdmP2"
            ?"IX_PdmP2Review_TenantId_CustomerId_Fingerprint"
            :"IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint";
        await using(var check=connection.CreateCommand())
        {
            check.CommandText="SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=$name";
            check.Parameters.AddWithValue("$name",index);
            if(Convert.ToInt32(await check.ExecuteScalarAsync(ct))!=1)
                issues.Add("approved scoped unique index missing: "+index);
        }
        return new(issues.Count==0,issues);
    }
}

public sealed class Batch3SchemaDriftAuditTests
{
    private static async Task<SqliteConnection> Create(string version,bool enableFk=true)
    {
        var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        await using(var pragma=c.CreateCommand())
        {
            pragma.CommandText="PRAGMA foreign_keys="+(enableFk?"ON":"OFF");
            await pragma.ExecuteNonQueryAsync();
        }
        await using var init=c.CreateCommand();
        init.CommandText=File.ReadAllText(SchemaAcceptance.MigrationPath(
            version+"_InitialSchema_sqlite.sql"));
        await init.ExecuteNonQueryAsync();
        return c;
    }

    [Theory]
    [InlineData("PdmP2_V001")]
    [InlineData("PdmP3_V001")]
    public async Task ExactIsolatedV001SchemaPassesButNotAsProduction(string stage)
    {
        await using var c=await Create(stage);
        var report=await Batch3SchemaDriftAudit.InspectAsync(c,stage);
        Assert.True(report.MatchesReviewedV001,string.Join(";",report.Differences));
        Assert.False(report.SQLServerProductionMigrated);
    }

    [Fact]
    public async Task RenamedRequiredFieldIsDetected()
    {
        await using var c=await Create("PdmP2_V001");
        await using(var change=c.CreateCommand())
        {
            change.CommandText="ALTER TABLE PdmP2Review RENAME COLUMN Fingerprint TO WrongFingerprint";
            await change.ExecuteNonQueryAsync();
        }
        var result=await Batch3SchemaDriftAudit.InspectAsync(c,"PdmP2_V001");
        Assert.False(result.MatchesReviewedV001);
        Assert.Contains(result.Differences,x=>x.Contains("Fingerprint"));
    }

    [Fact]
    public async Task MissingUniqueIndexAndDisabledFkBlocksSignoff()
    {
        await using var c=await Create("PdmP3_V001",enableFk:false);
        await using(var drop=c.CreateCommand())
        {
            drop.CommandText="DROP INDEX IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint";
            await drop.ExecuteNonQueryAsync();
        }
        var result=await Batch3SchemaDriftAudit.InspectAsync(c,"PdmP3_V001");
        Assert.False(result.MatchesReviewedV001);
        Assert.Contains(result.Differences,x=>x.Contains("index"));
        Assert.Contains(result.Differences,x=>x.Contains("FK"));
    }

    [Fact]
    public async Task MissingSchemaAndUnknownMigrationMustFailClosed()
    {
        await using var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        var missing=await Batch3SchemaDriftAudit.InspectAsync(c,"PdmP2_V001");
        Assert.False(missing.MatchesReviewedV001);
        await Assert.ThrowsAsync<ArgumentException>(
            ()=>Batch3SchemaDriftAudit.InspectAsync(c,"ApplicationDbContext"));
    }
}

