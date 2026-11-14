using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3OfflineModelResearchTests
{
    private static readonly DateTimeOffset Start =
        new(2026,10,1,0,0,0,TimeSpan.Zero);
    private static readonly DateTimeOffset Cutoff=Start.AddDays(20);
    private static readonly DateTimeOffset AsOf=Start.AddDays(60);

    private static (PdmP3SeriesScope Scope,List<PdmP3OfflineFeatureRow> Features,List<PdmP3FaultLabel> Labels) Data()
    {
        var scope=PdmP3Fixtures.Scope();
        var features=new List<PdmP3OfflineFeatureRow>();
        var labels=new List<PdmP3FaultLabel>();
        void Add(DateTimeOffset at,double score,PdmP3FaultTruth truth,string caseId)
        {
            features.Add(new(scope,at,score,"offline-synthetic-fixture"));
            labels.Add(new(scope,at,at.AddHours(1),truth,caseId,"independent-reviewer-fixture"));
        }
        for(var i=0;i<5;i++)
        {
            Add(Start.AddDays(i*2),8+i, PdmP3FaultTruth.ConfirmedFault,"training-fault-"+i);
            Add(Cutoff.AddDays(1+i*2),8+i, PdmP3FaultTruth.ConfirmedFault,"holdout-fault-"+i);
        }
        for(var i=0;i<15;i++)
        {
            Add(Start.AddDays(12).AddHours(i),1+i/100.0,
                PdmP3FaultTruth.ConfirmedNormal,"training-normal-"+i);
            Add(Cutoff.AddDays(12).AddHours(i),1+i/100.0,
                PdmP3FaultTruth.ConfirmedNormal,"holdout-normal-"+i);
        }
        return(scope,features,labels);
    }

    [Fact]
    public void DeterministicOfflineThresholdResearchFitsTrainingOnlyAndScoresHoldout()
    {
        var data=Data();
        var a=PdmP3OfflineModelResearch.FitAndEvaluate(
            data.Features,data.Labels,Cutoff,AsOf,true);
        var b=PdmP3OfflineModelResearch.FitAndEvaluate(
            data.Features.AsEnumerable().Reverse().ToArray(),data.Labels,Cutoff,AsOf,true);
        Assert.Equal(a,b);
        Assert.Equal("OfflineResearchOnly",a.State);
        Assert.Equal(5,a.Holdout.TruePositive);
        Assert.Equal(15,a.Holdout.TrueNegative);
        Assert.Equal(0,a.Holdout.FalseNegative+a.Holdout.FalsePositive);
        Assert.Equal(64,a.DatasetSha256.Length);
        Assert.Equal(64,a.AlgorithmSha256.Length);
    }

    [Fact]
    public void HoldoutFeatureChangesNeverInfluenceFittedThreshold()
    {
        var data=Data();
        var original=PdmP3OfflineModelResearch.FitAndEvaluate(
            data.Features,data.Labels,Cutoff,AsOf,true);
        var perturbed=data.Features.Select(x=>x.EventTimeUtc>=Cutoff
            ? x with {RobustDeviationScore=x.RobustDeviationScore+100} : x).ToArray();
        var changed=PdmP3OfflineModelResearch.FitAndEvaluate(
            perturbed,data.Labels,Cutoff,AsOf,true);
        Assert.Equal(original.Threshold,changed.Threshold);
        Assert.NotEqual(original.DatasetSha256,changed.DatasetSha256);
        Assert.Equal(original.AlgorithmSha256,changed.AlgorithmSha256);
    }

    [Fact]
    public void NoHumanReviewOrInsufficientFaultEventsBlocksResearch()
    {
        var data=Data();
        Assert.Throws<InvalidOperationException>(()=>
            PdmP3OfflineModelResearch.FitAndEvaluate(data.Features,data.Labels,Cutoff,AsOf,false));
        Assert.Throws<InvalidOperationException>(()=>
            PdmP3OfflineModelResearch.FitAndEvaluate(data.Features.Take(12).ToArray(),
                data.Labels.Take(12).ToArray(),Cutoff,AsOf,true));
    }

    [Fact]
    public void LaterVerifiedTrainingLabelsCannotLeakBackwardIntoTraining()
    {
        var data=Data();
        var labels=data.Labels.ToArray();
        labels[0]=labels[0] with {VerifiedAtUtc=Cutoff.AddDays(1)};
        Assert.Throws<InvalidOperationException>(()=>
            PdmP3OfflineModelResearch.FitAndEvaluate(data.Features,labels,Cutoff,AsOf,true));
    }

    [Fact]
    public void CrossTenantFeaturesAndOverlappingCaseReferencesCannotPass()
    {
        var data=Data();
        var feature=data.Features.ToArray();
        feature[0]=feature[0] with {
            Scope=feature[0].Scope with {CustomerId=Guid.NewGuid()}
        };
        Assert.Throws<InvalidOperationException>(()=>
            PdmP3OfflineModelResearch.FitAndEvaluate(feature,data.Labels,Cutoff,AsOf,true));
        var labels=data.Labels.ToArray();
        labels[1]=labels[1] with {CaseReference=labels[0].CaseReference};
        Assert.Throws<InvalidOperationException>(()=>
            PdmP3OfflineModelResearch.FitAndEvaluate(data.Features,labels,Cutoff,AsOf,true));
    }

    [Fact]
    public void ProducesNoFailureProbabilitiesRulDispatchOrPublishRights()
    {
        var data=Data();
        var output=PdmP3OfflineModelResearch.FitAndEvaluate(
            data.Features,data.Labels,Cutoff,AsOf,true);
        Assert.False(output.IsProductionModel);
        Assert.False(output.IsAlertDelivered);
        Assert.False(output.IsWorkOrderCreated);
        Assert.False(output.Holdout.HasRealFieldEvidence);
        Assert.Null(output.FailureProbability);
        Assert.Null(output.RemainingUsefulLife);
        Assert.Equal(64,output.DatasetSha256.Length);
        Assert.Equal(64,output.AlgorithmSha256.Length);
    }
}

