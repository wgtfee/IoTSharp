using System.Security.Cryptography;
using System.Text;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;

// Generates human-reviewable initial DDL without ever connecting to a database.
// Invoke from IoTSharp-master root with: dotnet run --project tools/pdm-schema/PdmSchemaExport.csproj -- <output-dir>
if (args.Length != 1)
    throw new ArgumentException("Expected a single output directory; SQL is never executed.");
var directory = Path.GetFullPath(args[0]);
Directory.CreateDirectory(directory);
var fixtures = new[]
{
    ("sqlite", (Action<DbContextOptionsBuilder<PdmDbContext>>)(b =>
        b.UseSqlite("Data Source=:memory:"))),
    ("sqlserver", (Action<DbContextOptionsBuilder<PdmDbContext>>)(b =>
        b.UseSqlServer("Server=localhost;Database=pdm_schema_generation_only;Trusted_Connection=True"))),
    ("postgresql", (Action<DbContextOptionsBuilder<PdmDbContext>>)(b =>
        b.UseNpgsql("Host=localhost;Database=pdm_schema_generation_only;Username=script_only")))
};
var results = new List<object>();
foreach (var (provider, setup) in fixtures)
{
    var options = new DbContextOptionsBuilder<PdmDbContext>();
    setup(options);
    await using var db = new PdmDbContext(options.Options);
    // GenerateCreateScript inspects the EF model and does NOT open a DB connection.
    var ddl = db.Database.GenerateCreateScript();
    foreach (var name in new[] {
        "PdmDeviceProfile", "PdmPointPolicy", "PdmHealthSnapshot", "PdmRiskEvent" })
        if (!ddl.Contains(name, StringComparison.Ordinal))
            throw new InvalidOperationException($"Provider {provider} failed to generate table {name}.");
    if (ddl.Contains("DROP TABLE", StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Destructive SQL generation refused.");
    var header = "-- IoTSharp PdM P1-04 INITIAL SCHEMA DRAFT\n"
        + "-- Generated offline from PdmDbContext. NEVER automatically executed.\n"
        + "-- DBA review, permissions, backup and provider staging migration required.\n"
        + "-- Provider: " + provider + "\n\n";
    var content = header + ddl;
    var filename = "PdmInitialSchema_" + provider + ".sql";
    var fullPath = Path.Combine(directory, filename);
    await File.WriteAllTextAsync(fullPath, content, new UTF8Encoding(false));
    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
    results.Add(new { provider, file = filename, sha256 = hash, tables = 4 });
    Console.WriteLine($"{provider}: 4 tables; DDL preview {content.Length} chars");
}
var manifest = System.Text.Json.JsonSerializer.Serialize(results,
    new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
await File.WriteAllTextAsync(Path.Combine(directory, "PdmInitialSchema_checksums.json"),
    manifest + Environment.NewLine, new UTF8Encoding(false));
Console.WriteLine("No connection was opened and no schema was applied.");

