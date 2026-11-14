using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace IoTSharp.PdmSyntheticLab;

// This research assembly is intentionally NOT referenced or registered by the IoTSharp host.
// All failure labels and RUL targets here are SIMULATED and have no physical provenance.
public enum SyntheticPartition { Train, Validation, Test }

public sealed record SyntheticObservation(
    string DeviceId, DateTimeOffset AtUtc, SyntheticPartition Partition,
    double VibrationMmS, double TemperatureC, double CurrentA, double PressureBar,
    double LoadPct, double AmbientC, bool FailureWithin24Hours, double HoursUntilNextFault)
{
    // Explicit allowlist: no future failure timestamp, label, RUL, device ID or split in features.
    public double[] FeatureVector() =>
        [VibrationMmS, TemperatureC, CurrentA, PressureBar, LoadPct, AmbientC];
}

public sealed record SyntheticModel(
    string SchemaVersion, bool SyntheticOnly, bool RealWorldCalibrated,
    bool ProductionActivationAllowed, string[] FeatureNames,
    double[] Means, double[] StandardDeviations, double[] RiskWeights,
    double RiskThreshold, double[] LogRulWeights,
    string TrainingAndValidationSha256, int TrainingRows, int ValidationRows);

public sealed record SyntheticMetrics(
    int Rows, int FaultRows, int TruePositive, int FalsePositive,
    int FalseNegative, int TrueNegative, double Precision,
    double Recall, double F1, double FalsePositiveRate, double BrierScore,
    double RulMaeHours, double MedianRulBaselineMaeHours);

public sealed record SyntheticExperiment(
    string State, int Seed, int TotalRows, int TrainRows, int ValidationRows,
    int TestRows, string FullSyntheticDatasetSha256, string FitInputSha256,
    double RiskThreshold, SyntheticMetrics Validation, SyntheticMetrics BlindTest,
    bool PhysicalEvidenceReviewed, bool ProductionApproved,
    string Warning);

public static class SyntheticResearch
{
    public const string Schema = "pdm-SYNTHETIC-ONLY-multivariate-v1";
    public const int DefaultSeed = 20261114;
    public static readonly string[] Features =
        ["VibrationMmS", "TemperatureC", "CurrentA", "PressureBar", "LoadPct", "AmbientC"];
    public static readonly DateTimeOffset StartUtc =
        new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public static IReadOnlyList<SyntheticObservation> Generate(int seed = DefaultSeed)
    {
        var random = new Random(seed);
        var rows = new List<SyntheticObservation>(4000);
        for (var device = 0; device < 30; device++)
        {
            var cycleSteps = 40 + (device * 7) % 26; // 6.7..10.8 days per artificial fault
            var phaseOffset = (device * 13) % cycleSteps;
            var mechanism = device % 4; // different degradation mechanisms
            var vibrationBias = (device % 7) * .14;
            var temperatureBias = (device % 5) * .55;
            for (var day = 0; day < 52; day++)
            {
                var part = device < 18 && day < 27 ? SyntheticPartition.Train
                    : device is >= 18 and < 24 && day is >= 28 and < 39
                        ? SyntheticPartition.Validation
                    : device >= 24 && day >= 40 ? SyntheticPartition.Test
                    : (SyntheticPartition?)null;
                // 24-hour embargo before the next split; devices never cross splits.
                if (part is null) continue;
                for (var slot = 0; slot < 6; slot++)
                {
                    var sampleIndex = day * 6 + slot;
                    var phase = (sampleIndex + phaseOffset) % cycleSteps;
                    var wear = phase / (double)(cycleSteps - 1);
                    var untilFault = (cycleSteps - phase) * 4.0;
                    var ambient = 21 + 6 * Math.Sin(sampleIndex * .09 + device * .2)
                        + Noise(random, .45);
                    var load = Math.Clamp(60 + 19 * Math.Sin(sampleIndex * .13 + device)
                        + Noise(random, 4.0), 15, 100);
                    var vibDrift = mechanism switch
                    {
                        0 => 5.0, 1 => 2.8, 2 => 4.2, _ => 3.0
                    };
                    var pressureDrift = mechanism switch
                    {
                        0 => .6, 1 => 1.65, 2 => 1.2, _ => 1.45
                    };
                    var testShift = part == SyntheticPartition.Test ? .35 : 0.0;
                    rows.Add(new(
                        $"SYN-DEV-{device:000}", StartUtc.AddDays(day).AddHours(slot * 4),
                        part.Value,
                        1.3 + vibrationBias + .007 * load +
                            vibDrift * Math.Pow(wear, 2.9) + testShift + Noise(random, .42),
                        36 + .28 * ambient + temperatureBias +
                            10.0 * Math.Pow(wear, 2.4) + .055 * load + Noise(random, 1.3),
                        5.4 + .054 * load +
                            (mechanism == 1 ? 5.2 : 3.7) * Math.Pow(wear, 2.0) +
                            Noise(random, .65),
                        6.3 - .013 * load - pressureDrift * Math.Pow(wear, 2.5) +
                            Noise(random, .18),
                        load, ambient,
                        untilFault <= 24, untilFault));
                }
            }
        }
        return rows;
    }

