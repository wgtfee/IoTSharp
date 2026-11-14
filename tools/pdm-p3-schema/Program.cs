using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.EntityFrameworkCore;

// Offline-only P3 schema exporter. Does not connect to any database.
if (args.Length != 1)
    throw new ArgumentException("Pass the output folder for offline review SQL.");
var target = Path.GetFullPath(args[0]);
Directory.CreateDirectory(target);
var providers = new[]
{
    ("sqlite", (Action<DbContextOptionsBuilder>)(o =>
        o.UseSqlite("Data Source=:memory:"))),
    ("sqlserver", (Action<DbContextOptionsBuilder>)(o =>
        o.UseSqlServer("Server=localhost;Database=never_connect;Trusted_Connection=True"))),
    ("postgresql", (Action<DbContextOptionsBuilder>)(o =>
        o.UseNpgsql("Host=localhost;Database=never_connect;Username=offline_only")))
};
var checksums = new List<object>();
foreach(var (provider, configure) in providers)
{
    var labelsOptions = new DbContextOptionsBuilder<PdmP3FaultCaseDbContext>();
    configure(labelsOptions);
    await using var labels = new PdmP3FaultCaseDbContext(labelsOptions.Options);
    var experimentOptions = new DbContextOptionsBuilder<PdmP3ExperimentDbContext>();
    configure(experimentOptions);
    await using var experiments = new PdmP3ExperimentDbContext(experimentOptions.Options);
    var ddl = labels.Database.GenerateCreateScript() +
        Environment.NewLine + experiments.Database.GenerateCreateScript();
    foreach(var name in new[]{
        "PdmP3FaultCase","PdmP3FaultCaseAudit",
        "PdmP3Experiment","PdmP3ExperimentAudit"
    })
        if(!ddl.Contains(name, StringComparison.Ordinal))
            throw new InvalidOperationException($"Missing {name} in {provider} SQL");
    if(ddl.Contains("DROP TABLE",StringComparison.OrdinalIgnoreCase) ||
       ddl.Contains("ALTER DATABASE",StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Potentially destructive DDL rejected");
    var content = """
-- P3 V001 initial four-table schema generated from independent EF models.
-- DBA review only. Do NOT run against production, IoTSharp SysDb or telemetry tables.
-- No live database connection was opened. Not a versioned EF migrations chain.
-- Backup/rollback, permissions, UTC, concurrency, indexes require staging review.

""" + "-- Provider: " + provider + Environment.NewLine + ddl;
    var file = $"PdmP3_V001_InitialSchema_{provider}.sql";
    await File.WriteAllTextAsync(Path.Combine(target,file),content,new UTF8Encoding(false));
    var hash = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
    checksums.Add(new {
        schemaVersion="P3-V001",provider,file,sha256=hash,
        tables=4,applied=false,kind="offline-initial-schema-dba-review"
    });
    Console.WriteLine($"{provider}: generated 4 P3 tables, {content.Length} chars");
}
await File.WriteAllTextAsync(
    Path.Combine(target,"PdmP3_V001_checksums.json"),
    JsonSerializer.Serialize(checksums,new JsonSerializerOptions {
        WriteIndented=true
    })+Environment.NewLine,new UTF8Encoding(false));
Console.WriteLine("Offline only: no SQL commands were executed.");

