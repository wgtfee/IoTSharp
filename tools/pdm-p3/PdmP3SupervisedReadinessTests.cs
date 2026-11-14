using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3SupervisedReadinessTests
{
    private static readonly DateTimeOffset Start=
        new(2026,10,1,0,0,0,TimeSpan.Zero);
    private static readonly DateTimeOffset Cutoff=Start.AddDays(20);
    private static readonly DateTimeOffset AsOf=Start.AddDays(60);

    private static List<PdmP3FaultLabel> GoodLabels(PdmP3SeriesScope scope)
    {
        var output=new List<PdmP3FaultLabel>();
        for(var i=0;i<5;i++)
        {
            var t=Start.AddDays(i*2);
            output.Add(new(scope,t,t.AddHours(2),
                PdmP3FaultTruth.ConfirmedFault,"train-fault-"+i,"reviewer-1"));
            var hold=Cutoff.AddDays(1+i*2);
            output.Add(new(scope,hold,hold.AddHours(2),
                PdmP3FaultTruth.ConfirmedFault,"holdout-fault-"+i,"reviewer-2"));
        }
        for(var i=0;i<15;i++)
        {
            var t=Start.AddDays(12).AddHours(i);
            output.Add(new(scope,t,t.AddHours(2),
                PdmP3FaultTruth.ConfirmedNormal,"train-normal-"+i,"reviewer-1"));
            var hold=Cutoff.AddDays(12).AddHours(i);
            output.Add(new(scope,hold,hold.AddHours(2),
                PdmP3FaultTruth.ConfirmedNormal,"holdout-normal-"+i,"reviewer-2"));
        }
        return output;
    }

    [Fact]
    public void SufficientVerifiedIndependentEventsOnlyAllowOfflineResearch()
    {
        var scope=PdmP3Fixtures.Scope();
        var result=PdmP3SupervisedReadinessGate.Assess(
            scope,GoodLabels(scope),Cutoff,AsOf,true);
        Assert.Equal(PdmP3SupervisedReadinessState.ReadyForOfflineResearchOnly,result.State);
        Assert.Equal(5,result.TrainFaultEpisodes);
        Assert.Equal(5,result.HoldoutFaultEpisodes);
        Assert.Equal(15,result.TrainConfirmedNormal);
        Assert.Equal(15,result.HoldoutConfirmedNormal);
        Assert.False(result.CanActivateProductionModel);
        Assert.Null(result.FailureProbability);
        Assert.Null(result.RemainingUsefulLife);
    }

    [Fact]
    public void MissingIndependentPhysicalEvidenceReviewAlwaysBlocks()
    {
        var scope=PdmP3Fixtures.Scope();
        var result=PdmP3SupervisedReadinessGate.Assess(
            scope,GoodLabels(scope),Cutoff,AsOf,false);
        Assert.Equal(PdmP3SupervisedReadinessState.Blocked,result.State);
        Assert.False(result.CanActivateProductionModel);
    }

    [Fact]
    public void UnlabeledDatasetIsNotReadyForSupervisedExperiment()
    {
        var scope=PdmP3Fixtures.Scope();
        var result=PdmP3SupervisedReadinessGate.Assess(
            scope,Array.Empty<PdmP3FaultLabel>(),Cutoff,AsOf,true);
        Assert.Equal(PdmP3SupervisedReadinessState.InsufficientVerifiedLabels,result.State);
        Assert.Equal(0,result.TrainFaultEpisodes);
        Assert.Equal(0,result.HoldoutConfirmedNormal);
    }

    [Fact]
    public void FutureVerificationOrCrossTenantLabelsDoNotPass()
    {
        var scope=PdmP3Fixtures.Scope();
        var labels=GoodLabels(scope);
        labels[0]=labels[0] with { VerifiedAtUtc=AsOf.AddDays(1) };
        Assert.Equal(PdmP3SupervisedReadinessState.Blocked,
            PdmP3SupervisedReadinessGate.Assess(scope,labels,Cutoff,AsOf,true).State);
        labels=GoodLabels(scope);
        labels[2]=labels[2] with {
            Scope=scope with {TenantId=Guid.NewGuid()}
        };
        Assert.Equal(PdmP3SupervisedReadinessState.Blocked,
            PdmP3SupervisedReadinessGate.Assess(scope,labels,Cutoff,AsOf,true).State);
    }

    [Fact]
    public void DuplicatedFailureEpisodeAcrossTemporalSplitIsDataLeakage()
    {
        var scope=PdmP3Fixtures.Scope();
        var labels=GoodLabels(scope);
        var first=labels.First(x=>x.CaseReference.StartsWith("train-fault-"));
        var index=labels.FindIndex(x=>x.CaseReference=="holdout-fault-0");
        labels[index]=labels[index] with {CaseReference=first.CaseReference};
        var result=PdmP3SupervisedReadinessGate.Assess(
            scope,labels,Cutoff,AsOf,true);
        Assert.Equal(PdmP3SupervisedReadinessState.Blocked,result.State);
        Assert.Contains("跨",result.Explanation);
    }

    [Fact]
    public void ManyFaultPointsInSameHourDoNotCountAsIndependentFailures()
    {
        var scope=PdmP3Fixtures.Scope();
        var labels=GoodLabels(scope);
        labels.RemoveAll(x=>x.Truth==PdmP3FaultTruth.ConfirmedFault);
        for(var i=0;i<12;i++)
        {
            var time=Start.AddHours(i);
            labels.Add(new(scope,time,time.AddMinutes(3),
                PdmP3FaultTruth.ConfirmedFault,"train-tight-"+i,"reviewer-1"));
            var hold=Cutoff.AddHours(2+i);
            labels.Add(new(scope,hold,hold.AddMinutes(3),
                PdmP3FaultTruth.ConfirmedFault,"holdout-tight-"+i,"reviewer-2"));
        }
        var result=PdmP3SupervisedReadinessGate.Assess(
            scope,labels,Cutoff,AsOf,true);
        Assert.Equal(PdmP3SupervisedReadinessState.InsufficientVerifiedLabels,result.State);
        Assert.Equal(1,result.TrainFaultEpisodes);
        Assert.Equal(1,result.HoldoutFaultEpisodes);
    }
}

