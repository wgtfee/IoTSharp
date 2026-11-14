using Xunit;

namespace IoTSharp.PdM.Acceptance.Soak;

public enum SoakEvidenceVerdict
{
    NoRealRunEvidence, UnsafeMeasurements,
    ReadyForIndependentReview // not production deployment approval
}

public sealed record SoakMinuteSample(
    DateTimeOffset AtUtc, long InputRowsTotal, long DurableRowsTotal,
    long DroppedRowsTotal, long DuplicateRowsTotal,
    double MemoryMiB, double CpuPercent, double HistoryQueryP99Ms,
    int SpoolPendingRows, int ProviderErrors);

public sealed record SoakRun(
    string Provider, string EnvironmentScope, DateTimeOffset StartedUtc,
    DateTimeOffset EndedUtc, int ConfiguredPointCount, bool IsSynthetic,
    string ReproducibleConfigurationSha256,
    IReadOnlyList<SoakMinuteSample> MinuteSamples);

public sealed record SoakEvaluation(
    SoakEvidenceVerdict Verdict, int RecordedMinutes,
    IReadOnlyList<string> Reasons,
    bool IsProductionApproved=false);

/// <summary>
/// Only checks the quality of an EXTERNAL real soak evidence bundle; it does not
/// generate pressure, connect to DBs or assert production safety.
/// </summary>
public static class SoakEvidenceGate
{
    public static SoakEvaluation Inspect(SoakRun run, TimeSpan expectedDuration)
    {
        ArgumentNullException.ThrowIfNull(run);
        var missing=new List<string>();
        if(expectedDuration!=TimeSpan.FromHours(1) &&
           expectedDuration!=TimeSpan.FromHours(4))
            throw new ArgumentException("Only declared 1h or 4h evaluation supported");
        if(run.Provider is not ("sqlserver" or "postgresql" or "influxdb"))
            missing.Add("unsupported provider");
        if(run.EnvironmentScope!="isolated-staging")
            missing.Add("not an isolated staging environment");
        if(run.IsSynthetic)missing.Add("synthetic telemetry cannot prove long stability");
        if(run.ConfiguredPointCount<1_000_000)
            missing.Add("less than one million configured points");
        if(run.ReproducibleConfigurationSha256 is not {Length:64} ||
           run.ReproducibleConfigurationSha256.Any(x =>
               x is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            missing.Add("missing reproducible setup fingerprint");
        if(run.StartedUtc.Offset!=TimeSpan.Zero || run.EndedUtc.Offset!=TimeSpan.Zero ||
           run.EndedUtc<=run.StartedUtc ||
           run.EndedUtc-run.StartedUtc<expectedDuration)
            missing.Add("actual UTC elapsed time shorter than declared duration");
        var rows=run.MinuteSamples ?? Array.Empty<SoakMinuteSample>();
        if(rows.Count<(int)expectedDuration.TotalMinutes+1)
            missing.Add("insufficient real minute observations");
        if(missing.Count>0)
            return new(SoakEvidenceVerdict.NoRealRunEvidence,
                rows.Count,missing);
        var previous=DateTimeOffset.MinValue;
        var prevInput=0L; var prevStored=0L;
        for(var i=0;i<rows.Count;i++)
        {
            var x=rows[i];
            if(x.AtUtc.Offset!=TimeSpan.Zero ||
               x.AtUtc<run.StartedUtc || x.AtUtc>run.EndedUtc ||
               (i>0 && (x.AtUtc<=previous ||
                         x.AtUtc-previous>TimeSpan.FromMinutes(2))) ||
               x.InputRowsTotal<prevInput || x.DurableRowsTotal<prevStored ||
               x.DroppedRowsTotal<0 || x.DuplicateRowsTotal<0 ||
               !double.IsFinite(x.MemoryMiB) || x.MemoryMiB<0 ||
               !double.IsFinite(x.CpuPercent) || x.CpuPercent<0 || x.CpuPercent>100 ||
               !double.IsFinite(x.HistoryQueryP99Ms) || x.HistoryQueryP99Ms<0 ||
               x.SpoolPendingRows<0 || x.ProviderErrors<0)
            {
                missing.Add($"invalid timeline/counter at observation {i+1}");
                break;
            }
            prevInput=x.InputRowsTotal;prevStored=x.DurableRowsTotal;previous=x.AtUtc;
        }
        if(rows[^1].AtUtc-rows[0].AtUtc<expectedDuration)
            missing.Add("sampled interval does not cover declared duration");
        if(rows.Any(x=>x.DroppedRowsTotal>0))
            missing.Add("nonzero dropped rows require investigation");
        if(rows.Any(x=>x.ProviderErrors>0))
            missing.Add("any observed provider errors require investigation");
        if(rows[^1].SpoolPendingRows!=0)
            missing.Add("durable spool must be drained at the end of the measured period");
        if(rows[^1].DurableRowsTotal>rows[^1].InputRowsTotal)
            missing.Add("durable row count exceeds input");
        if(missing.Count>0)
            return new(SoakEvidenceVerdict.UnsafeMeasurements,rows.Count,missing);
        return new(SoakEvidenceVerdict.ReadyForIndependentReview,rows.Count,
            new[]{"Durations and metrics look consistent; requires independent source verification and sign-off"});
    }
}

public sealed class SoakEvidenceTests
{
    private static SoakRun Fixture(int minutes=60,bool synthetic=true)
    {
        var start=new DateTimeOffset(2026,11,13,0,0,0,TimeSpan.Zero);
        var samples=Enumerable.Range(0,minutes+1).Select(i=>
            new SoakMinuteSample(start.AddMinutes(i),
                i*2_000_000L,i*2_000_000L,0,0,800,20,15,0,0)).ToArray();
        return new("postgresql","isolated-staging",start,start.AddMinutes(minutes),
            1_000_000,synthetic,new string('a',64),samples);
    }

    [Fact]
    public void TwelveSecondSyntheticSmokeCannotBeCalledOneHourOrFourHours()
    {
        var run=Fixture(1);
        Assert.Equal(SoakEvidenceVerdict.NoRealRunEvidence,
            SoakEvidenceGate.Inspect(run,TimeSpan.FromHours(1)).Verdict);
        Assert.Equal(SoakEvidenceVerdict.NoRealRunEvidence,
            SoakEvidenceGate.Inspect(run,TimeSpan.FromHours(4)).Verdict);
    }

    [Fact]
    public void FourHourSyntheticSeriesDoesNotProveRealStability()
    {
        Assert.Equal(SoakEvidenceVerdict.NoRealRunEvidence,
            SoakEvidenceGate.Inspect(Fixture(240),TimeSpan.FromHours(4)).Verdict);
    }

    [Fact]
    public void RealEvidenceOnlyAdvancesToIndependentReviewNotProductionApproved()
    {
        var result=SoakEvidenceGate.Inspect(
            Fixture(60,false),TimeSpan.FromHours(1));
        Assert.Equal(SoakEvidenceVerdict.ReadyForIndependentReview,result.Verdict);
        Assert.False(result.IsProductionApproved);
    }

    [Fact]
    public void IntermediateProviderErrorOrUndrainedSpoolStillRequiresInvestigation()
    {
        var run=Fixture(60,false);
        var items=run.MinuteSamples.ToArray();
        items[25]=items[25] with {ProviderErrors=1};
        Assert.Equal(SoakEvidenceVerdict.UnsafeMeasurements,
            SoakEvidenceGate.Inspect(run with {MinuteSamples=items},TimeSpan.FromHours(1)).Verdict);
        items=run.MinuteSamples.ToArray();
        items[^1]=items[^1] with {SpoolPendingRows=2};
        Assert.Equal(SoakEvidenceVerdict.UnsafeMeasurements,
            SoakEvidenceGate.Inspect(run with {MinuteSamples=items},TimeSpan.FromHours(1)).Verdict);
    }
    [Fact]
    public void MissingSourceTimestampOrDroppedRowsFailClosed()
    {
        var run=Fixture(60,false);
        var rows=run.MinuteSamples.ToArray();
        rows[^1]=rows[^1] with {DroppedRowsTotal=2};
        Assert.Equal(SoakEvidenceVerdict.UnsafeMeasurements,
            SoakEvidenceGate.Inspect(run with {MinuteSamples=rows},TimeSpan.FromHours(1)).Verdict);
        rows=run.MinuteSamples.ToArray();
        rows[30]=rows[30] with {AtUtc=rows[29].AtUtc};
        Assert.Equal(SoakEvidenceVerdict.UnsafeMeasurements,
            SoakEvidenceGate.Inspect(run with {MinuteSamples=rows},TimeSpan.FromHours(1)).Verdict);
    }
}

