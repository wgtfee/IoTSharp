// Dev-only actual internal work-order service -> SQL outbox -> HMAC HTTP -> real MES SQL.
using System.Text;
using System.Text.Json;
using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

static string Need(string name) => Environment.GetEnvironmentVariable(name)
    is { Length: > 0 } value ? value : throw new InvalidOperationException("Missing dev-only parameter " + name);
static void RequireSql(string cs, string db)
{
    var b = new SqlConnectionStringBuilder(cs);
    if (b.DataSource != @"DESKTOP-2ALRK02\MSSQ" || b.InitialCatalog != db)
        throw new InvalidOperationException("Refused unapproved SQL target: " + db);
}
static void Check(bool good, string label)
{
    if (!good) throw new InvalidOperationException("WORKORDER_MES_DEV_FAIL " + label);
    Console.WriteLine("PASS " + label);
}
static async Task<object?> Scalar(string cs, string sql, params (string, object)[] args)
{
    await using var cn = new SqlConnection(cs);
    await cn.OpenAsync();
    await using var cmd = new SqlCommand(sql, cn);
    foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value);
    return await cmd.ExecuteScalarAsync();
}
if (Need("IOTSHARP_MES_LIVE_DEV") != "YES")
    throw new InvalidOperationException("Explicit developer opt-in required");
var pdm = Need("IOTSHARP_MES_PDM_CONNECTION");
var business = Need("IOTSHARP_MES_BUSINESS_CONNECTION");
var system = Need("IOTSHARP_MES_SYSTEM_CONNECTION");
RequireSql(pdm, "IoTSharpPdmDev");
RequireSql(business, "netcoreserver_dev");
RequireSql(system, "netcore");
var key = Need("IOTSHARP_MES_DEV_SHAREDSECRET");
if (Encoding.UTF8.GetByteCount(key) < 32)
    throw new InvalidOperationException("HMAC key too short");
var id = Need("IOTSHARP_MES_DEV_KEYID");
var endpoint = Need("IOTSHARP_MES_DEV_ENDPOINT");
if (endpoint != "http://127.0.0.1:9991/api/integration/iotsharp/events")
    throw new InvalidOperationException("Refused non-loopback endpoint");
Check(Convert.ToInt32(await Scalar(system,
    "SELECT COUNT(*) FROM dbo.Sys_User WHERE UserName='admin' AND Enable=1")) == 1,
    "Approved local MES admin recipient exists");

