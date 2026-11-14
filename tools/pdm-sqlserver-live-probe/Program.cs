using System.Diagnostics;
using System.Text.Json;
using IoTSharp.Data;
using IoTSharp.Storage;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

// Strictly opt-in SQL Server development read-only probe. No writes or migrations.
// dotnet run --project tools/pdm-acceptance/provider/SqlServerLiveProbe -- dev-readonly
if (args.Length != 1 || args[0] != "dev-readonly")
{
    Console.Error.WriteLine("Use explicit dev-readonly argument. No query performed.");
    Environment.ExitCode = 2;
    return;
}
try
{
    var root = Directory.GetCurrentDirectory();
    var configPath = Path.Combine(root, "IoTSharp", "appsettings.Development.json");
    if (!File.Exists(configPath))
        throw new InvalidOperationException("Run from the original IoTSharp workspace root");
    using var json = JsonDocument.Parse(await File.ReadAllTextAsync(configPath));
    var conn = json.RootElement.GetProperty("ConnectionStrings")
        .GetProperty("IoTSharp").GetString();
    var csb = new SqlConnectionStringBuilder(conn)
    {
        ConnectTimeout = 5,
        ApplicationName = "IoTSharp-Pdm-Development-ReadProbe",
        ApplicationIntent = ApplicationIntent.ReadOnly
    };
    if (csb.DataSource != @"DESKTOP-2ALRK02\MSSQ" ||
        csb.InitialCatalog != "IOTSharp")
        throw new InvalidOperationException("Not the approved local development instance");
    // Never print, store, or interpolate the password into stdout or report.
    var opts = new DbContextOptionsBuilder<ShardProbeContext>()
        .UseSqlServer(csb.ConnectionString, o => o.CommandTimeout(12))
        .EnableSensitiveDataLogging(false).Options;

    Guid device;
    string key;
    DateTime sampled;
    await using (var connection = new SqlConnection(csb.ConnectionString))
    {
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 5;
        command.CommandText = """
            SELECT TOP (1) DeviceId, KeyName, [DateTime]
            FROM dbo.TelemetryData_202609 WITH (INDEX(PK_TelemetryData_202609))
            """;
        await using var reader = await command.ExecuteReaderAsync();
        if (!await reader.ReadAsync())
            throw new InvalidOperationException("202609 shard has no telemetry");
        device = reader.GetGuid(0);
        key = reader.GetString(1);
        sampled = reader.GetDateTime(2);
    }
    await using var db = new ShardProbeContext(opts);
    var start = DateTime.SpecifyKind(sampled, DateTimeKind.Utc);
    var query = BoundedTelemetryHistoryQuery.Build(
        db.Rows.AsNoTracking(), device, new[] { key },
        start, start.AddMinutes(5), 16);
    var sql = query.ToQueryString();
    if (!sql.Contains("TOP(", StringComparison.OrdinalIgnoreCase) ||
        sql.Contains("Value_Binary", StringComparison.OrdinalIgnoreCase) ||
        sql.Contains("Value_Json", StringComparison.OrdinalIgnoreCase) ||
        sql.Contains("Value_XML", StringComparison.OrdinalIgnoreCase) ||
        sql.Contains("Value_String", StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Bounded provider SQL no longer limits/projections");
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
    var stopwatch = Stopwatch.StartNew();
    var rows = await query.ToListAsync(timeout.Token);
    stopwatch.Stop();
    if (rows.Count is < 1 or > 17)
        throw new InvalidOperationException("Unexpected out-of-bound EF result count");
    var exceeded = false;
    try
    {
        BoundedTelemetryHistoryQuery.CompleteOrThrow(
            rows.Select(row => new IoTSharp.Contracts.TelemetryDataDto
            {
                KeyName = row.KeyName, DateTime = row.DateTime,
                DataType = row.Type, Value = row.Value_Double
            }).ToList(), 16);
    }
    catch (TelemetryHistoryLimitExceededException)
    {
        exceeded = true;
    }
    if (exceeded != (rows.Count > 16))
        throw new InvalidOperationException("Limit+1 rejection contract broken");
    Console.WriteLine($"Result=PASS; Provider=SQLServer; Table=TelemetryData_202609; " +
        $"Rows={rows.Count}; Limit=16; OverLimitReject={exceeded}; " +
        $"ElapsedMs={stopwatch.ElapsedMilliseconds}; SqlTopTranslated=True; " +
        $"LargePayloadProjection=False; RealEFQuery=True; " +
        $"UTCContractSeparatelyApproved=False; ShardingCoreFanoutVerified=False");
}
catch (Exception ex)
{
    // Avoid exception connection-string formatting (credentials must not leak).
    Console.Error.WriteLine("Result=FAIL; ErrorType=" + ex.GetType().Name);
    Environment.ExitCode = 1;
}

internal sealed class ShardProbeContext(
    DbContextOptions<ShardProbeContext> options) : DbContext(options)
{
    public DbSet<TelemetryData> Rows => Set<TelemetryData>();
    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<TelemetryData>().ToTable("TelemetryData_202609");
        b.Entity<TelemetryData>().HasKey(t => new { t.DeviceId, t.KeyName, t.DateTime });
        b.Entity<TelemetryData>().Property(t => t.KeyName).HasColumnType("nvarchar(900)");
    }
}

