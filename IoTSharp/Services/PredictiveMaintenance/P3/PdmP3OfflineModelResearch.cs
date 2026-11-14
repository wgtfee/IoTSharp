using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>
/// Human-reviewed feature row. A deviation score is an anomaly *feature* and
/// must never be represented as calibrated failure probability or RUL.
/// </summary>
public sealed record PdmP3OfflineFeatureRow(
    PdmP3SeriesScope Scope, DateTimeOffset EventTimeUtc,
    double RobustDeviationScore, string SourceId);

public sealed record PdmP3OfflineResearchMetrics(
    int TruePositive, int FalsePositive, int FalseNegative, int TrueNegative,
    double? Precision, double? Recall, double? FalsePositiveRate,
    int EvaluatedRows, bool HasRealFieldEvidence = false);

public sealed record PdmP3OfflineResearchResult(
    string State, double Threshold,
    PdmP3OfflineResearchMetrics Holdout,
    string DatasetSha256, string AlgorithmSha256,
    DateTimeOffset HoldoutStartUtc,
    bool IsProductionModel = false, bool IsAlertDelivered = false,
    bool IsWorkOrderCreated = false,
    double? FailureProbability = null, TimeSpan? RemainingUsefulLife = null);

/// <summary>
/// Deterministic, single-feature OFFLINE supervised baseline for exploring
/// an anomaly-threshold policy. Never dispatches anything. No model publishing.
/// A production model would require independent external review and calibration.
/// </summary>
public static class PdmP3OfflineModelResearch
{
    private const string Algorithm = "pdm-threshold-f1-trainonly-v1";
    public static PdmP3OfflineResearchResult FitAndEvaluate(
        IReadOnlyList<PdmP3OfflineFeatureRow> features,
        IReadOnlyList<PdmP3FaultLabel> labels,
        DateTimeOffset holdoutStartUtc, DateTimeOffset asOfUtc,
        bool independentlyReviewedPhysicalEvidence)
    {
        ArgumentNullException.ThrowIfNull(features);
        ArgumentNullException.ThrowIfNull(labels);
        if(features.Count is <1 or >10000 || features.Count!=labels.Count ||
           holdoutStartUtc.Offset!=TimeSpan.Zero ||
           asOfUtc.Offset!=TimeSpan.Zero || holdoutStartUtc>=asOfUtc ||
           !independentlyReviewedPhysicalEvidence)
            throw new InvalidOperationException("Offline study needs bounded rows, a chronological holdout and independent review.");

        var scope=features[0]?.Scope ??
            throw new InvalidOperationException("Missing verified feature scope.");
        var validation=PdmP3DatasetValidator.ValidateLabels(scope,labels,asOfUtc);
        if(!validation.Accepted)
            throw new InvalidOperationException(validation.Reason);
        var readiness=PdmP3SupervisedReadinessGate.Assess(
            scope,labels,holdoutStartUtc,asOfUtc,true);
        if(readiness.State!=PdmP3SupervisedReadinessState.ReadyForOfflineResearchOnly)
            throw new InvalidOperationException("Supervised readiness rejected: "+readiness.Explanation);

        var sorted=features.OrderBy(x=>x.EventTimeUtc).ToArray();
        var matches=labels.ToDictionary(x=>x.EventTimeUtc);
        var casesTraining=new HashSet<string>(StringComparer.Ordinal);
        var casesHoldout=new HashSet<string>(StringComparer.Ordinal);
        DateTimeOffset? prev=null;
        var names=new HashSet<string>(StringComparer.Ordinal);
        foreach(var x in sorted)
        {
            if(x is null || x.Scope!=scope || x.EventTimeUtc.Offset!=TimeSpan.Zero ||
               x.EventTimeUtc==default || x.EventTimeUtc>asOfUtc ||
               !double.IsFinite(x.RobustDeviationScore) ||
               x.RobustDeviationScore<0 || x.RobustDeviationScore>1_000_000 ||
               string.IsNullOrWhiteSpace(x.SourceId) || x.SourceId.Length>160 ||
               (prev.HasValue && x.EventTimeUtc<=prev.Value) ||
               !matches.TryGetValue(x.EventTimeUtc,out var label))
                throw new InvalidOperationException("Features are cross-scope, incomplete, duplicate or not human-labeled.");

            // Labels used for fitting must already be available before the
            // chronological split. Later reviews cannot retroactively train.
            if(x.EventTimeUtc<holdoutStartUtc &&
               label.VerifiedAtUtc>=holdoutStartUtc)
                throw new InvalidOperationException("Training label was reviewed after the split; historical label leakage.");
            if(x.EventTimeUtc>=holdoutStartUtc)
                casesHoldout.Add(label.CaseReference);
            else casesTraining.Add(label.CaseReference);
            // Repeated source provenance can be legitimate per point; the
            // timestamp and CaseReference provide row-level uniqueness.
            names.Add(x.SourceId);
            prev=x.EventTimeUtc;
        }
        if(casesTraining.Overlaps(casesHoldout))
            throw new InvalidOperationException("A fault/normal CaseReference crosses train and holdout splits.");

        var training=sorted.Where(x=>x.EventTimeUtc<holdoutStartUtc).ToArray();
        var holdout=sorted.Where(x=>x.EventTimeUtc>=holdoutStartUtc).ToArray();
        if(training.Length==0 || holdout.Length==0)
            throw new InvalidOperationException("Chronological train and holdout must both contain samples.");

        // Fit threshold on training data ONLY. Deterministic candidate order
        // and tie rule favor a larger threshold (fewer false positives).
        var scores=training.Select(x=>x.RobustDeviationScore)
            .Distinct().OrderBy(x=>x).ToArray();
        var candidates=new List<double> {0};
        for(var i=0;i<scores.Length;i++)
        {
            candidates.Add(scores[i]);
            if(i+1<scores.Length)
                candidates.Add(scores[i]+(scores[i+1]-scores[i])/2);
        }
        candidates.Add(scores[^1]+1);
        var best=candidates[0];
        var bestF1=-1.0;
        foreach(var candidate in candidates.Distinct().OrderBy(x=>x))
        {
            var (tp,fp,fn,_) = Confusion(training,matches,candidate);
            var denominator=2.0*tp+fp+fn;
            var f1=denominator>0 ? 2.0*tp/denominator : 0;
            if(f1>bestF1+1e-12 || (Math.Abs(f1-bestF1)<1e-12 && candidate>best))
            {
                bestF1=f1;
                best=candidate;
            }
        }
        var (t,f,n,tn)=Confusion(holdout,matches,best);
        var metrics=new PdmP3OfflineResearchMetrics(
            t,f,n,tn,t+f>0?(double)t/(t+f):null,
            t+n>0?(double)t/(t+n):null,
            f+tn>0?(double)f/(f+tn):null,holdout.Length);
        var canonical=new StringBuilder(Algorithm).Append('\n')
            .Append(scope.TenantId.ToString("N")).Append('|')
            .Append(scope.CustomerId.ToString("N")).Append('|')
            .Append(scope.DeviceId.ToString("N")).Append('|')
            .Append(scope.ProfileId.ToString("N")).Append('|')
            .Append(scope.ProfileVersion).Append('|')
            .Append(scope.PointKey).Append('|')
            .Append(scope.EngineeringUnit).Append('|')
            .Append(scope.OperatingMode).Append('\n')
            .Append(holdoutStartUtc.ToUnixTimeMilliseconds()).Append('|')
            .Append(asOfUtc.ToUnixTimeMilliseconds()).Append('\n');
        foreach(var x in sorted)
        {
            var label=matches[x.EventTimeUtc];
            canonical.Append(x.EventTimeUtc.ToUnixTimeMilliseconds()).Append('|')
                .Append(x.RobustDeviationScore.ToString("R",CultureInfo.InvariantCulture))
                .Append('|').Append(x.SourceId).Append('|').Append((int)label.Truth)
                .Append('|').Append(label.CaseReference).Append('|')
                .Append(label.VerifiedBy).Append('|')
                .Append(label.VerifiedAtUtc.ToUnixTimeMilliseconds()).Append('\n');
        }
        static string Hash(string content) => Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
        return new("OfflineResearchOnly",best,metrics,Hash(canonical.ToString()),
            Hash(Algorithm),holdoutStartUtc);
    }

    private static (int tp,int fp,int fn,int tn) Confusion(
        IEnumerable<PdmP3OfflineFeatureRow> rows,
        IReadOnlyDictionary<DateTimeOffset,PdmP3FaultLabel> labels,double threshold)
    {
        var tp=0;var fp=0;var fn=0;var tn=0;
        foreach(var x in rows)
        {
            var isFault=labels[x.EventTimeUtc].Truth==PdmP3FaultTruth.ConfirmedFault;
            var predicted=x.RobustDeviationScore>=threshold;
            if(isFault){if(predicted)tp++;else fn++;}
            else {if(predicted)fp++;else tn++;}
        }
        return(tp,fp,fn,tn);
    }
}