    private static double Noise(Random random, double scale) =>
        (random.NextDouble() + random.NextDouble() + random.NextDouble() - 1.5) * scale;

    public static (SyntheticModel Model, SyntheticExperiment Report) Run(
        IReadOnlyList<SyntheticObservation> observations, int seed = DefaultSeed)
    {
        ValidateDataset(observations);
        var train = observations.Where(x => x.Partition == SyntheticPartition.Train).ToArray();
        var val = observations.Where(x => x.Partition == SyntheticPartition.Validation).ToArray();
        var test = observations.Where(x => x.Partition == SyntheticPartition.Test).ToArray();
        var means = new double[Features.Length];
        var scales = new double[Features.Length];
        foreach (var row in train)
        {
            var vec = row.FeatureVector();
            for (var j = 0; j < means.Length; j++) means[j] += vec[j] / train.Length;
        }
        foreach (var row in train)
        {
            var vec = row.FeatureVector();
            for (var j = 0; j < means.Length; j++)
                scales[j] += Math.Pow(vec[j] - means[j], 2) / train.Length;
        }
        for (var j = 0; j < scales.Length; j++)
            scales[j] = Math.Max(.0001, Math.Sqrt(scales[j]));
        var riskWeights = FitRisk(train, means, scales);
        var rulWeights = FitLogRul(train, means, scales);
        var threshold = SelectThreshold(val, means, scales, riskWeights);
        var fitHash = Sha256(Canonical(train.Concat(val)));
        var model = new SyntheticModel(Schema, true, false, false,
            (string[])Features.Clone(), means, scales, riskWeights, threshold,
            rulWeights, fitHash, train.Length, val.Length);
        var report = new SyntheticExperiment("SyntheticOfflineStudyOnly",
            seed, observations.Count, train.Length, val.Length, test.Length,
            Sha256(Canonical(observations)), fitHash, threshold,
            Evaluate(model, val, train), Evaluate(model, test, train),
            false, false,
            "仅为固定规则生成的合成传感器与虚构故障；无现场证据、无真实概率校准、无生产上线/自动告警/工单权限。");
        return (model, report);
    }

