using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>Portable, human-reviewed feature and fault-evidence bundle for offline research only.</summary>
public sealed record PdmP3ReviewedFeatureBundle(
    string SchemaVersion, string EvidenceClass,
    PdmP3SeriesScope Scope,
    DateTimeOffset HoldoutStartUtc, DateTimeOffset AsOfUtc,
    IReadOnlyList<PdmP3ReviewedFeatureRow> Rows);

public sealed record PdmP3ReviewedFeatureRow(
    DateTimeOffset EventTimeUtc, double RobustDeviationScore,
    string SourceId, PdmP3FaultTruth Truth,
    DateTimeOffset VerifiedAtUtc, string CaseReference, string VerifiedBy);

public sealed record PdmP3ReviewedImportResult(
    PdmP3OfflineResearchResult Research,
    string FileSha256, int ImportedRows, string EvidenceClass,
    bool IsActualFieldEvidenceIndependentlyAuthenticated = false,
    bool CanPublishModel = false);

/// <summary>
/// Strict file-to-model adapter. File assertions are never treated as IAM or
/// review approval; the separate caller-supplied approval must originate from
/// an independent reviewer, not the file or UI. No database or network access.
/// </summary>
public static class PdmP3VerifiedEvidenceImport
{
    private const int MaxBundleBytes = 4 * 1024 * 1024;
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() }
    };

    public static async Task<PdmP3ReviewedImportResult> ImportAndEvaluateAsync(
        string filePath, bool independentlyApprovedPhysicalEvidence,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!independentlyApprovedPhysicalEvidence)
            throw new InvalidOperationException(
                "Offline evidence requires independent physical-evidence review.");
        if (string.IsNullOrWhiteSpace(filePath) ||
            !string.Equals(Path.GetExtension(filePath), ".json", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("An explicit offline JSON evidence path is required.");
        var file = new FileInfo(filePath);
        if (!file.Exists || file.Length is < 10 or > MaxBundleBytes ||
            (file.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Missing, oversized or linked evidence file rejected.");

        byte[] content;
        await using (var input = new FileStream(file.FullName, FileMode.Open,
            FileAccess.Read, FileShare.Read, 8192, FileOptions.Asynchronous))
        {
            using var memory = new MemoryStream((int)file.Length);
            var buffer = new byte[8192];
            int amount;
            while ((amount = await input.ReadAsync(buffer, cancellationToken)) > 0)
            {
                if (memory.Length + amount > MaxBundleBytes)
                    throw new InvalidDataException("Evidence file grew beyond the import cap.");
                memory.Write(buffer, 0, amount);
            }
            content = memory.ToArray();
        }

        PdmP3ReviewedFeatureBundle bundle;
        try
        {
            bundle = JsonSerializer.Deserialize<PdmP3ReviewedFeatureBundle>(content, Options)
                ?? throw new InvalidDataException("Evidence envelope is empty.");
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("Evidence JSON schema does not match the reviewed format.", ex);
        }
        if (bundle.SchemaVersion != "pdm-p3-reviewed-features-v1" ||
            bundle.EvidenceClass is not ("IsolatedSyntheticFixture" or "FieldExport") ||
            bundle.Rows is null || bundle.Rows.Count is < 1 or > 10_000 ||
            bundle.Scope is null ||
            bundle.HoldoutStartUtc.Offset != TimeSpan.Zero ||
            bundle.AsOfUtc.Offset != TimeSpan.Zero ||
            bundle.HoldoutStartUtc >= bundle.AsOfUtc)
            throw new InvalidDataException("Unsupported or unsafe offline evidence manifest.");

        var features = new List<PdmP3OfflineFeatureRow>(bundle.Rows.Count);
        var labels = new List<PdmP3FaultLabel>(bundle.Rows.Count);
        foreach (var row in bundle.Rows)
        {
            if (row is null || row.EventTimeUtc.Offset != TimeSpan.Zero ||
                row.VerifiedAtUtc.Offset != TimeSpan.Zero ||
                !double.IsFinite(row.RobustDeviationScore) ||
                string.IsNullOrWhiteSpace(row.SourceId) ||
                string.IsNullOrWhiteSpace(row.CaseReference) ||
                string.IsNullOrWhiteSpace(row.VerifiedBy))
                throw new InvalidDataException("Evidence row lacks UTC, finite feature or provenance.");
            features.Add(new(bundle.Scope, row.EventTimeUtc,
                row.RobustDeviationScore, row.SourceId));
            labels.Add(new(bundle.Scope, row.EventTimeUtc,
                row.VerifiedAtUtc, row.Truth, row.CaseReference, row.VerifiedBy));
        }
        // The research evaluator enforces scope, independent episodes, label
        // as-of time, train/holdout separation and train-only fitting.
        var research = PdmP3OfflineModelResearch.FitAndEvaluate(
            features, labels, bundle.HoldoutStartUtc, bundle.AsOfUtc, true);
        return new(research,
            Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
            bundle.Rows.Count, bundle.EvidenceClass);
    }
}

