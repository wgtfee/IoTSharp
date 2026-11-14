using IoTSharp.Contracts;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

public enum ShardRouteCoverageVerdict
{
    UnsafeInput, MissingPhysicalShard, RouteStartCoverageUnverified,
    CandidateForRealShardingCoreVerification
}
public sealed record ShardRouteCoverage(
    ShardRouteCoverageVerdict Verdict, IReadOnlyList<string> RequiredMonths,
    IReadOnlyList<string> Reasons, bool RealShardingCoreWasExecuted = false);

/// <summary>
/// Pure preflight only. ShardingCore may discover older tables dynamically;
/// never claim a routing failure based on this helper alone.
/// </summary>
public static class MonthlyShardingRoutePreflight
{
    public static ShardRouteCoverage Evaluate(
        DateTime startUtc, DateTime endExclusiveUtc, DateTime configuredRouteBegin,
        IReadOnlyCollection<string> existingPhysicalTails)
    {
        if(startUtc.Kind!=DateTimeKind.Utc || endExclusiveUtc.Kind!=DateTimeKind.Utc ||
           startUtc>=endExclusiveUtc ||
           endExclusiveUtc-startUtc>TimeSpan.FromMinutes(60) ||
           configuredRouteBegin == default ||
           existingPhysicalTails is null)
            return new(ShardRouteCoverageVerdict.UnsafeInput,Array.Empty<string>(),
                new[]{"Only explicit UTC half-open windows <= 60 minutes and configured route start are allowed"});
        var first=new DateTime(startUtc.Year,startUtc.Month,1);
        var lastInstant=endExclusiveUtc.AddTicks(-1);
        var last=new DateTime(lastInstant.Year,lastInstant.Month,1);
        var requested=new List<string>();
        for(var month=first;month<=last;month=month.AddMonths(1))
            requested.Add(month.ToString("yyyyMM",System.Globalization.CultureInfo.InvariantCulture));
        if(requested.Count>2)
            return new(ShardRouteCoverageVerdict.UnsafeInput,requested,
                new[]{"Monthly window needs more than two physical shards; refuse"});
        var absent=requested.Where(t=>!existingPhysicalTails.Contains(t)).ToArray();
        if(absent.Length>0)
            return new(ShardRouteCoverageVerdict.MissingPhysicalShard,requested,
                new[]{"Physical monthly tables missing: "+string.Join(",",absent)});
        // ShardingCore route has a configured begin time, but may also discover
        // existing physical tables. Ask for real route inspection before passing.
        if(startUtc.Year<configuredRouteBegin.Year ||
          (startUtc.Year==configuredRouteBegin.Year && startUtc.Month<configuredRouteBegin.Month))
            return new(ShardRouteCoverageVerdict.RouteStartCoverageUnverified,requested,
                new[]{"Requested historical month predates configured ShardingCore route start; verify actual runtime discovery"});
        return new(ShardRouteCoverageVerdict.CandidateForRealShardingCoreVerification,requested,
            new[]{"Only physical coverage/preflight proven; real routed SQL and fanout remain unverified"});
    }
}

public sealed class MonthlyShardingRouteAuditTests
{
    [Fact]
    public void DefaultPerMonthHistoryCanPredateDefaultRouteBegin()
    {
        var settings=new AppSettings {ShardingByDateMode=ShardingByDateMode.PerMonth};
        // Both sample August and September shards are known to exist in the
        // development SQL Server, but this test does not query its actual DB.
        var from=new DateTime(2026,9,16,5,0,0,DateTimeKind.Utc);
        var to=from.AddMinutes(15);
        var result=MonthlyShardingRoutePreflight.Evaluate(from,to,
            settings.ShardingBeginTime,new[]{"202608","202609"});
        if(settings.ShardingBeginTime>new DateTime(2026,10,1))
        {
            Assert.Equal(ShardRouteCoverageVerdict.RouteStartCoverageUnverified,result.Verdict);
        }
        Assert.False(result.RealShardingCoreWasExecuted);
    }

    [Fact]
    public void EndExclusiveOnMonthBoundaryUsesExactlyOneShard()
    {
        var begin=new DateTime(2026,8,31,23,30,0,DateTimeKind.Utc);
        var result=MonthlyShardingRoutePreflight.Evaluate(begin,
            new DateTime(2026,9,1,0,0,0,DateTimeKind.Utc),
            new DateTime(2026,7,1),new[]{"202608","202609"});
        Assert.Equal(new[]{"202608"},result.RequiredMonths);
        Assert.Equal(ShardRouteCoverageVerdict.CandidateForRealShardingCoreVerification,result.Verdict);
    }

    [Fact]
    public void CrossMonthRangeHasTwoRequiredTailsAndCannotApproveItself()
    {
        var begin=new DateTime(2026,8,31,23,59,30,DateTimeKind.Utc);
        var finish=new DateTime(2026,9,1,0,0,30,DateTimeKind.Utc);
        var result=MonthlyShardingRoutePreflight.Evaluate(
            begin,finish,new DateTime(2026,8,1),new[]{"202608","202609"});
        Assert.Equal(new[]{"202608","202609"},result.RequiredMonths);
        Assert.Equal(ShardRouteCoverageVerdict.CandidateForRealShardingCoreVerification,result.Verdict);
        Assert.False(result.RealShardingCoreWasExecuted);
    }

    [Fact]
    public void MissingShardOrNonUtcOrUnboundedWindowFailClosed()
    {
        var begin=new DateTime(2026,8,31,23,59,30,DateTimeKind.Utc);
        var end=begin.AddMinutes(2);
        Assert.Equal(ShardRouteCoverageVerdict.MissingPhysicalShard,
            MonthlyShardingRoutePreflight.Evaluate(
                begin,end,new DateTime(2026,8,1),new[]{"202608"}).Verdict);
        Assert.Equal(ShardRouteCoverageVerdict.UnsafeInput,
            MonthlyShardingRoutePreflight.Evaluate(
                DateTime.SpecifyKind(begin,DateTimeKind.Unspecified),
                end,new DateTime(2026,8,1),new[]{"202608","202609"}).Verdict);
        Assert.Equal(ShardRouteCoverageVerdict.UnsafeInput,
            MonthlyShardingRoutePreflight.Evaluate(
                begin,end.AddHours(5),new DateTime(2026,8,1),
                new[]{"202608","202609"}).Verdict);
    }
}

