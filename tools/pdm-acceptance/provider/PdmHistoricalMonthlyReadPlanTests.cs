using IoTSharp.Contracts;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ShardingCore.Core.ServiceProviders;
using System.Reflection;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

public sealed class PdmHistoricalMonthlyReadPlanTests
{
    private static readonly DateTime Now =
        new(2026,11,14,0,0,0,DateTimeKind.Utc);
    private static readonly DateTime Begin =
        new(2026,8,31,23,59,30,DateTimeKind.Utc);
    private static readonly DateTime End =
        new(2026,9,1,0,0,30,DateTimeKind.Utc);
    private static readonly string[] Present =
        {"TelemetryData_202608","TelemetryData_202609"};

    private static PdmHistoricalMonthlyReadPlan Plan(
        DateTime? begin=null, DateTime? end=null,
        IReadOnlyCollection<string>? tables=null,
        DateTime? verified=null, DateTime? now=null) =>
        PdmHistoricalMonthlyReadPlanner.Create(
            begin??Begin,end??End,
            new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc),
            new DateTime(2026,11,1,0,0,0,DateTimeKind.Utc),
            tables??Present,verified??Now.AddSeconds(-30),now??Now);

    [Fact]
    public void RealExistingAugustAndSeptemberProduceNonMutatingReadPlan()
    {
        var result=Plan();
        Assert.Equal(new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc),
            result.RouteBeginUtc);
        Assert.Equal(Present,result.RequiredTables);
        Assert.False(result.AllowsAutoCreate);
        Assert.False(result.AllowsWrite);
        Assert.False(result.IsProductionApproved);
        Assert.Equal(Begin,result.BeginUtc);
        Assert.Equal(End,result.EndExclusiveUtc);
    }

    [Fact]
    public void MissingEitherMonthlyTableFailsClosed()
    {
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(
            ()=>Plan(tables:new[]{"TelemetryData_202608"}));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(
            ()=>Plan(tables:new[]{"TelemetryData_202609"}));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(
            ()=>Plan(tables:Array.Empty<string>()));
    }

    [Fact]
    public void EndExclusiveAtMonthBoundaryRequiresOnlyAugust()
    {
        var result=Plan(end:new DateTime(2026,9,1,0,0,0,DateTimeKind.Utc),
            tables:new[]{"TelemetryData_202608"});
        Assert.Equal(new[]{"TelemetryData_202608"},result.RequiredTables);
    }

    [Fact]
    public void StaleOrFutureMetadataCannotAuthorizeMissingShards()
    {
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(
            ()=>Plan(verified:Now.AddMinutes(-6)));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(
            ()=>Plan(verified:Now.AddSeconds(1)));
    }

    [Fact]
    public void UntrustedTimestampAndUnboundedWindowAreRejected()
    {
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(()=>
            Plan(begin:DateTime.SpecifyKind(Begin,DateTimeKind.Unspecified)));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(()=>
            Plan(end:Begin.AddHours(2)));
    }

    [Fact]
    public void DuplicateInventoryAndUnapprovedMonthAreRejected()
    {
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(()=>
            Plan(tables:new[]{
                "TelemetryData_202608","TelemetryData_202609",
                "TelemetryData_202609"}));
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(()=>
            Plan(begin:new DateTime(2026,7,31,23,59,0,DateTimeKind.Utc)));
    }

    [Fact]
    public void TwentyFourMonthLookbackIsStrict()
    {
        var now=new DateTime(2028,12,1,0,0,0,DateTimeKind.Utc);
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(()=>
            Plan(now:now,verified:now.AddMinutes(-1)));
    }

    [Fact]
    public void PdmOnlyRealRouteCannotScheduleAnyAutomaticHistoricalTableCreation()
    {
        using var service=new ServiceCollection()
            .AddSingleton(Options.Create(new AppSettings {
                DataBase=DataBaseType.Sqlite,
                ShardingByDateMode=ShardingByDateMode.PerMonth,
                ShardingBeginTime=new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc)
            })).BuildServiceProvider();
        var fake=DispatchProxy.Create<IShardingProvider,
            RealShardingRouteConfigurationTests.ProviderProxy>();
        ((RealShardingRouteConfigurationTests.ProviderProxy)fake).Services=service;
        var route=new PdmReadOnlyTelemetryMonthRoute(fake);
        Assert.False(route.AutoCreateTableByTime());
        Assert.Equal(new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc),
            route.GetBeginTime());
    }
}

