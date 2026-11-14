using IoTSharp.Contracts;

namespace IoTSharp.Storage;

/// <summary>
/// Fail-closed guard for PdM bounded reads through a time-sharded history provider.
/// Existing physical tables are NOT proof that ShardingCore enumerated their route
/// tails; an older query can otherwise become an untrusted empty result.
/// No database, no schema operations and no runtime route discovery are performed.
/// </summary>
public static class PdmMonthlyShardRouteGuard
{
    public static void EnsureCovers(
        AppSettings settings, DateTime beginUtc, DateTime endUtc)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if(settings.ShardingByDateMode!=ShardingByDateMode.PerMonth)
            return;

        if(beginUtc.Kind!=DateTimeKind.Utc || endUtc.Kind!=DateTimeKind.Utc ||
           beginUtc>=endUtc)
            throw new ArgumentException("PdM monthly history requires a valid UTC half-open window.");

        var configuredBegin=settings.ShardingBeginTime;
        if(configuredBegin.Year < 2000 ||
           configuredBegin.Kind==DateTimeKind.Local)
            throw new InvalidOperationException(
                "PdM monthly ShardingBeginTime is not a trusted historical route lower bound.");
        // ShardingCore enumerates monthly routes from its configured begin time.
        // A table created in previous runs is NOT automatically a usable route tail.
        if(beginUtc.Year<configuredBegin.Year ||
           (beginUtc.Year==configuredBegin.Year &&
            beginUtc.Month<configuredBegin.Month))
            throw new PdmHistoryRouteNotCoveredException(
                beginUtc.ToString("yyyyMM",System.Globalization.CultureInfo.InvariantCulture),
                configuredBegin.ToString("yyyyMM",System.Globalization.CultureInfo.InvariantCulture));
    }
}

public sealed class PdmHistoryRouteNotCoveredException : InvalidOperationException
{
    public PdmHistoryRouteNotCoveredException(string requestedMonth,string routeBeginMonth)
        : base($"PdM history month {requestedMonth} predates the configured ShardingCore route begin " +
               $"{routeBeginMonth}; historical shard availability is unverified. Refuse to infer 'no data'. " +
               "Validate the historical route configuration in an isolated environment before retrying.")
    {
        RequestedMonth=requestedMonth;
        RouteBeginMonth=routeBeginMonth;
    }

    public string RequestedMonth {get;}
    public string RouteBeginMonth {get;}
}

