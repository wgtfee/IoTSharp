using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>Ground-truth metrics, never inferred from unlabeled history.</summary>
public sealed record PdmP3ReplayMetrics(
    bool HasTrustedGroundTruth,
    int EvaluatedSamples, int UnlabeledSamples, int AbstainedSamples,
    int TruePositive, int FalsePositive, int FalseNegative, int TrueNegative,
    double? Precision, double? Recall, string ReproducibilitySha256,
    string Explanation, string ProtocolVersion = "pdm-p3-replay-v1")
{
    public double? FailureProbabilityCalibration => null;
}

/// <summary>
/// Offline chronological holdout evaluator. Training data may only be earlier
/// than holdoutStartUtc; only human-confirmed labels available as of asOfUtc
/// count for precision/recall. No implicit negative labels or future leakage.
/// </summary>
public static class PdmP3ReplayEvaluator
{
    public static PdmP3ReplayMetrics Evaluate(
        IReadOnlyList<PdmP3AnomalyFinding> predictions,
        IReadOnlyList<PdmP3FaultLabel> labels,
        DateTimeOffset holdoutStartUtc, DateTimeOffset asOfUtc)
    {
        ArgumentNullException.ThrowIfNull(predictions);
        ArgumentNullException.ThrowIfNull(labels);
        if (holdoutStartUtc.Offset != TimeSpan.Zero ||
            asOfUtc.Offset != TimeSpan.Zero || holdoutStartUtc == default ||
            asOfUtc < holdoutStartUtc)
            throw new ArgumentException("Chronological UTC cutoffs required");
        if (predictions.Count == 0 || predictions.Count > 100_000 ||
            labels.Count > 100_000)
            throw new ArgumentException("Offline replay requires a bounded prediction sequence");

        var scope = predictions[0]?.Scope ??
            throw new ArgumentException("Replay predictions must be scoped");
        var encountered = new HashSet<DateTimeOffset>();
        foreach (var p in predictions)
        {
            if (p is null || p.Scope != scope || p.AtUtc is null ||
                p.AtUtc.Value.Offset != TimeSpan.Zero ||
                p.AtUtc.Value > asOfUtc ||
                !encountered.Add(p.AtUtc.Value))
                throw new ArgumentException("Cross-scope, future, duplicate or untrusted replay prediction");
        }
        var validation = PdmP3DatasetValidator.ValidateLabels(scope, labels, asOfUtc);
        if (!validation.Accepted)
            throw new ArgumentException(validation.Reason);
        var byEventTime = labels.ToDictionary(l => l.EventTimeUtc);
        var selected = predictions.Where(p => p.AtUtc!.Value >= holdoutStartUtc)
            .OrderBy(p => p.AtUtc!.Value).ToArray();
        var tp = 0; var fp = 0; var fn = 0; var tn = 0;
        var unlabeled = 0; var abstained = 0;
        foreach (var prediction in selected)
        {
            if (prediction.State == PdmP3AnomalyState.Unknown)
            {
                abstained++;
                continue;
            }
            if (!byEventTime.TryGetValue(prediction.AtUtc!.Value, out var truth))
            {
                unlabeled++;
                continue;
            }
            var positive = prediction.State == PdmP3AnomalyState.Anomalous;
            if (truth.Truth == PdmP3FaultTruth.ConfirmedFault)
            {
                if (positive) tp++; else fn++;
            }
            else if (positive) fp++; else tn++;
        }
        // Deterministic source-derived identifier: no host clock or random seed.
        var canonical = new StringBuilder("pdm-p3-replay-v1\n")
            .Append(scope.TenantId.ToString("N")).Append('|')
            .Append(scope.CustomerId.ToString("N")).Append('|')
            .Append(scope.DeviceId.ToString("N")).Append('|')
            .Append(scope.ProfileId.ToString("N")).Append('|')
            .Append(scope.ProfileVersion).Append('|')
            .Append(scope.PointKey).Append('|')
            .Append(scope.EngineeringUnit).Append('\n')
            .Append(holdoutStartUtc.ToUnixTimeMilliseconds()).Append('|')
            .Append(asOfUtc.ToUnixTimeMilliseconds()).Append('\n');
        foreach (var item in selected)
            canonical.Append(item.AtUtc!.Value.ToUnixTimeMilliseconds()).Append('|')
                .Append((int)item.State).Append('|')
                .Append(item.RobustDeviationScore?.ToString("R", CultureInfo.InvariantCulture) ?? "-")
                .Append('\n');
        foreach (var l in labels.OrderBy(l => l.EventTimeUtc))
            canonical.Append(l.EventTimeUtc.ToUnixTimeMilliseconds()).Append('|')
                .Append(l.VerifiedAtUtc.ToUnixTimeMilliseconds()).Append('|')
                .Append((int)l.Truth).Append('|').Append(l.CaseReference).Append('|')
                .Append(l.VerifiedBy).Append('\n');
        var fingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())))
            .ToLowerInvariant();
        var precision = tp + fp > 0 ? (double)tp / (tp + fp) : (double?)null;
        var recall = tp + fn > 0 ? (double)tp / (tp + fn) : (double?)null;
        var accepted = tp + fp + fn + tn;
        var reason = accepted == 0
            ? "没有 as-of 时已核验的故障/正常标签，不能报告精度、召回率或误报率"
            : $"基于 {accepted} 条人工核验的留出集标签，未标注 {unlabeled} 条，拒绝判断 {abstained} 条；不能据此宣称故障概率或 RUL";
        return new(accepted > 0, accepted, unlabeled, abstained,
            tp, fp, fn, tn, precision, recall, fingerprint, reason);
    }
}