Guid tenant, customer, device, profile, riskId;
int version;
string riskKey;
var monitorRisk = "";
await using (var cn = new SqlConnection(business))
{
    await cn.OpenAsync();
    await using var cmd = new SqlCommand(@"
        SELECT TOP(1) a.TenantId,a.CustomerId,a.DeviceId,a.ProfileId,
               a.ProfileVersion,a.SourceEventKey,a.RiskStatus
        FROM dbo.MES_IoTAlarm a WHERE a.Summary LIKE N'[[]DEV联调模拟]%'
          AND EXISTS(SELECT 1 FROM dbo.MES_IoTDeviceBinding b
          WHERE b.TenantId=a.TenantId AND b.CustomerId=a.CustomerId
            AND b.DeviceId=a.DeviceId AND b.TargetUser='admin'
            AND b.IsEnabled=1 AND b.IsApproved=1)
          AND NOT EXISTS(
            SELECT 1 FROM IoTSharpPdmDev.dbo.PdmRiskEvent r
            INNER JOIN IoTSharpPdmDev.dbo.PdmInternalWorkOrders w
              ON w.RiskEventId=r.Id AND w.TenantId=r.TenantId
                AND w.CustomerId=r.CustomerId AND w.DeviceId=r.DeviceId
            WHERE r.TenantId=a.TenantId AND r.CustomerId=a.CustomerId
              AND r.DeviceId=a.DeviceId AND r.EventKey=a.SourceEventKey)
        ORDER BY a.LastAtUtc DESC", cn);
    await using var r = await cmd.ExecuteReaderAsync();
    if (!await r.ReadAsync())
        throw new InvalidOperationException("No approved synthetic PdM risk episode for development linkage");
    tenant = r.GetGuid(0);
    customer = r.GetGuid(1);
    device = r.GetGuid(2);
    profile = r.GetGuid(3);
    version = r.GetInt32(4);
    riskKey = r.GetString(5);
    monitorRisk = r.GetString(6);
}
var knownRisk = await Scalar(pdm,
    "SELECT TOP 1 Id FROM dbo.PdmRiskEvent WHERE TenantId=@tenant AND CustomerId=@customer AND DeviceId=@device AND EventKey=@key",
    ("@tenant", tenant), ("@customer", customer), ("@device", device), ("@key", riskKey));
if (knownRisk is not Guid storedRisk || storedRisk == Guid.Empty)
    throw new InvalidOperationException("Missing real persisted risk episode GUID");
riskId = storedRisk;

var qaRecipient = Environment.GetEnvironmentVariable("IOTSHARP_MES_QA_RECIPIENT");
if (!string.IsNullOrEmpty(qaRecipient))
{
    if (!System.Text.RegularExpressions.Regex.IsMatch(qaRecipient, @"^iotqa_[a-f0-9]{12}$") ||
        Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_User WHERE UserName=@name AND Enable=1",
            ("@name", qaRecipient))) != 1)
        throw new InvalidOperationException("An active disposable QA account is required.");
    await using var cn = new SqlConnection(business);
    await cn.OpenAsync();
    await using var cmd = new SqlCommand(
        @"IF NOT EXISTS(SELECT 1 FROM dbo.MES_IoTDeviceBinding
          WHERE TenantId=@tenant AND CustomerId=@customer
          AND DeviceId=@device AND TargetUser=@user)
          INSERT dbo.MES_IoTDeviceBinding
          (TenantId,CustomerId,DeviceId,DeviceName,TargetUser,
           IsEnabled,IsApproved,ApprovedBy,ApprovedAtUtc)
          VALUES(@tenant,@customer,@device,N'[DEV联调模拟] 维修设备',@user,1,1,N'DevE2E',SYSUTCDATETIME())", cn);
    cmd.Parameters.AddWithValue("@tenant", tenant);
    cmd.Parameters.AddWithValue("@customer", customer);
    cmd.Parameters.AddWithValue("@device", device);
    cmd.Parameters.AddWithValue("@user", qaRecipient);
    await cmd.ExecuteNonQueryAsync();
    Check(Convert.ToInt32(await Scalar(business,
        @"SELECT COUNT(*) FROM dbo.MES_IoTDeviceBinding
          WHERE TenantId=@tenant AND CustomerId=@customer
          AND DeviceId=@device AND TargetUser=@user
          AND IsEnabled=1 AND IsApproved=1",
        ("@tenant",tenant),("@customer",customer),
        ("@device",device),("@user",qaRecipient)))==1,
        "Disposable QA person approved for this synthetic repair device");
}

