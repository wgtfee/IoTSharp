using System;
using System.Collections.Generic;
using System.Linq;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public enum PdmP3SupervisedReadinessState
{
    Blocked, InsufficientVerifiedLabels, ReadyForOfflineResearchOnly
}

/// <summary>
/// Readiness for a future supervised OFFLINE experiment only. Never grants
/// trained model publication, calibrated fault probabilities or RUL inference.
/// </summary>
public sealed record PdmP3SupervisedReadiness(
    PdmP3SupervisedReadinessState State,
    int TrainFaultEpisodes, int HoldoutFaultEpisodes,
    int TrainConfirmedNormal, int HoldoutConfirmedNormal,
    string Explanation,
    bool CanActivateProductionModel = false,
    double? FailureProbability = null,
    TimeSpan? RemainingUsefulLife = null);

/// <summary>
/// Conservative chronological and independent-case data sufficiency gate.
/// Fault points in the same 24h episode never count as independent failures.
/// The verified provenance switch can only come from a separately authorized
/// backend reviewer, never from the browser.
/// </summary>
public static class PdmP3SupervisedReadinessGate
{
    public static PdmP3SupervisedReadiness Assess(
        PdmP3SeriesScope scope,
        IReadOnlyList<PdmP3FaultLabel> labels,
        DateTimeOffset trainHoldoutCutoffUtc,
        DateTimeOffset asOfUtc,
        bool reviewerApprovedPhysicalEvidence,
        int minimumFaultEpisodesPerSplit = 5,
        int minimumNormalSamplesPerSplit = 15,
        TimeSpan? independentEpisodeGap = null)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(labels);
        PdmP3SupervisedReadiness Block(string reason) =>
            new(PdmP3SupervisedReadinessState.Blocked,0,0,0,0,reason);
        if(trainHoldoutCutoffUtc.Offset!=TimeSpan.Zero ||
            asOfUtc.Offset!=TimeSpan.Zero ||
            trainHoldoutCutoffUtc==default ||
            asOfUtc<=trainHoldoutCutoffUtc ||
            minimumFaultEpisodesPerSplit is < 1 or > 10000 ||
            minimumNormalSamplesPerSplit is < 1 or > 100000)
            return Block("UTC 切分、as-of 或最低样本阈值不合法");
        var gap=independentEpisodeGap??TimeSpan.FromHours(24);
        if(gap<TimeSpan.FromHours(1) || gap>TimeSpan.FromDays(365))
            return Block("必须声明合理的独立故障事件间隔");
        var validation=PdmP3DatasetValidator.ValidateLabels(scope,labels,asOfUtc);
        if(!validation.Accepted)
            return Block("故障标签未核验或包含未来信息："+validation.Reason);
        if(!reviewerApprovedPhysicalEvidence)
            return Block("尚未由独立审核人员确认现场故障证据包");

        var train=labels.Where(l=>l.EventTimeUtc<trainHoldoutCutoffUtc)
            .OrderBy(l=>l.EventTimeUtc).ToArray();
        var holdout=labels.Where(l=>l.EventTimeUtc>=trainHoldoutCutoffUtc)
            .OrderBy(l=>l.EventTimeUtc).ToArray();
        // Cases spanning the temporal split leak correlated failure evidence.
        var trainingCases=train.Where(x=>x.Truth==PdmP3FaultTruth.ConfirmedFault)
            .Select(x=>x.CaseReference).ToHashSet(StringComparer.Ordinal);
        if(holdout.Any(x=>x.Truth==PdmP3FaultTruth.ConfirmedFault &&
                         trainingCases.Contains(x.CaseReference)))
            return Block("同一故障 Case 跨训练/留出集，存在数据泄漏");

        static int IndependentFaultCount(
            IReadOnlyList<PdmP3FaultLabel> ordered, TimeSpan separation)
        {
            var uniqueCases=new HashSet<string>(StringComparer.Ordinal);
            DateTimeOffset? previousEpisode=null;
            var episodes=0;
            foreach(var label in ordered)
            {
                if(label.Truth!=PdmP3FaultTruth.ConfirmedFault ||
                   !uniqueCases.Add(label.CaseReference))
                    continue;
                if(previousEpisode.HasValue &&
                   label.EventTimeUtc-previousEpisode.Value<separation)
                {
                    // Advance with every observed fault: contiguous reports form one episode.
                    previousEpisode=label.EventTimeUtc;
                    continue;
                }
                previousEpisode=label.EventTimeUtc;
                episodes++;
            }
            return episodes;
        }

        var trainFaults=IndependentFaultCount(train,gap);
        var holdoutFaults=IndependentFaultCount(holdout,gap);
        var trainNormal=train.Count(x=>x.Truth==PdmP3FaultTruth.ConfirmedNormal);
        var holdoutNormal=holdout.Count(x=>x.Truth==PdmP3FaultTruth.ConfirmedNormal);
        var sufficient=trainFaults>=minimumFaultEpisodesPerSplit &&
            holdoutFaults>=minimumFaultEpisodesPerSplit &&
            trainNormal>=minimumNormalSamplesPerSplit &&
            holdoutNormal>=minimumNormalSamplesPerSplit;
        return new(
            sufficient?PdmP3SupervisedReadinessState.ReadyForOfflineResearchOnly:
                PdmP3SupervisedReadinessState.InsufficientVerifiedLabels,
            trainFaults,holdoutFaults,trainNormal,holdoutNormal,
            sufficient?
                "仅达到离线监督实验的保守数据准备条件，仍须验证泛化、校准、错误成本和现场安全":
                "独立故障事件或人工确认正常样本不足，不能训练并宣布可用的预测模型");
    }
}

