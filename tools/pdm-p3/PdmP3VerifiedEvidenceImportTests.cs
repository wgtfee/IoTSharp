using System.Text.Json;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3VerifiedEvidenceImportTests
{
    private static readonly DateTimeOffset Start =
        new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Split = Start.AddDays(20);
    private static readonly DateTimeOffset AsOf = Start.AddDays(60);

    private static PdmP3ReviewedFeatureBundle Bundle()
    {
        var scope=PdmP3Fixtures.Scope();
        var rows=new List<PdmP3ReviewedFeatureRow>();
        void Add(DateTimeOffset eventUtc, double score, PdmP3FaultTruth truth, string caseId)
            => rows.Add(new(eventUtc,score,"synthetic-fixture-source",
                truth,eventUtc.AddHours(1),caseId,"reviewer-for-test-only"));
        for(var i=0;i<5;i++)
        {
            Add(Start.AddDays(i*2),8+i,PdmP3FaultTruth.ConfirmedFault,"training-fault-"+i);
            Add(Split.AddDays(1+i*2),9+i,PdmP3FaultTruth.ConfirmedFault,"holdout-fault-"+i);
        }
        for(var i=0;i<15;i++)
        {
            Add(Start.AddDays(12).AddHours(i),1+i/100.0,
                PdmP3FaultTruth.ConfirmedNormal,"training-normal-"+i);
            Add(Split.AddDays(12).AddHours(i),1+i/100.0,
                PdmP3FaultTruth.ConfirmedNormal,"holdout-normal-"+i);
        }
        return new("pdm-p3-reviewed-features-v1","IsolatedSyntheticFixture",
            scope,Split,AsOf,rows);
    }

    private static async Task<T> UsingFile<T>(
        PdmP3ReviewedFeatureBundle bundle,Func<string,Task<T>> action)
    {
        var path=Path.Combine(Path.GetTempPath(),
            "pdm-p3-evidence-"+Guid.NewGuid().ToString("N")+".json");
        try
        {
            await File.WriteAllTextAsync(path,JsonSerializer.Serialize(bundle));
            return await action(path);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task RealFileImporterTrainsOfflineWithoutPublishingAndWithStableHashes()
    {
        var b=Bundle();
        var first=await UsingFile(b,path=>
            PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
        var second=await UsingFile(b,path=>
            PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
        Assert.Equal(first,second);
        Assert.Equal(40,first.ImportedRows);
        Assert.Equal("OfflineResearchOnly",first.Research.State);
        Assert.Equal(64,first.FileSha256.Length);
        Assert.Equal(5,first.Research.Holdout.TruePositive);
        Assert.Equal(15,first.Research.Holdout.TrueNegative);
        Assert.False(first.IsActualFieldEvidenceIndependentlyAuthenticated);
        Assert.False(first.CanPublishModel);
        Assert.False(first.Research.IsWorkOrderCreated);
    }

    [Fact]
    public async Task CallerMustSupplyIndependentEvidenceApproval()
    {
        await UsingFile(Bundle(),async path =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,false));
            return 0;
        });
    }

    [Fact]
    public async Task NoFutureTrainingReviewOrCrossTrainCaseLeakageIsAllowed()
    {
        var b=Bundle();
        var changed=b.Rows.ToArray();
        changed[0]=changed[0] with {VerifiedAtUtc=Split.AddDays(1)};
        await UsingFile(b with {Rows=changed},async path =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
            return 0;
        });
        changed=b.Rows.ToArray();
        changed[1]=changed[1] with {CaseReference=changed[0].CaseReference};
        await UsingFile(b with {Rows=changed},async path =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
            return 0;
        });
    }

    [Fact]
    public async Task InvalidManifestAndUnknownFieldsDoNotEnterTraining()
    {
        var b=Bundle();
        await UsingFile(b with {SchemaVersion="unknown-format"},async path =>
        {
            await Assert.ThrowsAsync<InvalidDataException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
            return 0;
        });
        var content=JsonSerializer.Serialize(b);
        var altered=content.Replace("\"SchemaVersion\":",
            "\"UnreviewedProductionEnabled\":true,\"SchemaVersion\":",
            StringComparison.Ordinal);
        var path=Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")+".json");
        try
        {
            await File.WriteAllTextAsync(path,altered);
            await Assert.ThrowsAsync<InvalidDataException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
        }
        finally {File.Delete(path);}
    }

    [Fact]
    public async Task OversizedFileIsRejectedBeforeParsing()
    {
        var path=Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")+".json");
        try
        {
            await using(var f=File.Create(path))f.SetLength(4*1024*1024+1);
            await Assert.ThrowsAsync<InvalidDataException>(()=>
                PdmP3VerifiedEvidenceImport.ImportAndEvaluateAsync(path,true));
        }
        finally {File.Delete(path);}
    }
}