var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Configuration.AddInMemoryCollection(new Dictionary<string,string?>
{
    ["PredictiveMaintenance:WorkOrders:MesSync:Enabled"]="true",
    ["PredictiveMaintenance:WorkOrders:MesSync:SchemaReady"]="true"
});
builder.Services.AddDbContext<PdmInternalWorkOrderDbContext>(o=>o.UseSqlServer(pdm));
builder.Services.AddScoped<PdmInternalWorkOrderService>();
builder.Services.Configure<PdmMesIntegrationOptions>(o =>
{
    o.Enabled=true;
    o.SchemaReady=true;
    o.Endpoint=endpoint;
    o.KeyId=id;
    o.SharedSecret=key;
    o.BatchSize=6;
    o.MaxAttempts=15;
    o.RequestTimeoutSeconds=9;
    o.AllowInsecureLoopbackForDevelopment=true;
});
builder.Services.AddHttpClient<PdmMesApiClient>();
builder.Services.AddHostedService<PdmWorkOrderMesOutboxWorker>();
using var host=builder.Build();
var manager=Guid.NewGuid();
var technician=Guid.NewGuid();
var orderId=Guid.NewGuid();
var number="PM-"+orderId.ToString("N").ToUpperInvariant();
var now=DateTime.UtcNow;
await using (var scope=host.Services.CreateAsyncScope())
{
    var db=scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>();
    db.WorkOrders.Add(new PdmInternalWorkOrder
    {
        Id=orderId,TenantId=tenant,CustomerId=customer,
        DeviceId=device,ProfileId=profile,ProfileVersion=version,
        RiskEventId=riskId,RiskSourceEventKey=riskKey,
        WorkOrderNo=number,RiskLevel="Warning",
        Title="[DEV联调模拟] 设备检修",Description="[DEV联调模拟] 授权人员状态流转测试",
        State="Open",Revision=1,FirstObservedUtc=now.AddHours(-2),
        CreatedAtUtc=now,UpdatedAtUtc=now
    });
    await db.SaveChangesAsync();
}
Console.WriteLine("WORKORDER_DEV_ID "+orderId);
await using (var scope=host.Services.CreateAsyncScope())
{
    var service=scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderService>();
    var assigned=await service.TransitionAsync(tenant,customer,orderId,1,"Assign",
        manager,technician,"[DEV联调模拟] 指派设备维修");
    Check(assigned.State=="Assigned"&&assigned.Revision==2,"Human manager assigned the work order");
    var started=await service.TransitionAsync(tenant,customer,orderId,2,"Start",
        technician,null,"[DEV联调模拟] 维修人员开始工作");
    Check(started.State=="InProgress"&&started.Revision==3,"Assigned technician started repair");
    var blocked=false;
    try {
        await service.TransitionAsync(tenant,customer,orderId,3,"Complete",
            manager,null,"[DEV联调模拟] 不得冒充指派维修人员");
    } catch(InvalidOperationException) {blocked=true;}
    Check(blocked,"Unassigned actor cannot claim repair completion");
    var completed=await service.TransitionAsync(tenant,customer,orderId,3,"Complete",
        technician,null,"[DEV联调模拟] 检查并处理设备散热故障");
    Check(completed.State=="Completed"&&completed.CompletedAtUtc!=null,
        "Genuine work-order Complete transition persisted");
    var afterCompleted=await Scalar(business,
        "SELECT TOP(1) RiskStatus FROM dbo.MES_IoTAlarm WHERE TenantId=@tenant AND CustomerId=@customer AND SourceEventKey=@key",
        ("@tenant",tenant),("@customer",customer),("@key",riskKey));
    Check(Convert.ToString(afterCompleted)==monitorRisk,"Repair does not alter monitoring risk status");
    var closed=await service.TransitionAsync(tenant,customer,orderId,4,"Close",
        manager,null,"[DEV联调模拟] 维修负责人关闭工单");
    Check(closed.State=="Closed"&&closed.ClosedAtUtc!=null,
        "Authorized work-order closure persisted");
    var outbox=await scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>()
        .MesOutbox.Where(x=>x.WorkOrderId==orderId).OrderBy(x=>x.SourceSequence).ToListAsync();
    Check(outbox.Select(x=>x.EventType).SequenceEqual(new[]{
        "WORKORDER_COMPLETED","WORKORDER_CLOSED"}),"Two ordered durable messages created");
    Check(outbox.All(x=>JsonDocument.Parse(x.PayloadJson).RootElement
        .GetProperty("isSynthetic").GetBoolean()),"All test messages explicitly marked synthetic");
}
await host.StartAsync();
try {
    var deadline=DateTimeOffset.UtcNow.AddSeconds(115);
    while(DateTimeOffset.UtcNow<deadline) {
        await using var scope=host.Services.CreateAsyncScope();
        var db=scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>();
        var delivered=await db.MesOutbox.CountAsync(x=>x.WorkOrderId==orderId&&x.DeliveryStatus=="Delivered");
        var state=await Scalar(business,
            "SELECT State FROM dbo.MES_IoTWorkOrder WHERE WorkOrderId=@id",("@id",orderId));
        var count=Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@alarm AND TargetUser='admin' AND Title LIKE N'[[]维修工单%'",
            ("@alarm",Convert.ToString(await Scalar(business,
                "SELECT AlarmId FROM dbo.MES_IoTAlarm WHERE TenantId=@tenant AND CustomerId=@customer AND SourceEventKey=@key",
                ("@tenant",tenant),("@customer",customer),("@key",riskKey)))!)));
        var qaCount=qaRecipient == null ? 0 : Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE TargetUser=@user AND Title LIKE N'[[]维修工单%'",
            ("@user",qaRecipient)));
        if(delivered==2 && Convert.ToString(state)=="Closed" &&
            count>=2 && (qaRecipient == null || qaCount>=2))break;
        await Task.Delay(1100);
    }
    await using(var scope=host.Services.CreateAsyncScope()) {
        var db=scope.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>();
        Check(await db.MesOutbox.CountAsync(x=>x.WorkOrderId==orderId&&x.DeliveryStatus=="Delivered")==2,
            "IoTSharp SQL work-order Outbox delivered both events");
    }
    Check(Convert.ToString(await Scalar(business,
        "SELECT State FROM dbo.MES_IoTWorkOrder WHERE WorkOrderId=@id",("@id",orderId)))=="Closed",
        "MES business database records Closed independent of monitoring");
    Check(Convert.ToInt32(await Scalar(business,
        "SELECT COUNT(*) FROM dbo.MES_IoTAlarmInbox WHERE SourceEventKey=@key AND ProcessingStatus='Processed'",
        ("@key","workorder:"+orderId.ToString("N"))))==2,
        "MES Inbox processed completion and closure in order");
    var alarmId=await Scalar(business,
        "SELECT AlarmId FROM dbo.MES_IoTAlarm WHERE TenantId=@tenant AND CustomerId=@customer AND SourceEventKey=@key",
        ("@tenant",tenant),("@customer",customer),("@key",riskKey));
    Check(alarmId is Guid,"Repair order linked to existing monitoring alarm");
    Check(Convert.ToInt32(await Scalar(system,
        "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin' AND Title LIKE N'[[]维修工单%'",
        ("@id",alarmId!.ToString()!)))==2,
        "Two persistent and distinct MES admin work-order notices");
    if (qaRecipient != null)
        Check(Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser=@user AND Title LIKE N'[[]维修工单%'",
            ("@id",alarmId.ToString()!),("@user",qaRecipient)))>=2,
            "Approved disposable QA user received independent repair notices");
    Check(Convert.ToString(await Scalar(business,
        "SELECT RiskStatus FROM dbo.MES_IoTAlarm WHERE AlarmId=@id",("@id",alarmId)))==monitorRisk,
        "Monitoring recovered/active status unchanged by human repair events");
    await using var sc=host.Services.CreateAsyncScope();
    var record=await sc.ServiceProvider.GetRequiredService<PdmInternalWorkOrderDbContext>()
        .MesOutbox.SingleAsync(x=>x.WorkOrderId==orderId&&x.SourceSequence==1);
    var response=await sc.ServiceProvider.GetRequiredService<PdmMesApiClient>()
        .SendAsync(record.EventId,record.PayloadJson,CancellationToken.None);
    Check(response.Accepted,"Replayed completion has idempotent MES receipt");
    Check(Convert.ToInt32(await Scalar(system,
        "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin' AND Title LIKE N'[[]维修工单%'",
        ("@id",alarmId.ToString()!)))==2,
        "Retry never creates duplicate human repair notifications");
    Console.WriteLine("WORKORDER_DEV_E2E_OK "+JsonSerializer.Serialize(new {
        workOrderId=orderId,alarmId,events=2,mesState="Closed",
        monitoringState=monitorRisk,adminNotices=2,synthetic=true
    }));
} finally {await host.StopAsync(TimeSpan.FromSeconds(9));}
