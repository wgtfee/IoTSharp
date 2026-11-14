using System.Reflection;
using IoTSharp.Storage;
using Microsoft.Data.SqlClient;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

/// <summary>
/// Independent provider sign-off regressions. This suite never connects to
/// SQL Server; the previously safety-blocked cross-month query is not retried.
/// </summary>
public sealed class NextProviderHistoricalGateTests
{
    private static readonly DateTime Now =
        new(2026,11,14,0,0,0,DateTimeKind.Utc);
    private static readonly DateTime Aug =
        new(2026,8,31,23,59,30,DateTimeKind.Utc);
    private static readonly DateTime Sep =
        new(2026,9,1,0,0,30,DateTimeKind.Utc);

    private static PdmHistoricalMonthlyReadPlan Ticket(DateTime first,DateTime last,
        string[]? tables=null) => PdmHistoricalMonthlyReadPlanner.Create(
            first,last,new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc),
            new DateTime(2026,11,1,0,0,0,DateTimeKind.Utc),
            tables??new[]{"TelemetryData_202608","TelemetryData_202609"},
            Now.AddMinutes(-1),Now);

    [Fact]
    public void ReadOnlyRuntimeIsNotRegisteredWithTheProductionStartup()
    {
        // This is a deliberate opt-in constructor, not a real provider rollout.
        var methods=typeof(PdmHistoricalReadOnlyShardingRuntime)
            .GetMethods(BindingFlags.Public|BindingFlags.Static);
        Assert.Contains(methods,x=>x.Name=="CreateSqlServer");
        Assert.Contains(methods,x=>x.Name=="CreateIsolatedSqlite");
        var root=LocateRoot();
        var startup=File.ReadAllText(Path.Combine(root,"IoTSharp","Startup.cs"));
        Assert.DoesNotContain("PdmHistoricalReadOnlyShardingRuntime",startup);
        Assert.DoesNotContain("PdmSqlServerHistoricalTableInventory",startup);
        Assert.DoesNotContain("PdmReadOnlyTelemetryMonthRoute",startup);
    }

    [Fact]
    public void ApprovalTicketRejectsMissingOrStaleCrossMonthShard()
    {
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(() =>
            Ticket(Aug,Sep,new[]{"TelemetryData_202609"}));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(() =>
            Ticket(Aug,Sep,new[]{"TelemetryData_202608"}));
        var septemberOnly=Ticket(new DateTime(2026,9,1,0,0,0,DateTimeKind.Utc),
            Sep,new[]{"TelemetryData_202609"});
        Assert.Equal(new[]{"TelemetryData_202609"},septemberOnly.RequiredTables);
        Assert.False(septemberOnly.AllowsAutoCreate);
        Assert.False(septemberOnly.IsProductionApproved);
    }

    [Fact]
    public async Task UnapprovedRequestAndCancelledRequestCannotOpenSqlServer()
    {
        var inventory=new PdmSqlServerHistoricalTableInventory();
        using var cts=new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            inventory.PrepareAsync("not-an-sql-connection",Aug,Sep,
                Aug.AddMinutes(1),Sep,cts.Token));
        await Assert.ThrowsAsync<PdmHistoricalShardNotVerifiedException>(() =>
            inventory.PrepareAsync("not-an-sql-connection",Aug,Sep,
                Aug.AddMinutes(1),Sep));
    }

    [Fact]
    public void SqlServerApplicationIntentAloneIsNotReadOnlyGrant()
    {
        var b=new SqlConnectionStringBuilder(
            "Server=localhost;Database=isolated;User ID=untrusted;Password=synthetic");
        b.ApplicationIntent=ApplicationIntent.ReadOnly;
        // A connection-string flag is not proof of SQL GRANT SELECT / DENY DDL.
        Assert.Equal(ApplicationIntent.ReadOnly,b.ApplicationIntent);
        var requirements=ProviderAcceptanceGate.Check(
            new ProviderEvidence("sqlserver","isolated-dev",
                new string('a',64),new string('a',64),new string('a',64),
                new string('a',64),new string('a',64),
                LeastPrivilegeReadOnly:false,PhysicalShardFanoutReviewed:false,
                RealProviderObserved:false,Now),Now);
        Assert.Equal(ProviderAcceptanceVerdict.Blocked,requirements.Verdict);
        Assert.Contains("least privilege not proven",requirements.Missing);
    }

    private static string LocateRoot()
    {
        var dir=new DirectoryInfo(Directory.GetCurrentDirectory());
        for(var i=0;i<12 && dir is not null;dir=dir.Parent,i++)
            if(File.Exists(Path.Combine(dir.FullName,"IoTSharp","Startup.cs")))
                return dir.FullName;
        throw new DirectoryNotFoundException("IoTSharp checkout unavailable");
    }
}

