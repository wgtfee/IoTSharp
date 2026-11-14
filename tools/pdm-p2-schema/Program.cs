using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;

// Generates DBA-reviewable V001 SQL only. NEVER connects to any SQL server.
// Usage: dotnet run --project tools/pdm-p2-schema/PdmP2SchemaExport.csproj -- <output-dir>
if (args.Length != 1)
    throw new ArgumentException("Expected one OUTPUT DIRECTORY; no database connections are permitted.");
var target = Path.GetFullPath(args[0]);
Directory.CreateDirectory(target);
var providers = new[]
{
    ("sqlite", (Action<DbContextOptionsBuilder>)(b =>
        b.UseSqlite("Data Source=:memory:"))),
    ("sqlserver", (Action<DbContextOptionsBuilder>)(b =>
        b.UseSqlServer("Server=localhost;Database=offline_ddl_only;Trusted_Connection=True"))),
    ("postgresql", (Action<DbContextOptionsBuilder>)(b =>
        b.UseNpgsql("Host=localhost;Database=offline_ddl_only;Username=script_only")))
};
var manifest = new List<object>();
foreach (var (provider, options) in providers)
{
    var reviewOptions = new DbContextOptionsBuilder<PdmP2ReviewDbContext>();
    options(reviewOptions);
    await using var review = new PdmP2ReviewDbContext(reviewOptions.Options);
    var policyOptions = new DbContextOptionsBuilder<PdmP2PolicyDbContext>();
    options(policyOptions);
    await using var policy = new PdmP2PolicyDbContext(policyOptions.Options);
    var reviewDDL = review.Database.GenerateCreateScript();
    var policyDDL = policy.Database.GenerateCreateScript();
    var ddl = reviewDDL + Environment.NewLine + policyDDL;
    foreach (var table in new[]
    {
        "PdmP2Review", "PdmP2ReviewAudit",
        "PdmP2PolicyRevision", "PdmP2PolicyAudit"
    })
        if (!ddl.Contains(table, StringComparison.Ordinal))
            throw new InvalidOperationException($"Provider {provider} missing table {table}");
    if (ddl.Contains("DROP TABLE", StringComparison.OrdinalIgnoreCase) ||
        ddl.Contains("ALTER DATABASE", StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("DDL exporter refuses destructive or database-scoped SQL");
    var header = """
-- IoTSharp PdM P2 V001 INITIAL SCHEMA / DBA REVIEW DRAFT
-- Generated offline from isolated PdmP2ReviewDbContext and PdmP2PolicyDbContext.
-- No connection was opened and this SQL was NOT executed.
-- Manual, controlled staging migration only, with backup and rollback approval.
-- Never apply to IoTSharp SysDb/ApplicationDbContext or the production telemetry hot path.

""";
    var content = header + "-- Provider: " + provider + Environment.NewLine + ddl;
    var file = $"PdmP2_V001_InitialSchema_{provider}.sql";
    await File.WriteAllTextAsync(Path.Combine(target, file), content, new UTF8Encoding(false));
    var checksum = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
    manifest.Add(new
    {
        schemaVersion = "P2-V001", provider, file,
        sha256 = checksum, tables = 4, applied = false,
        kind = "offline-generated-initial-schema-review"
    });
    Console.WriteLine($"Generated {provider}: four isolated P2 tables, {content.Length} characters");
}
await File.WriteAllTextAsync(
    Path.Combine(target, "PdmP2_V001_checksums.json"),
    JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }) +
    Environment.NewLine, new UTF8Encoding(false));
Console.WriteLine("Offline only. No SQL connection or DDL execution took place.");

