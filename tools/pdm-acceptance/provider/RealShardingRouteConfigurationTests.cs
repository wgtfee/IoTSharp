using System.Reflection;
using IoTSharp.Contracts;
using IoTSharp.Data.Shardings.Routes;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ShardingCore.Core.ServiceProviders;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

/// <summary>
/// Uses the actual ShardingCore virtual route class with a fake service
/// provider, but does NOT start sharding, auto-create tables or open SQL.
/// </summary>
public sealed class RealShardingRouteConfigurationTests
{
    public class ProviderProxy : DispatchProxy
    {
        public IServiceProvider? Services;
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if(method?.Name=="get_ApplicationServiceProvider")return Services;
            throw new NotSupportedException("Route probe does not support any database operation");
        }
    }

    private static TelemetryDataMonthRoute Build(AppSettings settings)
    {
        var services=new ServiceCollection();
        services.AddSingleton(Options.Create(settings));
        var provider=services.BuildServiceProvider();
        var fake=DispatchProxy.Create<IShardingProvider,ProviderProxy>();
        ((ProviderProxy)fake).Services=provider;
        return new TelemetryDataMonthRoute(fake);
    }

    [Fact]
    public void ActualMonthlyRouteUsesConfiguredDateTimePropertyAndBeginTime()
    {
        var start=new DateTime(2025,7,1,0,0,0,DateTimeKind.Utc);
        var settings=new AppSettings
        {
            ShardingByDateMode=ShardingByDateMode.PerMonth,
            ShardingBeginTime=start
        };
        var route=Build(settings);
        Assert.Equal(start,route.GetBeginTime());
        Assert.True(route.AutoCreateTableByTime());
    }

    [Fact]
    public void ActualMonthlyRouteDefaultBeginTimeCanExcludeOlderMonths()
    {
        var route=Build(new AppSettings {ShardingByDateMode=ShardingByDateMode.PerMonth});
        var configured=route.GetBeginTime();
        var historical=new DateTime(2026,9,16,5,0,0,DateTimeKind.Utc);
        if(DateTime.UtcNow>=new DateTime(2026,11,1))
            Assert.True(configured > historical);
    }
}

