using System.Diagnostics;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Soak;

public sealed record Batch3ProcessCounterSample(
    DateTimeOffset CapturedAtUtc, int ProcessId,
    DateTimeOffset ProcessStartUtc, long AllocatedBytes,
    long HeapBytes, long WorkingSetBytes,
    int Gen0, int Gen1, int Gen2,
    TimeSpan CpuTotal, double GcPausePercent,
    int ThreadPoolPendingWorkItems);

public sealed record Batch3ProcessCounterDifference(
    bool SameContinuousProcess, double DurationSeconds,
    double CpuPercentOfHostCapacity, long AllocatedBytesDelta,
    bool FourHourSoakVerified = false, bool OneHourSoakVerified = false);

/// <summary>
/// Captures *actual current process* .NET counters, but two snapshots never
/// constitute a 1h/4h soak run. This code never generates telemetry load.
/// </summary>
public static class Batch3ProcessCounterCapture
{
    public static Batch3ProcessCounterSample Capture()
    {
        using var process=Process.GetCurrentProcess();
        process.Refresh();
        var info=GC.GetGCMemoryInfo();
        return new(
            DateTimeOffset.UtcNow,
            process.Id,process.StartTime.ToUniversalTime(),
            GC.GetTotalAllocatedBytes(precise:false),
            info.HeapSizeBytes,
            process.WorkingSet64,
            GC.CollectionCount(0),GC.CollectionCount(1),
            GC.CollectionCount(2),
            process.TotalProcessorTime,
            info.PauseTimePercentage,
            (int)Math.Min(int.MaxValue,ThreadPool.PendingWorkItemCount));
    }

    public static Batch3ProcessCounterDifference Compare(
        Batch3ProcessCounterSample before,Batch3ProcessCounterSample after)
    {
        if(before.ProcessId<1 || before.ProcessId!=after.ProcessId ||
           before.ProcessStartUtc.Offset!=TimeSpan.Zero ||
           before.ProcessStartUtc!=after.ProcessStartUtc ||
           before.CapturedAtUtc.Offset!=TimeSpan.Zero ||
           after.CapturedAtUtc.Offset!=TimeSpan.Zero ||
           after.CapturedAtUtc<=before.CapturedAtUtc ||
           after.AllocatedBytes<before.AllocatedBytes ||
           after.Gen0<before.Gen0 || after.Gen1<before.Gen1 ||
           after.Gen2<before.Gen2 ||
           after.CpuTotal<before.CpuTotal ||
           !double.IsFinite(before.GcPausePercent) ||
           !double.IsFinite(after.GcPausePercent) ||
           after.GcPausePercent is <0 or >100)
            throw new InvalidOperationException(
                "Counters are not a continuous, trustworthy UTC process snapshot.");

        var seconds=(after.CapturedAtUtc-before.CapturedAtUtc).TotalSeconds;
        var cpu=100.0*(after.CpuTotal-before.CpuTotal).TotalSeconds/
                (seconds*Math.Max(1,Environment.ProcessorCount));
        if(!double.IsFinite(cpu)||cpu<0)
            throw new InvalidOperationException("CPU time delta is invalid.");
        return new(true,seconds,cpu,
            after.AllocatedBytes-before.AllocatedBytes);
    }

    public static NextSoakGcSnapshot AsSoakSnapshot(Batch3ProcessCounterSample value)
        => new(value.CapturedAtUtc,value.AllocatedBytes,value.HeapBytes,
            value.WorkingSetBytes,value.Gen0,value.Gen1,value.Gen2,
            value.GcPausePercent,value.ThreadPoolPendingWorkItems);
}

public sealed class Batch3ProcessCounterCaptureTests
{
    [Fact]
    public async Task ReadsTwoActualProcessSnapshotsButNeverClaimsOneHourLongSoak()
    {
        var first=Batch3ProcessCounterCapture.Capture();
        await Task.Delay(40);
        var last=Batch3ProcessCounterCapture.Capture();
        var result=Batch3ProcessCounterCapture.Compare(first,last);
        Assert.True(result.SameContinuousProcess);
        Assert.True(result.DurationSeconds>0);
        Assert.False(result.OneHourSoakVerified);
        Assert.False(result.FourHourSoakVerified);
        Assert.Equal(first.ProcessId,last.ProcessId);
        Assert.Equal(last.CapturedAtUtc,
            Batch3ProcessCounterCapture.AsSoakSnapshot(last).AtUtc);
    }

    [Fact]
    public void CounterResetOrProcessRestartNeverPassesContinuity()
    {
        var baseline=Batch3ProcessCounterCapture.Capture();
        Assert.Throws<InvalidOperationException>(()=>
            Batch3ProcessCounterCapture.Compare(baseline,
                baseline with {ProcessId=baseline.ProcessId+1}));
        Assert.Throws<InvalidOperationException>(()=>
            Batch3ProcessCounterCapture.Compare(baseline,
                baseline with {CapturedAtUtc=baseline.CapturedAtUtc.AddMinutes(1),
                    AllocatedBytes=baseline.AllocatedBytes-1}));
    }

    [Fact]
    public void DuplicateTimestampAndNonUtcSnapshotsAreRejected()
    {
        var baseline=Batch3ProcessCounterCapture.Capture();
        Assert.Throws<InvalidOperationException>(()=>
            Batch3ProcessCounterCapture.Compare(baseline,baseline));
        Assert.Throws<InvalidOperationException>(()=>
            Batch3ProcessCounterCapture.Compare(
                baseline,baseline with {
                    CapturedAtUtc=baseline.CapturedAtUtc.ToOffset(TimeSpan.FromHours(8))
                }));
    }
}

