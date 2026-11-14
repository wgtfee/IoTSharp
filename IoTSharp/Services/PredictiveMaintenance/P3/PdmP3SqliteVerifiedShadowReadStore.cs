using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Controllers;
using Microsoft.Data.Sqlite;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>
/// 独立、只读的 P3 审核证据 SQLite 适配器。数据表由人工审核的独立迁移创建，
/// 这里不建表、不迁移、不注册到生产 DI，也不产生预测、告警或工单。
/// </summary>
public sealed class PdmP3SqliteVerifiedShadowReadStore : IPdmP3VerifiedShadowReadStore
{
    private readonly string _connectionString;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>仅接收预先存在的独立证据库文件；强制以 SQLite ReadOnly 模式打开。</summary>
    public PdmP3SqliteVerifiedShadowReadStore(string sqlitePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sqlitePath);
        var path = System.IO.Path.GetFullPath(sqlitePath);
        if (!System.IO.File.Exists(path))
            throw new System.IO.FileNotFoundException("审核证据库未部署", path);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false
        }.ToString();
    }

    /// <summary>
    /// 只读取与可信令牌和已核验 Profile 完全匹配的证据；双人审核和证据哈希校验失败时返回空。
    /// 表的存在不等于审核人身份已获企业 IAM 认证，仍需线下证据入库流程单独审核。
    /// </summary>
    public async Task<PdmP3StoredShadowEvidence?> FetchAsync(
        Guid tenantId, Guid customerId, Guid deviceId,
        Guid profileId, int profileVersion, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (tenantId == Guid.Empty || customerId == Guid.Empty ||
            deviceId == Guid.Empty || profileId == Guid.Empty || profileVersion < 1)
            return null;
        await using var db = new SqliteConnection(_connectionString);
        await db.OpenAsync(ct);
        await using var cmd = db.CreateCommand();
        cmd.CommandTimeout = 5;
        cmd.CommandText = """
            SELECT SnapshotJson, SnapshotSha256, FirstReviewer, SecondReviewer, ReviewedAtUtc
            FROM PdmP3ReviewedEvidence
            WHERE TenantId=$tenant AND CustomerId=$customer AND DeviceId=$device
              AND ProfileId=$profile AND ProfileVersion=$version
            ORDER BY ReviewedAtUtc DESC LIMIT 1
            """;
        cmd.Parameters.AddWithValue("$tenant", tenantId.ToString("N"));
        cmd.Parameters.AddWithValue("$customer", customerId.ToString("N"));
        cmd.Parameters.AddWithValue("$device", deviceId.ToString("N"));
        cmd.Parameters.AddWithValue("$profile", profileId.ToString("N"));
        cmd.Parameters.AddWithValue("$version", profileVersion);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        if (reader.IsDBNull(0) || reader.IsDBNull(1) || reader.IsDBNull(2) ||
            reader.IsDBNull(3) || reader.IsDBNull(4)) return null;
        var payload = reader.GetString(0);
        var hash = reader.GetString(1);
        if (payload.Length > 262144 || hash.Length != 64 ||
            !Guid.TryParse(reader.GetString(2), out var first) ||
            !Guid.TryParse(reader.GetString(3), out var second) ||
            first == Guid.Empty || second == Guid.Empty || first == second ||
            !DateTimeOffset.TryParse(reader.GetString(4),
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var reviewedAt) ||
            reviewedAt.Offset != TimeSpan.Zero ||
            reviewedAt > DateTimeOffset.UtcNow.AddMinutes(2))
            return null;
        byte[] expected;
        try { expected = Convert.FromHexString(hash); }
        catch (FormatException) { return null; }
        var actual = SHA256.HashData(Encoding.UTF8.GetBytes(payload));
        if (!CryptographicOperations.FixedTimeEquals(expected, actual)) return null;
        PdmP3StoredShadowEvidence? evidence;
        try { evidence = JsonSerializer.Deserialize<PdmP3StoredShadowEvidence>(payload, Json); }
        catch (JsonException) { return null; }
        if (evidence is null || evidence.TenantId != tenantId ||
            evidence.CustomerId != customerId || evidence.DeviceId != deviceId ||
            evidence.ProfileId != profileId || evidence.ProfileVersion != profileVersion ||
            evidence.CreatedAtUtc.Offset != TimeSpan.Zero ||
            reviewedAt < evidence.CreatedAtUtc)
            return null;
        return evidence;
    }
}
