using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Soak;

public sealed record Batch4ResourceEvidenceRow(
    int Index,Batch3ProcessCounterSample Sample,string PreviousSha256,string Sha256);

public sealed record Batch4ResourceEvidenceVerdict(
    bool IntegrityVerified,int CapturedSamples,double ObservedSeconds,
    bool OneHourSoakApproved=false,bool FourHourSoakApproved=false);

/// <summary>
/// Offline tamper-evident resource log from actual process snapshots. A log is
/// not a throughput benchmark. Never infers 1h or 4h acceptance from these
/// snapshots alone, even if the log spans the expected duration.
/// </summary>
public static class Batch4SoakResourceEvidenceLog
{
    private static readonly JsonSerializerOptions Json=new() {
        PropertyNamingPolicy=JsonNamingPolicy.CamelCase
    };
    private static string Digest(int index,
        Batch3ProcessCounterSample sample,string previousSha)
    {
        var canonical=JsonSerializer.Serialize(new {
            index,sample,previousSha
        },Json);
        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static async Task WriteNewAsync(
        string path,IReadOnlyList<Batch3ProcessCounterSample> samples,
        CancellationToken ct=default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if(samples is null || samples.Count is <2 or >500)
            throw new ArgumentException("Only bounded continuous real process samples accepted.");
        for(var i=1;i<samples.Count;i++)
            Batch3ProcessCounterCapture.Compare(samples[i-1],samples[i]);
        await using var file=new FileStream(path,FileMode.CreateNew,
            FileAccess.Write,FileShare.None,4096,FileOptions.Asynchronous);
        await using var writer=new StreamWriter(file,new UTF8Encoding(false));
        var previous=new string('0',64);
        for(var i=0;i<samples.Count;i++)
        {
            ct.ThrowIfCancellationRequested();
            var hash=Digest(i,samples[i],previous);
            await writer.WriteLineAsync(JsonSerializer.Serialize(
                new Batch4ResourceEvidenceRow(i,samples[i],previous,hash),Json));
            previous=hash;
        }
        await writer.FlushAsync(ct);
        await file.FlushAsync(ct);
    }

    public static async Task<Batch4ResourceEvidenceVerdict> VerifyAsync(
        string path,CancellationToken ct=default)
    {
        var file=new FileInfo(path);
        if(!file.Exists || file.Length is <128 or >4*1024*1024)
            throw new InvalidDataException("Missing, oversized or empty resource evidence.");
        string[] lines=await File.ReadAllLinesAsync(path,ct);
        if(lines.Length is <2 or >500)
            throw new InvalidDataException("Resource evidence has invalid sample count.");
        var prior=new string('0',64);
        Batch3ProcessCounterSample? first=null;
        Batch3ProcessCounterSample? previous=null;
        for(var i=0;i<lines.Length;i++)
        {
            ct.ThrowIfCancellationRequested();
            Batch4ResourceEvidenceRow item;
            try
            {
                item=JsonSerializer.Deserialize<Batch4ResourceEvidenceRow>(lines[i],Json)
                    ?? throw new InvalidDataException("Null evidence item");
            }
            catch(JsonException ex)
            {
                throw new InvalidDataException("Malformed resource log",ex);
            }
            if(item.Index!=i || item.Sample is null ||
               item.PreviousSha256!=prior ||
               item.Sha256!=Digest(i,item.Sample,prior))
                throw new InvalidDataException("Evidence chain altered, missing or reordered.");
            if(previous is not null)
                Batch3ProcessCounterCapture.Compare(previous,item.Sample);
            first??=item.Sample;
            previous=item.Sample;
            prior=item.Sha256;
        }
        return new(true,lines.Length,
            (previous!.CapturedAtUtc-first!.CapturedAtUtc).TotalSeconds);
    }
}

public sealed class Batch4SoakResourceEvidenceLogTests
{
    private static string Temporary() => Path.Combine(Path.GetTempPath(),
        "pdm-batch4-resource-"+Guid.NewGuid().ToString("N")+".ndjson");

    [Fact]
    public async Task TwoRealProcessSnapshotsArePersistedWithVerifiedHashChain()
    {
        var first=Batch3ProcessCounterCapture.Capture();
        await Task.Delay(25);
        var last=Batch3ProcessCounterCapture.Capture();
        var path=Temporary();
        try
        {
            await Batch4SoakResourceEvidenceLog.WriteNewAsync(path,new[]{first,last});
            var result=await Batch4SoakResourceEvidenceLog.VerifyAsync(path);
            Assert.True(result.IntegrityVerified);
            Assert.Equal(2,result.CapturedSamples);
            Assert.True(result.ObservedSeconds>0);
            Assert.False(result.OneHourSoakApproved);
            Assert.False(result.FourHourSoakApproved);
        }
        finally {File.Delete(path);}
    }

    [Fact]
    public async Task SingleByteResourceLogTamperIsRejected()
    {
        var first=Batch3ProcessCounterCapture.Capture();
        await Task.Delay(20);
        var last=Batch3ProcessCounterCapture.Capture();
        var path=Temporary();
        try
        {
            await Batch4SoakResourceEvidenceLog.WriteNewAsync(path,new[]{first,last});
            var text=await File.ReadAllTextAsync(path);
            text=text.Replace("\"index\":1","\"index\":3",StringComparison.Ordinal);
            await File.WriteAllTextAsync(path,text);
            await Assert.ThrowsAsync<InvalidDataException>(()=>
                Batch4SoakResourceEvidenceLog.VerifyAsync(path));
        }
        finally {File.Delete(path);}
    }

    [Fact]
    public async Task ProcessRestartOrCounterRollbackCannotProduceContinuousEvidence()
    {
        var first=Batch3ProcessCounterCapture.Capture();
        var after=first with {
            ProcessId=first.ProcessId+1,
            CapturedAtUtc=first.CapturedAtUtc.AddSeconds(2)
        };
        var path=Temporary();
        await Assert.ThrowsAsync<InvalidOperationException>(()=>
            Batch4SoakResourceEvidenceLog.WriteNewAsync(path,new[]{first,after}));
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task ExistingEvidenceIsNotSilentlyOverwritten()
    {
        var first=Batch3ProcessCounterCapture.Capture();
        await Task.Delay(15);
        var second=Batch3ProcessCounterCapture.Capture();
        var path=Temporary();
        try
        {
            await Batch4SoakResourceEvidenceLog.WriteNewAsync(path,new[]{first,second});
            await Assert.ThrowsAnyAsync<IOException>(()=>
                Batch4SoakResourceEvidenceLog.WriteNewAsync(path,new[]{first,second}));
        }
        finally{File.Delete(path);}
    }
}

