using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using IoTSharp.Controllers;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.IamUi;

/// <summary>真实磁盘 SQLite 审核证据读源；不是企业 IAM 人员身份验收。</summary>
public sealed class Batch6P3PersistentEvidenceStoreTests
{
    private static string FilePath() => Path.Combine(Path.GetTempPath(),
        "pdm-batch6-p3-evidence-" + Guid.NewGuid().ToString("N") + ".sqlite");

    private static PdmP3StoredShadowEvidence Build(
        Guid tenant, Guid customer, Guid device, Guid profile, int version)
    {
        var at = DateTimeOffset.UtcNow.AddMinutes(-2);
        var scope = new PdmP3SeriesScope(tenant, customer, device, profile, version,
            "bearing.rms", "mm/s", "Running", true, true, true);
        var finding = new PdmP3AnomalyFinding(scope, at,
            PdmP3AnomalyState.Anomalous, 4.2, 1.2, 0.2, 1.0, 9, "offline fixture");
        var report = new PdmP3ShadowReport(PdmP3ShadowState.ExplainableBaseline,
            finding, "reviewed synthetic evidence; not a fault probability");
        return new(tenant, customer, device, profile, version,
            at, at.AddSeconds(2), true, true, new string('a', 64), report);
    }

    private static async Task Seed(string path, PdmP3StoredShadowEvidence evidence,
        bool tamper = false, bool selfReview = false)
    {
        await using var connection = new SqliteConnection(
            "Data Source=" + path + ";Pooling=False");
        await connection.OpenAsync();
        await using(var ddl = connection.CreateCommand())
        {
            ddl.CommandText = """
                CREATE TABLE PdmP3ReviewedEvidence (
                  TenantId TEXT NOT NULL, CustomerId TEXT NOT NULL,
                  DeviceId TEXT NOT NULL, ProfileId TEXT NOT NULL,
                  ProfileVersion INTEGER NOT NULL, SnapshotJson TEXT NOT NULL,
                  SnapshotSha256 TEXT NOT NULL, FirstReviewer TEXT NOT NULL,
                  SecondReviewer TEXT NOT NULL, ReviewedAtUtc TEXT NOT NULL);
                CREATE INDEX IX_PdmP3ReviewedEvidence_Scope
                ON PdmP3ReviewedEvidence(TenantId,CustomerId,DeviceId,ProfileId,ProfileVersion);
                """;
            await ddl.ExecuteNonQueryAsync();
        }
        var json = JsonSerializer.Serialize(evidence,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var digest = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
        var first = Guid.NewGuid();
        await using var insert = connection.CreateCommand();
        insert.CommandText = """
            INSERT INTO PdmP3ReviewedEvidence
            (TenantId,CustomerId,DeviceId,ProfileId,ProfileVersion,SnapshotJson,
             SnapshotSha256,FirstReviewer,SecondReviewer,ReviewedAtUtc)
            VALUES ($t,$c,$d,$p,$v,$json,$sha,$first,$second,$at)
            """;
        insert.Parameters.AddWithValue("$t", evidence.TenantId.ToString("N"));
        insert.Parameters.AddWithValue("$c", evidence.CustomerId.ToString("N"));
        insert.Parameters.AddWithValue("$d", evidence.DeviceId.ToString("N"));
        insert.Parameters.AddWithValue("$p", evidence.ProfileId.ToString("N"));
        insert.Parameters.AddWithValue("$v", evidence.ProfileVersion);
        insert.Parameters.AddWithValue("$json", json);
        insert.Parameters.AddWithValue("$sha", tamper ? new string('f', 64) : digest);
        insert.Parameters.AddWithValue("$first", first.ToString("N"));
        insert.Parameters.AddWithValue("$second", (selfReview ? first : Guid.NewGuid()).ToString("N"));
        insert.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
        await insert.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task ClosedAndReopenedFileReturnsOnlyScopedReviewedStatistics()
    {
        var path = FilePath();
        var tenant = Guid.NewGuid(); var customer = Guid.NewGuid();
        var device = Guid.NewGuid(); var profile = Guid.NewGuid();
        try
        {
            await Seed(path, Build(tenant,customer,device,profile,2));
            var reader = new PdmP3SqliteVerifiedShadowReadStore(path);
            var accepted = await reader.FetchAsync(tenant,customer,device,profile,2,default);
            Assert.NotNull(accepted);
            Assert.Equal(4.2, accepted.Report.Finding.RobustDeviationScore);
            Assert.False(accepted.Report.IsWorkOrderCreated);
            Assert.Null(await reader.FetchAsync(Guid.NewGuid(),customer,device,profile,2,default));
            Assert.Null(await reader.FetchAsync(tenant,customer,device,profile,3,default));
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(path); }
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task HashTamperOrSameReviewerCannotPass(bool tamper, bool selfReview)
    {
        var path = FilePath();
        var tenant = Guid.NewGuid(); var customer = Guid.NewGuid();
        var device = Guid.NewGuid(); var profile = Guid.NewGuid();
        try
        {
            await Seed(path, Build(tenant,customer,device,profile,2),tamper,selfReview);
            var reader = new PdmP3SqliteVerifiedShadowReadStore(path);
            Assert.Null(await reader.FetchAsync(tenant,customer,device,profile,2,default));
        }
        finally { SqliteConnection.ClearAllPools(); File.Delete(path); }
    }
}
