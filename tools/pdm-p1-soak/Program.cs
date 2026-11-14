using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using IoTSharp.Data;
using IoTSharp.Data.Configurations;
using IoTSharp.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

// Isolated P1-07 provider contract smoke. No IoTSharp host, production database or devices.
// Usage: dotnet run --project tools/pdm-p1-soak -- 12 design-plans/predictive-maintenance/P1_07_short_smoke.json
if (args.Length != 2 || !int.TryParse(args[0], out var seconds) || seconds is < 2 or > 120)
    throw new ArgumentException("Expected: <seconds:2..120> <report-path>; longer runs require a separately approved staging environment.");
var reportPath = Path.GetFullPath(args[1]);
var conn = new SqliteConnection("Data Source=:memory:");
await conn.OpenAsync();
var opt = new DbContextOptionsBuilder<SoakContext>().UseSqlite(conn).Options;
await using var db = new SoakContext(opt);
await db.Database.EnsureCreatedAsync();

const int rowCount = 750;
var id = Guid.NewGuid();
var unrelatedId = Guid.NewGuid();
var begin = new DateTime(2026, 11, 12, 8, 0, 0, DateTimeKind.Utc);
var end = begin.AddMinutes(15);
var rows = new List<TelemetryData>(rowCount + 5);
for (var i = 0; i < rowCount; i++)
{
    rows.Add(new TelemetryData
    {
        DeviceId = id, KeyName = "temperature", DateTime = begin.AddSeconds(i),
        Type = IoTSharp.Contracts.DataType.Double, Value_Double = 50.0 + (i % 20)
    });
}
for (var i = 0; i < 5; i++)
    rows.Add(new TelemetryData { DeviceId = unrelatedId, KeyName = "temperature",
        DateTime = begin.AddSeconds(i), Type = IoTSharp.Contracts.DataType.Double, Value_Double = 100 });
db.Rows.AddRange(rows);
await db.SaveChangesAsync();
db.ChangeTracker.Clear();

using var process = Process.GetCurrentProcess();
var before = GC.GetTotalMemory(true);
var cpuBefore = process.TotalProcessorTime;
var stopwatch = Stopwatch.StartNew();
var iterations = 0;
var complete = 0;
var rejected = 0;
var failures = 0;
var maxManagedBytes = before;
var ct = new CancellationTokenSource(TimeSpan.FromSeconds(seconds + 4));
var keys = new[] { "temperature" };
while (stopwatch.Elapsed < TimeSpan.FromSeconds(seconds))
{
    // Alternates legitimate complete windows and over-budget rows;
    // always restricts the database itself to maxRows+1.
    var limit = iterations % 2 == 0 ? 800 : 400;
    var result = await BoundedTelemetryHistoryQuery.Build(
        db.Rows.AsNoTracking(), id, keys, begin, end, limit).ToListAsync(ct.Token);
    if (result.Count > limit)
    {
        rejected++;
        if (result.Count != limit + 1) failures++;
    }
    else
    {
        complete++;
        if (result.Count != rowCount || result.Any(r => r.DeviceId != id || r.DateTime >= end))
            failures++;
    }
    iterations++;
    if (iterations % 20 == 0)
        maxManagedBytes = Math.Max(maxManagedBytes, GC.GetTotalMemory(false));
    await Task.Delay(1, ct.Token);
}
stopwatch.Stop();
maxManagedBytes = Math.Max(maxManagedBytes, GC.GetTotalMemory(false));
var record = new
{
    kind = "isolated_sqlite_contract_smoke_not_production_or_1h_4h_soak",
    startedUtc = DateTime.UtcNow.Subtract(stopwatch.Elapsed).ToString("O"),
    elapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 2),
    telemetryRowsSeeded = rows.Count,
    iterations,
    complete,
    overBudgetRejected = rejected,
    failures,
    cpuMilliseconds = Math.Round((process.TotalProcessorTime - cpuBefore).TotalMilliseconds, 2),
    managedBytesBefore = before,
    managedBytesMax = maxManagedBytes,
    managedBytesAfter = GC.GetTotalMemory(false),
    database = "SQLite :memory:",
    queriedProvider = "EF Core relational Take(maxRows+1)",
    note = "Read-only isolated synthetic contract smoke; cannot represent ShardingCore routing, Influx execution, 1h/4h long stability or ingestion throughput."
};
Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);
await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(record,
    new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(record));
if (failures != 0 || complete == 0 || rejected == 0)
    Environment.ExitCode = 1;

sealed class SoakContext(DbContextOptions<SoakContext> options) : DbContext(options)
{
    public DbSet<TelemetryData> Rows => Set<TelemetryData>();
    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.ApplyConfiguration(new TelemetryDataConfiguration());
    }
}

