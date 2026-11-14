using IoTSharp.Contracts;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

public sealed class PdmMonthlyShardRouteGuardTests
{
    private static readonly DateTime Historic =
        new(2026,9,16,5,0,0,DateTimeKind.Utc);
    private static AppSettings Settings(DateTime begin) => new() {
        DataBase=DataBaseType.SqlServer,
        ShardingByDateMode=ShardingByDateMode.PerMonth,
        ShardingBeginTime=begin
    };

    [Fact]
    public void MonthBeforeRouteStartExplicitlyFailsInsteadOfReturningEmptyHistory()
    {
        var settings=Settings(new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc));
        var ex=Assert.Throws<PdmHistoryRouteNotCoveredException>(
            ()=>PdmMonthlyShardRouteGuard.EnsureCovers(
                settings,Historic,Historic.AddMinutes(15)));
        Assert.Equal("202609",ex.RequestedMonth);
        Assert.Equal("202610",ex.RouteBeginMonth);
        Assert.Contains("Refuse to infer 'no data'",ex.Message);
    }

    [Fact]
    public async Task ActualShardingStorageRejectsOlderMonthBeforeAnyDatabaseIsResolved()
    {
        var services=new ServiceCollection().BuildServiceProvider();
        var storage=new ShardingStorage(NullLogger<ShardingStorage>.Instance,
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(Settings(new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc))));
        var ex=await Assert.ThrowsAsync<PdmHistoryRouteNotCoveredException>(()=>
            storage.LoadTelemetryBoundedAsync(Guid.NewGuid(),new[]{"bearing.rms"},
                Historic,Historic.AddMinutes(15),16,CancellationToken.None));
        Assert.Equal("202609",ex.RequestedMonth);
        // No ShardingDbContext is registered here, so a DB resolution would fail.
    }

    [Fact]
    public void ExplicitHistoricalRouteBeginAllowsValidWindowToProceed()
    {
        var settings=Settings(new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc));
        PdmMonthlyShardRouteGuard.EnsureCovers(
            settings,Historic,Historic.AddMinutes(15));
        PdmMonthlyShardRouteGuard.EnsureCovers(
            settings,new DateTime(2026,8,31,23,59,30,DateTimeKind.Utc),
            new DateTime(2026,9,1,0,0,30,DateTimeKind.Utc));
    }

    [Fact]
    public void MonthStartEqualsRouteBeginAndCrossMonthExclusiveWindowAllowed()
    {
        var settings=Settings(new DateTime(2026,9,25,0,0,0,DateTimeKind.Utc));
        PdmMonthlyShardRouteGuard.EnsureCovers(settings,
            new DateTime(2026,9,1,0,0,0,DateTimeKind.Utc),
            new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc));
    }

    [Fact]
    public void InvalidTimesCannotSilentlyBeInterpretedAsUtc()
    {
        var settings=Settings(new DateTime(2026,8,1,0,0,0,DateTimeKind.Utc));
        Assert.Throws<ArgumentException>(()=>PdmMonthlyShardRouteGuard.EnsureCovers(
            settings,DateTime.SpecifyKind(Historic,DateTimeKind.Unspecified),
            Historic.AddMinutes(15)));
    }

    [Fact]
    public void NonMonthlyRouteDoesNotApplyMonthlySpecificCoverageRule()
    {
        var settings=Settings(new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc));
        settings.ShardingByDateMode=ShardingByDateMode.PerDay;
        PdmMonthlyShardRouteGuard.EnsureCovers(settings,Historic,Historic.AddMinutes(15));
    }
}

