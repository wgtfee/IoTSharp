using Xunit;

namespace IoTSharp.PdM.Acceptance.Soak;

public sealed record NextSoakGcSnapshot(
    DateTimeOffset AtUtc, long TotalAllocatedBytes, long ManagedHeapBytes,
    long WorkingSetBytes, long Gen0Collections, long Gen1Collections,
    long Gen2Collections, double GcPausePercent, int ActiveQueuedWorkItems);

public sealed record NextSoakResourceEvaluation(
    bool AcceptedForIndependentReview, IReadOnlyList<string> Reasons,
    bool ProductionApproved=false);

/// <summary>
/// Verifies *external measured evidence only*. Never runs a load generator,
/// never impersonates an actual 1h/4h execution or a production benchmark.
/// </summary>
public static class NextSoakResourceIntegrityGate
{
    public static NextSoakResourceEvaluation Inspect(
        SoakRun run, IReadOnlyList<NextSoakGcSnapshot> gc,
        TimeSpan expected)
    {
        ArgumentNullException.ThrowIfNull(run);
        ArgumentNullException.ThrowIfNull(gc);
        var issues=new List<string>();
        var legacy=SoakEvidenceGate.Inspect(run,expected);
        if(legacy.Verdict!=SoakEvidenceVerdict.ReadyForIndependentReview)
            issues.AddRange(legacy.Reasons);
        if(run.IsSynthetic)issues.Add("synthetic data cannot verify long-running GC");
        var count=(int)expected.TotalMinutes;
        if(gc.Count<count+1 || gc.Count>count+100)
            issues.Add("missing or unbounded resource snapshots");
        if(gc.Count>0)
        {
            var previous=gc[0];
            if(previous.AtUtc.Offset!=TimeSpan.Zero ||
               previous.TotalAllocatedBytes<0 || previous.ManagedHeapBytes<0 ||
               previous.WorkingSetBytes<0 || previous.Gen0Collections<0 ||
               previous.Gen1Collections<0 || previous.Gen2Collections<0)
                issues.Add("invalid initial GC/working-set counters");
            for(var i=0;i<gc.Count;i++)
            {
                var x=gc[i];
                if(x.AtUtc.Offset!=TimeSpan.Zero ||
                   x.AtUtc<run.StartedUtc || x.AtUtc>run.EndedUtc ||
                   !double.IsFinite(x.GcPausePercent) ||
                   x.GcPausePercent<0 || x.GcPausePercent>100 ||
                   x.TotalAllocatedBytes<0 || x.ManagedHeapBytes<0 ||
                   x.WorkingSetBytes<0 || x.ActiveQueuedWorkItems<0 ||
                   x.Gen0Collections<0 || x.Gen1Collections<0 || x.Gen2Collections<0)
                {
                    issues.Add("invalid resource values/timestamps");break;
                }
                if(i>0)
                {
                    if(x.AtUtc<=previous.AtUtc ||
                       x.AtUtc-previous.AtUtc>TimeSpan.FromMinutes(2) ||
                       x.TotalAllocatedBytes<previous.TotalAllocatedBytes ||
                       x.Gen0Collections<previous.Gen0Collections ||
                       x.Gen1Collections<previous.Gen1Collections ||
                       x.Gen2Collections<previous.Gen2Collections)
                    {issues.Add("resource counter reset, missing minute or out-of-order sample");break;}
                }
                previous=x;
            }
            if(gc[^1].AtUtc-gc[0].AtUtc<expected)
                issues.Add("GC sample timestamps do not cover the actual run");
        }
        return new(issues.Count==0,issues);
    }
}

public sealed class NextSoakResourceIntegrityTests
{
    private static readonly DateTimeOffset Start =
        new(2026,11,13,0,0,0,TimeSpan.Zero);

    private static (SoakRun Run,NextSoakGcSnapshot[] Gc) Fixture(
        int minutes,bool synthetic=false)
    {
        var samples=Enumerable.Range(0,minutes+1).Select(i=>
            new SoakMinuteSample(Start.AddMinutes(i),i*2_000_000L,
                i*2_000_000L,0,0,780,24,17,0,0)).ToArray();
        var gc=Enumerable.Range(0,minutes+1).Select(i=>
            new NextSoakGcSnapshot(Start.AddMinutes(i),i*100000L,
                30_000_000,120_000_000,i/3,i/10,i/20,0.2,0)).ToArray();
        var run=new SoakRun("sqlserver","isolated-staging",
            Start,Start.AddMinutes(minutes),1_000_000,synthetic,
            new string('a',64),samples);
        return (run,gc);
    }

    [Fact]
    public void SyntheticFourHourOrShortRunCannotGainRealReadiness()
    {
        var (synthetic,gc)=Fixture(240,true);
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            synthetic,gc,TimeSpan.FromHours(4)).AcceptedForIndependentReview);
        var (shortRun,shortGc)=Fixture(1);
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            shortRun,shortGc,TimeSpan.FromHours(1)).AcceptedForIndependentReview);
    }

    [Fact]
    public void ConsistentOneHourEvidenceOnlyAdvancesToIndependentReview()
    {
        var (run,gc)=Fixture(60);
        var evidence=NextSoakResourceIntegrityGate.Inspect(
            run,gc,TimeSpan.FromHours(1));
        Assert.True(evidence.AcceptedForIndependentReview);
        Assert.False(evidence.ProductionApproved);
    }

    [Fact]
    public void GcPauseAboveHundredPercentAndResetsAreRejected()
    {
        var (run,gc)=Fixture(60);
        gc[20]=gc[20] with {GcPausePercent=150};
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            run,gc,TimeSpan.FromHours(1)).AcceptedForIndependentReview);
        (run,gc)=Fixture(60);
        gc[30]=gc[30] with {Gen2Collections=0};
        gc[31]=gc[31] with {Gen2Collections=0};
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            run,gc,TimeSpan.FromHours(1)).AcceptedForIndependentReview);
    }

    [Fact]
    public void MissingGcWindowOrNonZeroSpoolBlocksLongStability()
    {
        var (run,gc)=Fixture(60);
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            run,gc.Take(40).ToArray(),TimeSpan.FromHours(1)).AcceptedForIndependentReview);
        var samples=run.MinuteSamples.ToArray();
        samples[^1]=samples[^1] with {SpoolPendingRows=17};
        Assert.False(NextSoakResourceIntegrityGate.Inspect(
            run with {MinuteSamples=samples},gc,TimeSpan.FromHours(1)).AcceptedForIndependentReview);
    }
}

