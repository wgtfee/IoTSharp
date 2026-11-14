using System.Diagnostics;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Shardings;
using IoTSharp.Data.Shardings.Routes;
using IoTSharp.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ShardingCore;

// Isolated disposable SQLite; never connect to a live SQL Server.
// Query routes through actual ShardingCore and real TelemetryDataMonthRoute.
if(args.Length!=1 || args[0]!="isolated-sqlite")
    throw new ArgumentException("Requires isolated-sqlite");
var path=Path.Combine(Path.GetTempPath(),"pdm-sharding-runtime-"+Guid.NewGuid().ToString("N")+".sqlite");
var csb = new SqliteConnectionStringBuilder {
    DataSource=path,
    Pooling=false,
    Mode=SqliteOpenMode.ReadWriteCreate
};
try
{
    using var root=CreateIsolatedRuntime(
        csb.ConnectionString,new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc));
    // The only schema creation is inside this private disposable SQLite file.
    root.UseAutoTryCompensateTable();

    var dev=Guid.NewGuid();
    var key="bearing.rms";
    var start=new DateTime(2026,8,31,23,59,35,DateTimeKind.Utc);
    // Seed two physical month tables with known values, avoiding any production DB.
    using(var sql=new SqliteConnection(csb.ConnectionString))
    {
        sql.Open();
        var names=new List<string>();
        using(var cmd=sql.CreateCommand()){
            cmd.CommandText="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'TelemetryData_20260%'";
            using var reader=cmd.ExecuteReader();
            while(reader.Read())names.Add(reader.GetString(0));
        }
        Console.WriteLine("DisposablePhysicalTables="+string.Join(",",names.OrderBy(x=>x)));
        foreach(var required in new[]{"TelemetryData_202608","TelemetryData_202609"})
            if(!names.Contains(required))throw new InvalidOperationException("ShardingCore did not initialize "+required);
        for(var i=0;i<20;i++)
        {
            var t=start.AddSeconds(i*2); // spans month boundary (20 samples / 40 seconds)
            var table=t.Month==8?"TelemetryData_202608":"TelemetryData_202609";
            using var cmd=sql.CreateCommand();
            cmd.CommandText=$"INSERT INTO \"{table}\" (DeviceId,KeyName,DateTime,DataSide,Type,Value_Double) VALUES ($id,$key,$time,$side,$type,$value)";
            cmd.Parameters.AddWithValue("$id",dev);
            cmd.Parameters.AddWithValue("$key",key);
            cmd.Parameters.AddWithValue("$time",t);
            cmd.Parameters.AddWithValue("$side",0);
            cmd.Parameters.AddWithValue("$type",3);
            cmd.Parameters.AddWithValue("$value",(double)i);
            cmd.ExecuteNonQuery();
        }
    }
    using var scope=root.CreateScope();
    await using var db=scope.ServiceProvider.GetRequiredService<ShardingDbContext>();
    var stopwatch=Stopwatch.StartNew();
    var query=BoundedTelemetryHistoryQuery.Build(db.Set<TelemetryData>().AsNoTracking(),
        dev,new[]{key},start,start.AddSeconds(42),16);
    var rows=await query.ToListAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);
    stopwatch.Stop();
    if(rows.Count!=17)throw new InvalidOperationException("Global LIMIT+1 must return 17 rows; got "+rows.Count);
    if(rows.Any(x=>x.DeviceId!=dev || x.KeyName!=key || x.DateTime<start ||
       x.DateTime>=start.AddSeconds(42)))throw new InvalidOperationException("Cross-shard scope/window leaked");
    if(rows.Zip(rows.Skip(1)).Any(x=>x.First.DateTime>x.Second.DateTime))
        throw new InvalidOperationException("Global result ordering invalid");
    if(rows.Count(x=>x.DateTime.Month==8)!=13 || rows.Count(x=>x.DateTime.Month==9)!=4)
        throw new InvalidOperationException("Cross-month globally ordered limit must return 13 August and 4 September rows");
    if(rows.Select(x=>x.Value_Double).Where(x=>x.HasValue)
        .Select(x=>x!.Value).SequenceEqual(Enumerable.Range(0,17).Select(x=>(double)x))==false)
        throw new InvalidOperationException("Cross-month value order disagrees with global DateTime");
    bool rejected=false;
    try
    {
        BoundedTelemetryHistoryQuery.CompleteOrThrow(
            rows.Select(x=>new TelemetryDataDto {
                DateTime=x.DateTime,KeyName=x.KeyName,DataType=x.Type,Value=x.Value_Double
            }).ToList(),16);
    }
    catch(TelemetryHistoryLimitExceededException){rejected=true;}
    if(!rejected)throw new InvalidOperationException("Global limit+1 did not trigger fail-closed over-budget rejection");
    var exclusiveEnd=new DateTime(2026,9,1,0,0,0,DateTimeKind.Utc);
    var augustOnly=await BoundedTelemetryHistoryQuery.Build(
        db.Set<TelemetryData>().AsNoTracking(),dev,new[]{key},
        start,exclusiveEnd,16).ToListAsync();
    if(augustOnly.Count!=13 || augustOnly.Any(x=>x.DateTime.Month!=8))
        throw new InvalidOperationException("Exclusive end at month boundary leaked into September");
    var septemberOnly=await BoundedTelemetryHistoryQuery.Build(
        db.Set<TelemetryData>().AsNoTracking(),dev,new[]{key},
        exclusiveEnd,start.AddSeconds(42),16).ToListAsync();
    if(septemberOnly.Count!=7 || septemberOnly.Any(x=>x.DateTime.Month!=9))
        throw new InvalidOperationException("September month-start routed incorrectly");
    Console.WriteLine("GlobalLimit=PASS; AugustFirst=13; SeptemberInGlobalTop17=4; OverflowRejected=True; EndExclusive=PASS");
    // Rebuild the actual routing runtime with a start MONTH newer than the
    // already-existing August/September tables. No SQL Server is accessed.
    // This tests real legacy-tail discovery instead of guessing from GetBeginTime.
    using var laterRoot=CreateIsolatedRuntime(csb.ConnectionString,
        new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc));
    laterRoot.UseAutoTryCompensateTable();
    using var oldScope=laterRoot.CreateScope();
    await using var historical=oldScope.ServiceProvider.GetRequiredService<ShardingDbContext>();
    var oldRouteRejected=false;
    try
    {
        var olderMonthRows=await BoundedTelemetryHistoryQuery.Build(
            historical.Set<TelemetryData>().AsNoTracking(),dev,new[]{key},
            start,start.AddSeconds(42),16).ToListAsync();
        throw new InvalidOperationException(
            $"Expected a routing failure for unregistered old month; actual rows={olderMonthRows.Count}");
    }
    catch(ShardingCore.Exceptions.ShardingCoreQueryRouteNotMatchException)
    {
        oldRouteRejected=true;
    }
    if(!oldRouteRejected)throw new InvalidOperationException("Older month route rejection not observed");
    var octoberOnlySettings=new AppSettings {
        ShardingByDateMode=ShardingByDateMode.PerMonth,
        ShardingBeginTime=new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc)
    };
    var guardBlocked=false;
    try
    {
        PdmMonthlyShardRouteGuard.EnsureCovers(
            octoberOnlySettings,start,start.AddSeconds(42));
    }
    catch(PdmHistoryRouteNotCoveredException){guardBlocked=true;}
    if(!guardBlocked)throw new InvalidOperationException("Production PdM guard did not reject unregistered old month");
    Console.WriteLine("OlderPhysicalTailDiscovery=NOT_AUTO_DISCOVERED; NativeShardingCoreRouteNotMatch=True; PdmReadGuard=BLOCKED_BEFORE_DB");
    // Fresh PdM-only read runtime: recover pre-existing tails with a validated
    // historical route start. DO NOT call UseAutoTryCompensateTable.
    string[] Tails()
    {
        using var conn=new SqliteConnection(csb.ConnectionString);
        conn.Open();
        using var cmd=conn.CreateCommand();
        cmd.CommandText="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'TelemetryData_%' ORDER BY name";
        using var rd=cmd.ExecuteReader();
        var names=new List<string>();
        while(rd.Read())names.Add(rd.GetString(0));
        return names.ToArray();
    }
    var before=Tails();
    var nowUtc=DateTime.UtcNow;
    var readPlan=PdmHistoricalMonthlyReadPlanner.Create(
        start,start.AddSeconds(42),
        new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc),
        new DateTime(2026,11,1,0,0,0,DateTimeKind.Utc),
        before,nowUtc.AddMinutes(-1),nowUtc);
    if(readPlan.AllowsAutoCreate || readPlan.AllowsWrite ||
       readPlan.IsProductionApproved || readPlan.RequiredTables.Count!=2)
        throw new InvalidOperationException("Untrusted historical read plan");
    using(var restoredRoot=CreateIsolatedRuntime(csb.ConnectionString,
        readPlan.RouteBeginUtc,historicalReadOnly:true))
    {
        // Separate read-only route: no table compensation or schema migrations.
        using var restoredScope=restoredRoot.CreateScope();
        await using var restoredDb=restoredScope.ServiceProvider.GetRequiredService<ShardingDbContext>();
        var restoredRows=await BoundedTelemetryHistoryQuery.Build(
            restoredDb.Set<TelemetryData>().AsNoTracking(),dev,new[]{key},
            start,start.AddSeconds(42),16).ToListAsync();
        if(restoredRows.Count!=17)
            throw new InvalidOperationException(
                "Historical existing-tail recovery without compensation failed: "+restoredRows.Count);
        Console.WriteLine("ReadOnlyHistoricalRoute=PASS; RecoveredRows=17; AutoCreateEnabled=False; CompensationCalls=0");
    }
    // Execute the *reusable standalone* PdM runtime against the same fixture.
    // It opens the SQLite file in ReadOnly mode and cannot issue any DDL.
    await using(var independentRead=PdmHistoricalReadOnlyShardingRuntime
        .CreateIsolatedSqlite(readPlan,csb.ConnectionString))
    {
        var complete=await independentRead.ReadAsync(dev,new[]{key},20);
        if(complete.Count!=20 || complete.Any(x=>x.Value is not double))
            throw new InvalidOperationException(
                "Read-only recovery lost historical rows or numeric values");
        var overBudget=false;
        try
        {
            await independentRead.ReadAsync(dev,new[]{key},16);
        }
        catch(TelemetryHistoryLimitExceededException){overBudget=true;}
        if(!overBudget)
            throw new InvalidOperationException("Read-only recovery incorrectly accepted a truncated window");
        // A: real isolated ShardingCore regression for read-only source scoping.
        // An unrelated device and an unrelated point must not receive existing
        // historical rows from the shared physical monthly tables.
        var otherDevice=await independentRead.ReadAsync(Guid.NewGuid(),new[]{key},20);
        if(otherDevice.Count!=0)
            throw new InvalidOperationException("Cross-device telemetry leakage detected");
        var otherPoint=await independentRead.ReadAsync(dev,new[]{"not.the.approved.point"},20);
        if(otherPoint.Count!=0)
            throw new InvalidOperationException("Cross-point telemetry leakage detected");
        using(var alreadyCancelled=new CancellationTokenSource())
        {
            alreadyCancelled.Cancel();
            var cancelled=false;
            try
            {
                await independentRead.ReadAsync(dev,new[]{key},20,alreadyCancelled.Token);
            }
            catch(OperationCanceledException){cancelled=true;}
            if(!cancelled)
                throw new InvalidOperationException("Canceled historical read unexpectedly performed work");
        }
        Console.WriteLine("StandaloneReadIsolation=PASS; OtherDeviceRows=0; OtherPointRows=0; PreCanceledRequest=Rejected");
        Console.WriteLine("StandalonePdmReadOnlyRuntime=PASS; AllRows=20; NumericProjection=True; OverflowRejected=True");
    }
    var after=Tails();
    if(!before.SequenceEqual(after))
        throw new InvalidOperationException(
            "Read-only historical recovery unexpectedly changed the physical table list");
    Console.WriteLine("ReadOnlyRecoveryNoAdditionalTables=PASS; TableCount="+after.Length);
    Console.WriteLine($"IsolatedRuntime=PASS; Data=SQLite; RoutedBy=ShardingCore; FirstMonth=202608; SecondMonth=202609; Seeded=20; TakePlusOne=17; ElapsedMs={stopwatch.ElapsedMilliseconds}");
}
finally
{
    SqliteConnection.ClearAllPools();
    try{File.Delete(path);}catch(IOException){Console.WriteLine("Temporary SQLite cleanup deferred due to live file handle");}
}


static ServiceProvider CreateIsolatedRuntime(string connectionString,DateTime beginUtc,bool historicalReadOnly=false)
{
    var settings=new AppSettings {
        DataBase=DataBaseType.Sqlite,
        ShardingByDateMode=ShardingByDateMode.PerMonth,
        ShardingBeginTime=beginUtc
    };
    var services=new ServiceCollection();
    services.AddLogging();
    services.AddSingleton<IOptions<AppSettings>>(Options.Create(settings));
    var sharding=services.AddShardingDbContext<ShardingDbContext>();
        sharding.UseRouteConfig(o=>{
        if(historicalReadOnly)
            o.AddShardingTableRoute<PdmReadOnlyTelemetryMonthRoute>();
        else
            o.AddShardingTableRoute<TelemetryDataMonthRoute>();
    });
    sharding.UseConfig(o=>{
        o.ThrowIfQueryRouteNotMatch=true;
        o.UseShellDbContextConfigure(x=>x.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
        o.AddDefaultDataSource("ds0",connectionString);
        o.UseSQLiteToSharding();
    });
    sharding.AddShardingCore();
    return services.BuildServiceProvider();
}