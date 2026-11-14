using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using IoTSharp.PdmSyntheticLab;

if (args.Length != 2 || args[0] != "--run-id" ||
    !Regex.IsMatch(args[1], "^[A-Za-z0-9_-]{1,40}$"))
{
    Console.Error.WriteLine("Usage: dotnet run --project tools/pdm-synthetic-lab -- --run-id unique-name");
    return 2;
}

// Never accept an arbitrary output path, database connection or remote endpoint.
// Artifacts live only inside this tool's excluded output directory.
var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
    "..", "..", "..", "output"));
var directory = Path.Combine(root, args[1]);
Directory.CreateDirectory(root);
if (Directory.Exists(directory))
{
    Console.Error.WriteLine("Output already exists; refusing to overwrite prior evidence.");
    return 3;
}
Directory.CreateDirectory(directory);

var rows = SyntheticResearch.Generate();
var (model, report) = SyntheticResearch.Run(rows);
var featurePath = Path.Combine(directory, "SYNTHETIC_features.csv");
var labelsPath = Path.Combine(directory, "SYNTHETIC_labels.csv");
var modelPath = Path.Combine(directory, "SYNTHETIC_model.json");
var reportPath = Path.Combine(directory, "SYNTHETIC_evaluation.json");

using (var writer = NewWriter(featurePath))
{
    writer.WriteLine("SyntheticOnly,DeviceId,AtUtc,Partition,VibrationMmS,TemperatureC,CurrentA,PressureBar,LoadPct,AmbientC");
    foreach (var item in rows)
        writer.WriteLine(string.Join(",", "TRUE", item.DeviceId,
            item.AtUtc.ToString("O", CultureInfo.InvariantCulture), item.Partition,
            string.Join(",", item.FeatureVector().Select(x => x.ToString("R", CultureInfo.InvariantCulture)))));
}
using (var writer = NewWriter(labelsPath))
{
    writer.WriteLine("SyntheticOnly,DeviceId,AtUtc,SimulatedFaultWithin24Hours,SimulatedHoursUntilNextFault");
    foreach (var item in rows)
        writer.WriteLine(string.Join(",", "TRUE", item.DeviceId,
            item.AtUtc.ToString("O", CultureInfo.InvariantCulture),
            item.FailureWithin24Hours ? "1" : "0",
            item.HoursUntilNextFault.ToString("R", CultureInfo.InvariantCulture)));
}
SyntheticResearch.SaveModel(modelPath, model);
File.WriteAllText(reportPath, JsonSerializer.Serialize(report,
    new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
var reopened = SyntheticResearch.LoadModel(modelPath);
if (reopened.TrainingAndValidationSha256 != model.TrainingAndValidationSha256)
    throw new InvalidOperationException("Model restart/reopen verification failed.");

var paths = new[] { featurePath, labelsPath, modelPath, modelPath + ".sha256", reportPath };
var hashes = paths.ToDictionary(x => Path.GetFileName(x),
    x => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(x))).ToLowerInvariant());
var manifest = new
{
    schema = SyntheticResearch.Schema,
    synthetic_only = true,
    physical_evidence_reviewed = false,
    real_world_probability_calibrated = false,
    production_activation_allowed = false,
    external_commands_sent = false,
    training_run_seed = SyntheticResearch.DefaultSeed,
    records = rows.Count,
    training_device_count = 18,
    validation_device_count = 6,
    test_device_count = 6,
    horizon_hours = 24,
    label_provenance = "Mathematically generated artificial fault cycle, NOT actual field evidence",
    files_sha256 = hashes
};
File.WriteAllText(Path.Combine(directory, "SYNTHETIC_manifest.json"),
    JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }),
    new UTF8Encoding(false));
Console.WriteLine(JsonSerializer.Serialize(new
{
    state = report.State, directory, report.TotalRows, report.TrainRows,
    report.ValidationRows, report.TestRows,
    report.RiskThreshold,
    validationF1 = report.Validation.F1,
    testF1 = report.BlindTest.F1,
    testPrecision = report.BlindTest.Precision,
    testRecall = report.BlindTest.Recall,
    testFalsePositiveRate = report.BlindTest.FalsePositiveRate,
    testSyntheticRulMaeHours = report.BlindTest.RulMaeHours,
    testMedianBaselineMaeHours = report.BlindTest.MedianRulBaselineMaeHours,
    report.ProductionApproved
}));
return 0;

static StreamWriter NewWriter(string path) =>
    new(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None),
        new UTF8Encoding(false));
