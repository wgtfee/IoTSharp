using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

// 仅用于一次性临时 SQLite 文件的 P2/P3 V001 真实事务迁移演练。
// 禁止 SQL Server/PostgreSQL/业务库连接；从不自动迁移或覆盖已存在文件。
if (args.Length != 2 || args[0] != "--rehearse")
{
    Console.Error.WriteLine("Usage: --rehearse <new temporary pdm-batch6-*.sqlite file>");
    return 2;
}
var destination = Path.GetFullPath(args[1]);
var temporaryRoot = Path.GetFullPath(Path.GetTempPath());
var relative = Path.GetRelativePath(temporaryRoot, destination);
if (Path.IsPathRooted(relative) || relative == ".." ||
    relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
    !Path.GetFileName(destination).StartsWith("pdm-batch6-", StringComparison.Ordinal) ||
    !Path.GetFileName(destination).EndsWith(".sqlite", StringComparison.Ordinal) ||
    !Directory.Exists(Path.GetDirectoryName(destination)))
{
    Console.Error.WriteLine("Only an existing temporary directory and new pdm-batch6-*.sqlite file are allowed.");
    return 3;
}
var folder = Path.Combine(Directory.GetCurrentDirectory(),
    "design-plans", "predictive-maintenance", "migrations");
var scripts = new List<string>();
foreach (var stage in new[] { "PdmP2_V001", "PdmP3_V001" })
{
    var manifest = Path.Combine(folder, stage + "_checksums.json");
    using var json = JsonDocument.Parse(await File.ReadAllTextAsync(manifest));
    var approved = json.RootElement.EnumerateArray().Single(x =>
        x.GetProperty("provider").GetString() == "sqlite" &&
        x.GetProperty("applied").GetBoolean() == false);
    var name = approved.GetProperty("file").GetString()!;
    if (name != stage + "_InitialSchema_sqlite.sql")
        throw new InvalidDataException("Unexpected reviewed schema artifact");
    var script = await File.ReadAllTextAsync(Path.Combine(folder, name));
    var digest = Convert.ToHexString(SHA256.HashData(
        await File.ReadAllBytesAsync(Path.Combine(folder, name)))).ToLowerInvariant();
    if (digest != approved.GetProperty("sha256").GetString())
        throw new InvalidDataException("Reviewed P2/P3 schema SHA-256 mismatch");
    scripts.Add(script);
}
// CreateNew prevents accidental replacement of an existing development or production database.
using (var exclusive = new FileStream(destination, FileMode.CreateNew, FileAccess.Write,
           FileShare.None)) { }
try
{
    var builder = new SqliteConnectionStringBuilder {
        DataSource = destination, Mode = SqliteOpenMode.ReadWrite, Pooling = false
    };
    await using (var db = new SqliteConnection(builder.ToString()))
    {
        await db.OpenAsync();
        await using (var fk = db.CreateCommand())
        {
            fk.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000";
            await fk.ExecuteNonQueryAsync();
        }
        await using (var tx = await db.BeginTransactionAsync())
        {
            foreach (var script in scripts)
            {
                await using var command = db.CreateCommand();
                command.Transaction = (SqliteTransaction)tx;
                command.CommandText = script;
                await command.ExecuteNonQueryAsync();
            }
            await tx.CommitAsync();
        }
        await using var catalog = db.CreateCommand();
        catalog.CommandText = """
            SELECT COUNT(*) FROM sqlite_master
            WHERE type='table' AND (name LIKE 'PdmP2%' OR name LIKE 'PdmP3%')
            """;
        var tables = Convert.ToInt32(await catalog.ExecuteScalarAsync());
        if (tables != 8) throw new InvalidDataException("P2/P3 catalog is incomplete");
        await using var check = db.CreateCommand();
        check.CommandText = "PRAGMA integrity_check";
        if ((string?)await check.ExecuteScalarAsync() != "ok")
            throw new InvalidDataException("SQLite integrity check failed");
        Console.WriteLine(JsonSerializer.Serialize(new {
            result = "PASS", provider = "isolated-disposable-sqlite",
            appliedSchemas = new[] { "P2-V001", "P3-V001" },
            physicalTables = tables, connectionRestartRequired = true,
            productionMigrationApproved = false, sqlServerTouched = false,
            externalCommandsSent = false
        }));
    }
    return 0;
}
catch
{
    Console.Error.WriteLine("Isolated P2/P3 rehearsal failed; existing databases were not touched.");
    return 1;
}
