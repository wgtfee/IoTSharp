using Xunit;

namespace IoTSharp.PdM.Acceptance.Soak;

/// <summary>
/// Real .NET process diagnostics acquisition, with cancellation and
/// all-or-nothing file publication. This is NOT the ingestion load generator.
/// Calling it for 61/241 minute-spaced samples does not by itself certify
/// 1h/4h telemetry throughput or P99 latency.
/// </summary>
public static class Batch5ProcessEvidenceCollector
{
    public static async Task<Batch4ResourceEvidenceVerdict> CollectAsync(
        string outputPath,int samples,TimeSpan interval,
        CancellationToken ct=default)
    {
        if(samples is <2 or >241 || interval<TimeSpan.FromMilliseconds(10) ||
           interval>TimeSpan.FromMinutes(2) ||
           string.IsNullOrWhiteSpace(outputPath) || File.Exists(outputPath))
            throw new ArgumentException("A fresh file, bounded samples and a controlled interval are required.");
        var readings=new List<Batch3ProcessCounterSample>(samples);
        ct.ThrowIfCancellationRequested();
        readings.Add(Batch3ProcessCounterCapture.Capture());
        for(var i=1;i<samples;i++)
        {
            await Task.Delay(interval,ct);
            ct.ThrowIfCancellationRequested();
            readings.Add(Batch3ProcessCounterCapture.Capture());
            Batch3ProcessCounterCapture.Compare(readings[^2],readings[^1]);
        }
        ct.ThrowIfCancellationRequested();
        await Batch4SoakResourceEvidenceLog.WriteNewAsync(outputPath,readings,ct);
        return await Batch4SoakResourceEvidenceLog.VerifyAsync(outputPath,ct);
    }
}

public sealed class Batch5ProcessEvidenceCollectorTests
{
    private static string Temporary()=>Path.Combine(Path.GetTempPath(),
        "pdm-process-real-"+Guid.NewGuid().ToString("N")+".ndjson");

    [Fact]
    public async Task TwoRealProcessSnapshotsAreCapturedPersistedAndChecked()
    {
        var path=Temporary();
        try
        {
            var evidence=await Batch5ProcessEvidenceCollector.CollectAsync(
                path,2,TimeSpan.FromMilliseconds(40));
            Assert.True(evidence.IntegrityVerified);
            Assert.Equal(2,evidence.CapturedSamples);
            Assert.True(evidence.ObservedSeconds>0);
            Assert.False(evidence.OneHourSoakApproved);
            Assert.False(evidence.FourHourSoakApproved);
            Assert.True(File.Exists(path));
        }
        finally{File.Delete(path);}
    }

    [Fact]
    public async Task CanceledCaptureDoesNotPublishPartialEvidence()
    {
        var path=Temporary();
        try
        {
            using var cts=new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>
                Batch5ProcessEvidenceCollector.CollectAsync(
                    path,5,TimeSpan.FromMilliseconds(80),cts.Token));
            Assert.False(File.Exists(path));
        }
        finally{File.Delete(path);}
    }

    [Fact]
    public async Task ExistingEvidenceIsNotOverwrittenOrMistakenForNewRun()
    {
        var path=Temporary();
        try
        {
            await File.WriteAllTextAsync(path,"previous-valid-record-must-be-preserved");
            await Assert.ThrowsAsync<ArgumentException>(()=>
                Batch5ProcessEvidenceCollector.CollectAsync(
                    path,2,TimeSpan.FromMilliseconds(20)));
            Assert.Equal("previous-valid-record-must-be-preserved",await File.ReadAllTextAsync(path));
        }
        finally{File.Delete(path);}
    }

    [Fact]
    public async Task UnboundedCaptureRequestsAreRejectedBeforeAnyFile()
    {
        var path=Temporary();
        try
        {
            await Assert.ThrowsAsync<ArgumentException>(()=>
                Batch5ProcessEvidenceCollector.CollectAsync(
                    path,250,TimeSpan.FromMinutes(1)));
            Assert.False(File.Exists(path));
        }
        finally{File.Delete(path);}
    }
}

