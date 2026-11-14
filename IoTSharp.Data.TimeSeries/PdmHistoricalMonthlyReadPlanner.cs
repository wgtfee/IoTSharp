using System.Globalization;
using IoTSharp.Contracts;

namespace IoTSharp.Storage;

/// <summary>
/// A route admission ticket, NOT an authorization to create missing tables.
/// It must be produced from fresh, trusted read-only sys.tables metadata.
/// Dedicated ShardingCore contexts may only be constructed after this ticket
/// has been checked and must use PdmReadOnlyTelemetryMonthRoute.
/// </summary>
public sealed class PdmHistoricalMonthlyReadPlan
{
    internal PdmHistoricalMonthlyReadPlan(
        DateTime beginUtc, DateTime endExclusiveUtc,
        DateTime routeBeginUtc, IReadOnlyList<string> requiredTables,
        DateTime verifiedAtUtc)
    {
        BeginUtc=beginUtc;
        EndExclusiveUtc=endExclusiveUtc;
        RouteBeginUtc=routeBeginUtc;
        RequiredTables=requiredTables.ToArray();
        VerifiedAtUtc=verifiedAtUtc;
    }

    public DateTime BeginUtc { get; }
    public DateTime EndExclusiveUtc { get; }
    public DateTime RouteBeginUtc { get; }
    public IReadOnlyList<string> RequiredTables { get; }
    public DateTime VerifiedAtUtc { get; }
    public bool AllowsAutoCreate => false;
    public bool AllowsWrite => false;
    public bool IsProductionApproved => false;
}

public sealed class PdmHistoricalShardNotVerifiedException : InvalidOperationException
{
    public PdmHistoricalShardNotVerifiedException(string explanation)
        : base(explanation) { }
}

/// <summary>
/// Conservative opt-in historical-window plan for a separate read-only
/// ShardingCore runtime, without changing the main ingest route or begin time.
/// This class does not open a database or infer telemetry timestamps' UTC
/// contract from SQL Server datetime2.
/// </summary>
public static class PdmHistoricalMonthlyReadPlanner
{
    public static PdmHistoricalMonthlyReadPlan Create(
        DateTime beginUtc, DateTime endExclusiveUtc,
        DateTime approvedEarliestUtc, DateTime approvedLatestExclusiveUtc,
        IReadOnlyCollection<string> knownPhysicalTables,
        DateTime metadataVerifiedUtc, DateTime nowUtc)
    {
        if(!IsUtc(beginUtc) || !IsUtc(endExclusiveUtc) ||
           !IsUtc(approvedEarliestUtc) || !IsUtc(approvedLatestExclusiveUtc) ||
           !IsUtc(metadataVerifiedUtc) || !IsUtc(nowUtc) ||
           beginUtc>=endExclusiveUtc || endExclusiveUtc-beginUtc>TimeSpan.FromHours(1) ||
           approvedEarliestUtc>=approvedLatestExclusiveUtc ||
           approvedEarliestUtc.Year<2000 ||
           nowUtc<metadataVerifiedUtc || nowUtc-metadataVerifiedUtc>TimeSpan.FromMinutes(5))
            throw new PdmHistoricalShardNotVerifiedException(
                "UTC window, explicit approval bounds, or fresh table inventory is missing.");

        if(beginUtc<approvedEarliestUtc || endExclusiveUtc>approvedLatestExclusiveUtc ||
           beginUtc>nowUtc || endExclusiveUtc>nowUtc ||
           beginUtc<nowUtc.AddMonths(-24))
            throw new PdmHistoricalShardNotVerifiedException(
                "Historical query is outside the explicit approved interval or 24-month lookback.");

        if(knownPhysicalTables is null || knownPhysicalTables.Count>3000)
            throw new PdmHistoricalShardNotVerifiedException(
                "Trusted read-only physical table inventory is missing or unbounded.");

        var first=new DateTime(beginUtc.Year,beginUtc.Month,1,0,0,0,DateTimeKind.Utc);
        var lastIncluded=endExclusiveUtc.AddTicks(-1);
        var last=new DateTime(lastIncluded.Year,lastIncluded.Month,1,0,0,0,DateTimeKind.Utc);
        var required=new List<string>();
        for(var month=first;month<=last;month=month.AddMonths(1))
            required.Add("TelemetryData_"+month.ToString("yyyyMM",CultureInfo.InvariantCulture));

        if(required.Count is <1 or >2 ||
           knownPhysicalTables.Distinct(StringComparer.Ordinal).Count()!=knownPhysicalTables.Count ||
           required.Any(name=>!knownPhysicalTables.Contains(name)))
            throw new PdmHistoricalShardNotVerifiedException(
                "The exact existing physical monthly table(s) were not verified; no automatic table creation allowed.");

        return new PdmHistoricalMonthlyReadPlan(
            beginUtc,endExclusiveUtc,first,required,metadataVerifiedUtc);
    }

    private static bool IsUtc(DateTime value)
        => value!=default && value.Kind==DateTimeKind.Utc;
}

