using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Shardings;
using Microsoft.Data.SqlClient;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ShardingCore;

namespace IoTSharp.Storage;

/// <summary>
/// Separate, opt-in ShardingCore read runtime for *existing* historical monthly
/// telemetry tables. Never register with the main ingestion DI container.
/// Never invoke UseAutoTryCompensateTable, EnsureCreated or migrations.
/// A validated fresh physical-table inventory and explicit authorization bounds
/// must be supplied via PdmHistoricalMonthlyReadPlan first.
/// </summary>
public sealed class PdmHistoricalReadOnlyShardingRuntime : IAsyncDisposable
{
    private readonly ServiceProvider _root;
    private readonly AppSettings _settings;
    private readonly PdmHistoricalMonthlyReadPlan _plan;

    private PdmHistoricalReadOnlyShardingRuntime(
        ServiceProvider root, AppSettings settings, PdmHistoricalMonthlyReadPlan plan)
    {
        _root=root;
        _settings=settings;
        _plan=plan;
    }

    /// <summary>
    /// The connection principal MUST itself have SELECT-only permissions.
    /// ApplicationIntent.ReadOnly is not a substitute for database grants.
    /// This constructs a private runtime but does not open the SQL connection.
    /// </summary>
    public static PdmHistoricalReadOnlyShardingRuntime CreateSqlServer(
        PdmHistoricalMonthlyReadPlan plan,string connectionString)
    {
        if(string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("An explicitly approved read-only SQL connection is required.");
        var builder=new SqlConnectionStringBuilder(connectionString)
        {
            ApplicationIntent=ApplicationIntent.ReadOnly,
            ApplicationName="IoTSharp-Pdm-Historical-ReadOnly",
            ConnectTimeout=5
        };
        if(string.IsNullOrWhiteSpace(builder.DataSource) ||
           string.IsNullOrWhiteSpace(builder.InitialCatalog))
            throw new ArgumentException("SQL Server and database identity are required.");
        return Create(plan,builder.ConnectionString,DataBaseType.SqlServer);
    }

    /// <summary>Only for isolated SQLite fixture tests, not production registration.</summary>
    public static PdmHistoricalReadOnlyShardingRuntime CreateIsolatedSqlite(
        PdmHistoricalMonthlyReadPlan plan,string connectionString)
    {
        var builder=new SqliteConnectionStringBuilder(connectionString)
        {
            Mode=SqliteOpenMode.ReadOnly,
            Pooling=false
        };
        if(string.IsNullOrWhiteSpace(builder.DataSource))
            throw new ArgumentException("A pre-existing isolated SQLite file is required.");
        return Create(plan,builder.ConnectionString,DataBaseType.Sqlite);
    }

    private static PdmHistoricalReadOnlyShardingRuntime Create(
        PdmHistoricalMonthlyReadPlan plan,string connectionString,DataBaseType provider)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if(plan.AllowsAutoCreate || plan.AllowsWrite ||
           plan.RequiredTables.Count is <1 or >2 ||
           plan.BeginUtc.Kind!=DateTimeKind.Utc ||
           plan.RouteBeginUtc.Kind!=DateTimeKind.Utc)
            throw new InvalidOperationException("Not a verified, bounded, no-write historical route plan.");
        var settings=new AppSettings
        {
            DataBase=provider,
            ShardingByDateMode=ShardingByDateMode.PerMonth,
            ShardingBeginTime=plan.RouteBeginUtc
        };
        var services=new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IOptions<AppSettings>>(Options.Create(settings));
        var sharding=services.AddShardingDbContext<ShardingDbContext>();
        sharding.UseRouteConfig(o=>o.AddShardingTableRoute<PdmReadOnlyTelemetryMonthRoute>());
        sharding.UseConfig(o=>
        {
            o.ThrowIfQueryRouteNotMatch=true;
            o.UseShellDbContextConfigure(x=>
                x.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
            o.AddDefaultDataSource("pdm-historical-read",connectionString);
            if(provider==DataBaseType.SqlServer)
                o.UseSqlServerToSharding();
            else
                o.UseSQLiteToSharding();
        });
        sharding.AddShardingCore();
        return new PdmHistoricalReadOnlyShardingRuntime(
            services.BuildServiceProvider(),settings,plan);
    }

    /// <summary>
    /// Read exactly the approved time window, using the same bounded query
    /// as P1-07. Never returns partial windows after limit+1 overflow.
    /// </summary>
    public async Task<IReadOnlyList<TelemetryDataDto>> ReadAsync(
        Guid deviceId,IReadOnlyList<string> pointKeys,int maxRows,
        CancellationToken ct=default)
    {
        ct.ThrowIfCancellationRequested();
        var now=DateTime.UtcNow;
        if(_plan.VerifiedAtUtc>now || now-_plan.VerifiedAtUtc>TimeSpan.FromMinutes(5))
            throw new PdmHistoricalShardNotVerifiedException(
                "Historical physical table inventory is stale. Revalidate before opening a database connection.");
        BoundedTelemetryHistoryQuery.Validate(
            deviceId,pointKeys,_plan.BeginUtc,_plan.EndExclusiveUtc,maxRows);
        PdmMonthlyShardRouteGuard.EnsureCovers(
            _settings,_plan.BeginUtc,_plan.EndExclusiveUtc);

        using var scope=_root.CreateScope();
        await using var db=scope.ServiceProvider.GetRequiredService<ShardingDbContext>();
        var query=BoundedTelemetryHistoryQuery.Build(db.Set<TelemetryData>().AsNoTracking(),
            deviceId,pointKeys,_plan.BeginUtc,_plan.EndExclusiveUtc,maxRows);
        var rows=await query.ToListAsync(ct);
        if(rows.Count>maxRows)
            throw new TelemetryHistoryLimitExceededException();
        return rows.Select(x=>new TelemetryDataDto
        {
            DateTime=x.DateTime,
            KeyName=x.KeyName,
            DataType=x.Type,
            Value=x.ToObject()
        }).ToArray();
    }

    public ValueTask DisposeAsync()=>_root.DisposeAsync();
}