    public static void ValidateDataset(IReadOnlyList<SyntheticObservation> observations)
    {
        ArgumentNullException.ThrowIfNull(observations);
        if (observations.Count < 500 || observations.Count > 100_000)
            throw new InvalidOperationException("Synthetic dataset outside experiment limits.");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        var trainIds = new HashSet<string>(StringComparer.Ordinal);
        var valIds = new HashSet<string>(StringComparer.Ordinal);
        var testIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in observations)
        {
            if (row is null || !row.DeviceId.StartsWith("SYN-DEV-", StringComparison.Ordinal) ||
                row.AtUtc.Offset != TimeSpan.Zero || row.AtUtc == default ||
                !identities.Add(row.DeviceId + "|" + row.AtUtc.ToUnixTimeSeconds()) ||
                row.FeatureVector().Any(x => !double.IsFinite(x)) ||
                !double.IsFinite(row.HoursUntilNextFault) || row.HoursUntilNextFault <= 0 ||
                (row.FailureWithin24Hours != (row.HoursUntilNextFault <= 24)))
                throw new InvalidOperationException("Invalid synthetic row, duplicate or label.");
            switch (row.Partition)
            {
                case SyntheticPartition.Train when row.AtUtc < StartUtc.AddDays(27):
                    trainIds.Add(row.DeviceId); break;
                case SyntheticPartition.Validation when
                    row.AtUtc >= StartUtc.AddDays(28) && row.AtUtc < StartUtc.AddDays(39):
                    valIds.Add(row.DeviceId); break;
                case SyntheticPartition.Test when
                    row.AtUtc >= StartUtc.AddDays(40) && row.AtUtc < StartUtc.AddDays(52):
                    testIds.Add(row.DeviceId); break;
                default: throw new InvalidOperationException("Temporal split/embargo violation.");
            }
        }
        if (trainIds.Count < 10 || valIds.Count < 4 || testIds.Count < 4 ||
            trainIds.Overlaps(valIds) || trainIds.Overlaps(testIds) || valIds.Overlaps(testIds))
            throw new InvalidOperationException("Split equipment identity leakage.");
        foreach (var split in Enum.GetValues<SyntheticPartition>())
        {
            var selected = observations.Where(x => x.Partition == split).ToArray();
            if (selected.Length < 100 || selected.Count(x => x.FailureWithin24Hours) < 10 ||
                selected.Count(x => !x.FailureWithin24Hours) < 50)
                throw new InvalidOperationException("Insufficient independent synthetic outcomes.");
        }
    }

    private static double[] FitRisk(
        IReadOnlyList<SyntheticObservation> data, double[] mean, double[] scale)
    {
        var result = new double[Features.Length + 1];
        var faults = data.Count(x => x.FailureWithin24Hours);
        var weightPositive = Math.Min(8.0, (data.Count - faults) / (double)faults);
        for (var epoch = 0; epoch < 650; epoch++)
        {
            var gradient = new double[result.Length];
            foreach (var row in data)
            {
                var x = Normalized(row, mean, scale);
                var z = result[0];
                for (var j = 0; j < x.Length; j++) z += x[j] * result[j + 1];
                var p = Sigmoid(z);
                var w = row.FailureWithin24Hours ? weightPositive : 1.0;
                var error = (p - (row.FailureWithin24Hours ? 1.0 : 0.0)) * w;
                gradient[0] += error;
                for (var j = 0; j < x.Length; j++) gradient[j + 1] += error * x[j];
            }
            for (var j = 0; j < result.Length; j++)
                result[j] -= .10 * (gradient[j] / data.Count +
                    (j == 0 ? 0 : .025 * result[j]));
        }
        return result;
    }

    private static double[] FitLogRul(
        IReadOnlyList<SyntheticObservation> data, double[] mean, double[] scale)
    {
        var result = new double[Features.Length + 1];
        result[0] = data.Average(x => Math.Log(1 + x.HoursUntilNextFault));
        for (var epoch = 0; epoch < 700; epoch++)
        {
            var gradient = new double[result.Length];
            foreach (var row in data)
            {
                var x = Normalized(row, mean, scale);
                var prediction = result[0];
                for (var j = 0; j < x.Length; j++) prediction += x[j] * result[j + 1];
                var error = prediction - Math.Log(1 + row.HoursUntilNextFault);
                gradient[0] += error;
                for (var j = 0; j < x.Length; j++) gradient[j + 1] += error * x[j];
            }
            for (var j = 0; j < result.Length; j++)
                result[j] -= .055 * (gradient[j] / data.Count +
                    (j == 0 ? 0 : .035 * result[j]));
        }
        return result;
    }

    private static double[] Normalized(
        SyntheticObservation row, double[] means, double[] scales)
    {
        var x = row.FeatureVector();
        for (var i = 0; i < x.Length; i++) x[i] = (x[i] - means[i]) / scales[i];
        return x;
    }

    private static double Sigmoid(double z) =>
        1.0 / (1 + Math.Exp(-Math.Clamp(z, -40, 40)));

    // Output is an *uncalibrated synthetic risk score*, NOT a field failure probability.
    public static (double SyntheticRiskScore, double SyntheticRulHours) Score(
        SyntheticModel model, SyntheticObservation row)
    {
        CheckModel(model);
        var x = Normalized(row, model.Means, model.StandardDeviations);
        double risk = model.RiskWeights[0], logRul = model.LogRulWeights[0];
        for (var j = 0; j < x.Length; j++)
        {
            risk += x[j] * model.RiskWeights[j + 1];
            logRul += x[j] * model.LogRulWeights[j + 1];
        }
        return (Sigmoid(risk), Math.Clamp(Math.Exp(Math.Clamp(logRul, 0, 9)) - 1, 0, 500));
    }

    private static double SelectThreshold(
        IReadOnlyList<SyntheticObservation> validation,
        double[] means, double[] scales, double[] riskWeights)
    {
        var model = new SyntheticModel(Schema, true, false, false, Features, means, scales,
            riskWeights, .5, new double[Features.Length + 1], "validation-only", 1, 1);
        var scored = validation.Select(x =>
            (x.FailureWithin24Hours, Score(model, x).SyntheticRiskScore)).ToArray();
        double best = .5, bestF1 = -1;
        for (var i = 5; i <= 95; i++)
        {
            var cutoff = i / 100.0;
            var tp = scored.Count(x => x.FailureWithin24Hours && x.SyntheticRiskScore >= cutoff);
            var fp = scored.Count(x => !x.FailureWithin24Hours && x.SyntheticRiskScore >= cutoff);
            var fn = scored.Count(x => x.FailureWithin24Hours && x.SyntheticRiskScore < cutoff);
            var f1 = (2.0 * tp + fp + fn) > 0 ? 2.0 * tp / (2.0 * tp + fp + fn) : 0;
            if (f1 > bestF1 + 1e-12 || (Math.Abs(f1 - bestF1) < 1e-12 && cutoff > best))
            {
                best = cutoff;
                bestF1 = f1;
            }
        }
        return best;
    }

    public static SyntheticMetrics Evaluate(
        SyntheticModel model, IReadOnlyList<SyntheticObservation> rows,
        IReadOnlyList<SyntheticObservation> training)
    {
        CheckModel(model);
        if (rows.Count == 0 || training.Count == 0)
            throw new InvalidOperationException("Empty evaluation/training data.");
        var sortedRul = training.Select(x => x.HoursUntilNextFault).OrderBy(x => x).ToArray();
        var median = sortedRul[sortedRul.Length / 2];
        var tp = 0; var fp = 0; var fn = 0; var tn = 0;
        double brier = 0, rulError = 0, baselineError = 0;
        foreach (var row in rows)
        {
            var (risk, rul) = Score(model, row);
            var predicted = risk >= model.RiskThreshold;
            if (row.FailureWithin24Hours)
            {
                if (predicted) tp++; else fn++;
            }
            else
            {
                if (predicted) fp++; else tn++;
            }
            var error = risk - (row.FailureWithin24Hours ? 1 : 0);
            brier += error * error; // for comparison only; not a calibration guarantee
            rulError += Math.Abs(rul - row.HoursUntilNextFault);
            baselineError += Math.Abs(median - row.HoursUntilNextFault);
        }
        var p = tp + fp == 0 ? 0 : (double)tp / (tp + fp);
        var r = tp + fn == 0 ? 0 : (double)tp / (tp + fn);
        return new(rows.Count, tp + fn, tp, fp, fn, tn, p, r,
            tp + fp + fn == 0 ? 0 : 2.0 * tp / (2.0 * tp + fp + fn),
            fp + tn == 0 ? 0 : (double)fp / (fp + tn),
            brier / rows.Count, rulError / rows.Count, baselineError / rows.Count);
    }

    public static string Canonical(IEnumerable<SyntheticObservation> data)
    {
        var sb = new StringBuilder(Schema).Append('\n');
        foreach (var row in data.OrderBy(x => x.DeviceId, StringComparer.Ordinal)
                     .ThenBy(x => x.AtUtc))
        {
            sb.Append(row.DeviceId).Append('|').Append(row.AtUtc.ToUnixTimeSeconds())
                .Append('|').Append(row.Partition);
            foreach (var value in row.FeatureVector())
                sb.Append('|').Append(value.ToString("R", CultureInfo.InvariantCulture));
            sb.Append('|').Append(row.FailureWithin24Hours ? '1' : '0')
                .Append('|').Append(row.HoursUntilNextFault.ToString("R", CultureInfo.InvariantCulture))
                .Append('\n');
        }
        return sb.ToString();
    }

    public static string Sha256(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static void CheckModel(SyntheticModel model)
    {
        if (model is null || model.SchemaVersion != Schema || !model.SyntheticOnly ||
            model.RealWorldCalibrated || model.ProductionActivationAllowed ||
            model.FeatureNames is null || !model.FeatureNames.SequenceEqual(Features) ||
            model.Means is null || model.Means.Length != Features.Length ||
            model.StandardDeviations is null || model.StandardDeviations.Length != Features.Length ||
            model.RiskWeights is null || model.RiskWeights.Length != Features.Length + 1 ||
            model.LogRulWeights is null || model.LogRulWeights.Length != Features.Length + 1 ||
            model.Means.Any(x => !double.IsFinite(x)) ||
            model.StandardDeviations.Any(x => !double.IsFinite(x) || x <= 0) ||
            model.RiskWeights.Any(x => !double.IsFinite(x)) ||
            model.LogRulWeights.Any(x => !double.IsFinite(x)) ||
            !double.IsFinite(model.RiskThreshold) ||
            model.RiskThreshold is < 0 or > 1)
            throw new InvalidOperationException("Unsafe, corrupted or non-synthetic model.");
    }

    public static void SaveModel(string modelPath, SyntheticModel model)
    {
        CheckModel(model);
        var content = JsonSerializer.Serialize(model, new JsonSerializerOptions { WriteIndented = true });
        using (var stream = new FileStream(modelPath, FileMode.CreateNew, FileAccess.Write))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            writer.Write(content);
        File.WriteAllText(modelPath + ".sha256", Sha256(content), Encoding.ASCII);
    }

    public static SyntheticModel LoadModel(string modelPath)
    {
        var content = File.ReadAllText(modelPath, Encoding.UTF8);
        var checksum = File.ReadAllText(modelPath + ".sha256", Encoding.ASCII).Trim();
        if (!string.Equals(Sha256(content), checksum, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Synthetic model artifact SHA256 mismatch.");
        var model = JsonSerializer.Deserialize<SyntheticModel>(content) ??
            throw new InvalidOperationException("Missing synthetic model artifact.");
        CheckModel(model);
        return model;
    }
}
