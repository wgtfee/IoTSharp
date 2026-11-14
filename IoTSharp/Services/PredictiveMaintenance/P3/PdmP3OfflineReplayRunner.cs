using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public sealed record PdmP3OfflineReplayRun(
    int TrainingRows, int HoldoutRows,
    string InputSha256, IReadOnlyList<PdmP3AnomalyFinding> Predictions,
    PdmP3ReplayMetrics Metrics, bool UsedFutureLabelsForDetection = false,
    bool IsProductionModel = false);

/// <summary>
/// Causal, deterministic offline runner. Every prediction sees exactly
/// baselineRows PRIOR samples + its own assessment point. Labels are used
/// only after predictions are computed for metrics, never to fit thresholds.
/// </summary>
public static class PdmP3OfflineReplayRunner
{
    public static PdmP3OfflineReplayRun Run(
        IReadOnlyList<PdmP3Observation> observations,
        IReadOnlyList<PdmP3FaultLabel> verifiedLabels,
        int trainingRows, DateTimeOffset labelAsOfUtc,
        int baselineRows = 8)
    {
        ArgumentNullException.ThrowIfNull(observations);
        ArgumentNullException.ThrowIfNull(verifiedLabels);
        if (baselineRows is < 5 or > 128 ||
            trainingRows < baselineRows || trainingRows >= observations.Count)
            throw new ArgumentOutOfRangeException(nameof(trainingRows));
        var validation = PdmP3DatasetValidator.ValidateSamples(
            observations, baselineRows + 1);
        if (!validation.Accepted)
            throw new InvalidOperationException($"P3 dataset refused: {validation.Reason}");
        if (labelAsOfUtc.Offset != TimeSpan.Zero ||
            labelAsOfUtc < observations[^1].EventTimeUtc)
            throw new InvalidOperationException("Replay labels must be evaluated at a trusted UTC as-of date");
        var labelCheck = PdmP3DatasetValidator.ValidateLabels(
            observations[0].Scope, verifiedLabels, labelAsOfUtc);
        if (!labelCheck.Accepted)
            throw new InvalidOperationException(labelCheck.Reason);

        var predictions = new List<PdmP3AnomalyFinding>(observations.Count - trainingRows);
        for (var i = trainingRows; i < observations.Count; i++)
        {
            // Never include future observations beyond the evaluated event-time.
            var window = observations.Skip(i - baselineRows)
                .Take(baselineRows + 1).ToArray();
            predictions.Add(PdmP3AnomalyDetector.Evaluate(
                window, baselineRows: baselineRows));
        }
        var metrics = PdmP3ReplayEvaluator.Evaluate(predictions,
            verifiedLabels, observations[trainingRows].EventTimeUtc,
            labelAsOfUtc);

        // Data-provenance SHA, explicitly independent of machine clock or randomness.
        var content = new StringBuilder("pdm-p3-dataset-v1\n");
        foreach (var row in observations)
            content.Append(row.Scope.TenantId.ToString("N")).Append('|')
                .Append(row.Scope.CustomerId.ToString("N")).Append('|')
                .Append(row.Scope.DeviceId.ToString("N")).Append('|')
                .Append(row.Scope.ProfileId.ToString("N")).Append('|')
                .Append(row.Scope.ProfileVersion).Append('|')
                .Append(row.Scope.PointKey).Append('|')
                .Append(row.Scope.EngineeringUnit).Append('|')
                .Append(row.Scope.OperatingMode).Append('|')
                .Append(row.EventTimeUtc.ToUnixTimeMilliseconds()).Append('|')
                .Append(row.Value.ToString("R", CultureInfo.InvariantCulture)).Append('|')
                .Append((int)row.Quality).Append('|')
                .Append(row.SourceId).Append('\n');
        var inputHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(content.ToString())))
            .ToLowerInvariant();
        return new(trainingRows, predictions.Count, inputHash, predictions, metrics);
    }
}

