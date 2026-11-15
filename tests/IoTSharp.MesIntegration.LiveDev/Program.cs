// Real development-database rehearsal: IoTSharp risk state machine + same-transaction
// source outbox + real PdmMesOutboxWorker -> running MES API -> MES BusinessDb and SysDb.
// Synthetic flags and unique IDs ensure that no test data appears as a real device fault.
// Requires explicit developer-only environment variables; never accepts production targets.
using System.Data;
using System.Text;
using System.Text.Json;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

static string Require(string key) =>
    Environment.GetEnvironmentVariable(key) is { Length: > 0 } s ? s
    : throw new InvalidOperationException("Missing protected developer environment value " + key);

static void AllowSql(string name, string value, string db)
{
    var b = new SqlConnectionStringBuilder(value);
    if (!b.DataSource.Equals(@"DESKTOP-2ALRK02\MSSQ", StringComparison.OrdinalIgnoreCase)
        || !b.InitialCatalog.Equals(db, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Refused non-developer SQL location for " + name);
}

static async Task<object?> Scalar(string cs, string sql, params (string, object)[] values)
{
    await using var connection = new SqlConnection(cs);
    await connection.OpenAsync();
    await using var command = new SqlCommand(sql, connection);
    foreach (var (key, value) in values) command.Parameters.AddWithValue(key, value);
    return await command.ExecuteScalarAsync();
}

static void Verify(bool ok, string check)
{
    if (!ok) throw new InvalidOperationException("LIVE_DEV_FAIL: " + check);
    Console.WriteLine("PASS " + check);
}

if (Require("IOTSHARP_MES_LIVE_DEV") != "YES")
    throw new InvalidOperationException("Explicit live development rehearsal opt-in required.");
var pdm = Require("IOTSHARP_MES_PDM_CONNECTION");
var business = Require("IOTSHARP_MES_BUSINESS_CONNECTION");
var system = Require("IOTSHARP_MES_SYSTEM_CONNECTION");
AllowSql("IoTSharp PdM", pdm, "IoTSharpPdmDev");
AllowSql("VOL BusinessDb", business, "netcoreserver_dev");
AllowSql("VOL SysDb", system, "netcore");
var secret = Require("IOTSHARP_MES_DEV_SHAREDSECRET");
if (Encoding.UTF8.GetByteCount(secret) < 32)
    throw new InvalidOperationException("HMAC key too short");
var keyId = Require("IOTSHARP_MES_DEV_KEYID");
var endpoint = Require("IOTSHARP_MES_DEV_ENDPOINT");
if (!endpoint.Equals("http://127.0.0.1:9991/api/integration/iotsharp/events",
        StringComparison.Ordinal))
    throw new InvalidOperationException("Only the pinned loopback development endpoint is allowed");
Verify(Convert.ToInt32(await Scalar(system,
    "SELECT COUNT(*) FROM dbo.Sys_User WHERE UserName='admin' AND Enable=1")) == 1,
    "Dev MES administrator account is active");

var tenant = Guid.NewGuid();
var customer = Guid.NewGuid();
var device = Guid.NewGuid();
var profileId = Guid.NewGuid();
var suffix = device.ToString("N")[..10];
var label = "[DEV联调模拟] IoTSharp-" + suffix;
Console.WriteLine("LIVE_DEV_SAMPLE_DEVICE " + suffix);

var additionalRecipient = Environment.GetEnvironmentVariable("IOTSHARP_MES_QA_RECIPIENT");
if (!string.IsNullOrEmpty(additionalRecipient))
{
    if (!System.Text.RegularExpressions.Regex.IsMatch(
        additionalRecipient, @"^iotqa_[a-f0-9]{12}$"))
        throw new InvalidOperationException("Only the disposable QA recipient can be added.");
    Verify(Convert.ToInt32(await Scalar(system,
        "SELECT COUNT(*) FROM dbo.Sys_User WHERE UserName=@name AND Enable=1",
        ("@name", additionalRecipient))) == 1,
        "Genuine-login QA recipient exists and is active");
}
var recipients = string.IsNullOrEmpty(additionalRecipient)
    ? new[] { "admin" }
    : new[] { "admin", additionalRecipient };
await using (var cn = new SqlConnection(business))
{
    await cn.OpenAsync();
    foreach (var recipient in recipients)
    {
        await using var cmd = new SqlCommand(
        @"INSERT dbo.MES_IoTDeviceBinding
            (TenantId,CustomerId,DeviceId,DeviceName,TargetUser,
             IsEnabled,IsApproved,ApprovedBy,ApprovedAtUtc)
          VALUES(@tenant,@customer,@device,@name,@recipient,1,1,'DevE2E',SYSUTCDATETIME())", cn);
        cmd.Parameters.AddWithValue("@tenant", tenant);
        cmd.Parameters.AddWithValue("@customer", customer);
        cmd.Parameters.AddWithValue("@device", device);
        cmd.Parameters.AddWithValue("@name", label);
        cmd.Parameters.AddWithValue("@recipient", recipient);
        await cmd.ExecuteNonQueryAsync();
    }
}
Verify(Convert.ToInt32(await Scalar(business,
    "SELECT COUNT(*) FROM dbo.MES_IoTDeviceBinding WHERE DeviceId=@device AND IsApproved=1",
    ("@device", device))) == recipients.Length,
    "Approved development BusinessDb recipient bindings");

var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Services.AddDbContext<PdmDbContext>(o => o.UseSqlServer(pdm));
builder.Services.Configure<PdmMesIntegrationOptions>(o =>
{
    o.Enabled = true;
    o.SchemaReady = true;
    o.Endpoint = endpoint;
    o.KeyId = keyId;
    o.SharedSecret = secret;
    o.MaxAttempts = 8;
    o.BatchSize = 10;
    o.RequestTimeoutSeconds = 8;
    o.AllowInsecureLoopbackForDevelopment = true;
});
builder.Services.AddHttpClient<PdmMesApiClient>();
builder.Services.AddHostedService<PdmMesOutboxWorker>();
using var host = builder.Build();

string episode;
Guid openEvent;
await using (var scope = host.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
    var outstanding = await db.IntegrationOutbox.CountAsync(x => x.DeliveryStatus == "Pending");
    Verify(outstanding == 0, "No unrelated pending source Outbox rows");

    var profile = new PdmDeviceProfile
    {
        Id = profileId, TenantId = tenant, CustomerId = customer, DeviceId = device,
        Version = 1, Enabled = true, PointMappingsVerified = true,
        RunStateVerified = true, RunStateTelemetryKey = "dev.integration.synthetic.run"
    };
    db.DeviceProfiles.Add(profile);
    await db.SaveChangesAsync();

    var start = DateTimeOffset.UtcNow.AddMinutes(-90);
    var active = (PdmRiskEvent?)null;
    for (var i = 0; i < 5; i++)
    {
        var risk = i switch
        {
            0 or 1 => PdmRiskLevel.Warning,
            2 => PdmRiskLevel.Critical,
            _ => PdmRiskLevel.Normal
        };
        var windowStart = start.AddMinutes(i * 15);
        var windowEnd = windowStart.AddMinutes(15);
        var eval = new PdmHealthEvaluation(
            tenant, customer, device, windowStart, windowEnd, "Good",
            risk switch
            {
                PdmRiskLevel.Warning => 65,
                PdmRiskLevel.Critical => 22,
                _ => 98
            }, risk, 1, Array.Empty<PdmPointAssessment>(),
            new[] { "synthetic live developer integration window" });
        var former = active?.RiskLevel;
        var transition = PdmRiskEventTransitions.Apply(active, eval, profile,
            consecutiveRecoveryWindows: 2, out var changed);
        if (transition == PdmRiskTransitionKind.Opened)
        {
            if (changed == null) throw new Exception("Pdm episode did not open");
            db.RiskEvents.Add(changed);
        }
        active = changed;
        await using var tx = await db.Database.BeginTransactionAsync();
        db.HealthSnapshots.Add(eval.ToSnapshot(profile));
        await PdmMesEventProjector.TryAppendAsync(
            db, profile, active, eval, transition, former, CancellationToken.None,
            isSynthetic: true);
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        Console.WriteLine("PdM " + transition + " " + risk);
    }

    episode = active?.EventKey ?? throw new Exception("Missing risk episode");
    Verify(active.Status == "Cleared", "Real PdM transition engine reached Cleared");
    var outbox = await db.IntegrationOutbox.Where(x => x.SourceEventKey == episode)
        .OrderBy(x => x.SourceSequence).ToListAsync();
    Verify(outbox.Count == 3, "Exactly three source Outbox events committed");
    Verify(outbox.Select(x => x.EventType).SequenceEqual(
        new[] { "ALARM_OPENED", "ALARM_ESCALATED", "ALARM_RECOVERED" }),
        "Actual projector produced OPEN/ESCALATED/RECOVERED in order");
    Verify(outbox.All(x => JsonDocument.Parse(x.PayloadJson)
        .RootElement.GetProperty("isSynthetic").GetBoolean()),
        "Every simulated PdM event is explicitly synthetic");
    openEvent = outbox[0].EventId;
}
await host.StartAsync();
try
{
    var deadline = DateTimeOffset.UtcNow.AddSeconds(90);
    Guid alarmId = Guid.Empty;
    while (DateTimeOffset.UtcNow < deadline)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        var delivered = await db.IntegrationOutbox.CountAsync(x =>
            x.SourceEventKey == episode && x.DeliveryStatus == "Delivered");
        var processed = Convert.ToInt32(await Scalar(business,
            @"SELECT COUNT(*) FROM dbo.MES_IoTAlarmInbox
              WHERE SourceEventKey=@key AND ProcessingStatus='Processed'",
            ("@key", episode)));
        var found = await Scalar(business,
            "SELECT AlarmId FROM dbo.MES_IoTAlarm WHERE SourceEventKey=@key AND RiskStatus='RECOVERED'",
            ("@key", episode));
        alarmId = found is Guid g ? g : Guid.Empty;
        var messages = alarmId == Guid.Empty ? 0 : Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin'",
            ("@id", alarmId.ToString())));
        var qaMessages = alarmId == Guid.Empty || additionalRecipient == null
            ? 0 : Convert.ToInt32(await Scalar(system,
                "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser=@user",
                ("@id", alarmId.ToString()), ("@user", additionalRecipient)));
        if (delivered == 3 && processed == 3 && messages == 3
            && (additionalRecipient == null || qaMessages == 3) && alarmId != Guid.Empty)
        {
            Console.WriteLine("LIVE_DEV_ALARM_ID " + alarmId);
            break;
        }
        await Task.Delay(1100);
    }

    Verify(alarmId != Guid.Empty, "Real MES BusinessDb risk instance recovered");
    Verify(Convert.ToInt32(await Scalar(business,
        "SELECT COUNT(*) FROM dbo.MES_IoTAlarmInbox WHERE SourceEventKey=@key AND ProcessingStatus='Processed'",
        ("@key", episode))) == 3, "Real MES Inbox processed all 3 signed IoTSharp events");
    Verify(Convert.ToInt32(await Scalar(business,
        @"SELECT COUNT(*) FROM dbo.MES_IoTNotificationOutbox d
          WHERE d.EventId IN(SELECT EventId FROM dbo.MES_IoTAlarmInbox WHERE SourceEventKey=@key)
          AND DeliveryStatus='Delivered'",
        ("@key", episode))) == 3 * recipients.Length,
        "MES BusinessDb durable per-user Outbox delivered");
    Verify(Convert.ToInt32(await Scalar(system,
        "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin'",
        ("@id", alarmId.ToString()))) == 3, "Three genuine Sys_Notice messages saved for admin");
    if (additionalRecipient != null)
        Verify(Convert.ToInt32(await Scalar(system,
            "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser=@user",
            ("@id", alarmId.ToString()), ("@user", additionalRecipient))) == 3,
            "Genuine-login QA user has three independent notices");
    Verify(Convert.ToInt32(await Scalar(system,
        @"SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin'
          AND Title LIKE N'[[]设备监测已恢复]%'",
        ("@id", alarmId.ToString()))) == 1, "Recovery notification separately saved in real MES SysDb");

    await using var sourceScope = host.Services.CreateAsyncScope();
    var sourceDb = sourceScope.ServiceProvider.GetRequiredService<PdmDbContext>();
    var row = await sourceDb.IntegrationOutbox.SingleAsync(x => x.EventId == openEvent);
    var client = sourceScope.ServiceProvider.GetRequiredService<PdmMesApiClient>();
    var replay = await client.SendAsync(row, CancellationToken.None);
    Verify(replay.Accepted, "Real HMAC client accepts idempotent MES duplicate receipt");
    Verify(Convert.ToInt32(await Scalar(system,
        "SELECT COUNT(*) FROM dbo.Sys_Notice WHERE BizId=@id AND TargetUser='admin'",
        ("@id", alarmId.ToString()))) == 3,
        "Duplicate delivery does not duplicate real MES notifications");
    Console.WriteLine("LIVE_DEV_E2E_OK " +
        JsonSerializer.Serialize(new { device = label, sourceEventKey = episode,
            alarmId, outboxDelivered = 3, mesProcessed = 3,
            mesSysNotices = 3, recovered = true, synthetic = true }));
}
finally
{
    await host.StopAsync(TimeSpan.FromSeconds(10));
    // Leave the auditable simulated episode/notices for UI review, but do not
    // let a future real PdM polling worker treat the test profile as an active device.
    await using var cleanupScope = host.Services.CreateAsyncScope();
    var metadata = cleanupScope.ServiceProvider.GetRequiredService<PdmDbContext>();
    var stopped = await metadata.DeviceProfiles
        .Where(x => x.Id == profileId && x.DeviceId == device
                    && x.RunStateTelemetryKey == "dev.integration.synthetic.run")
        .ExecuteUpdateAsync(x => x.SetProperty(p => p.Enabled, false));
    Console.WriteLine("DEV_SYNTHETIC_PROFILE_DISABLED " + stopped);
}
