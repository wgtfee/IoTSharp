using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// 独立持久化 Outbox 的双人复核原子状态门禁。不会发送工单、重试未知结果或改动原 Outbox。
/// 调用者负责打开事先建表的专用 SQLite 数据库，并确保第一位审核者的身份可信。
/// 未注册到生产服务；此接口不能作为外部工单已存在的独立证明。
/// </summary>
public sealed class PdmWorkOrderManualReconciler(SqliteConnection db)
{
    /// <summary>
    /// 在一条 SQL UPDATE 中核对同租户、独立审核人、证据 SHA 和 Outbox 当前未知状态。
    /// 只有被另一个审核者确认的 PendingSecondReview 能进行一次状态变更。
    /// </summary>
    public async Task<bool> ConfirmAsync(
        string key, Guid tenant, Guid customer, PdmP2TrustedActor reviewer,
        string evidenceSha256, bool externalExists, DateTimeOffset atUtc,
        CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (reviewer is null || !reviewer.IsAuthenticated || !reviewer.CanReview ||
            reviewer.UserId == Guid.Empty || reviewer.TenantId != tenant ||
            reviewer.CustomerId != customer || tenant == Guid.Empty || customer == Guid.Empty)
            throw new UnauthorizedAccessException("必须在同一租户/客户范围内由可信审核人操作");
        if (string.IsNullOrWhiteSpace(key) || evidenceSha256 is not { Length: 64 } ||
            evidenceSha256.Any(c => c is not (>= 'a' and <= 'f' or >= '0' and <= '9')) ||
            atUtc.Offset != TimeSpan.Zero)
            throw new ArgumentException("对账依据哈希、关联键或 UTC 时间无效");

        await using var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE PdmSandboxManualReconcile
            SET State=$state, ReviewedBy=$reviewer
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
              AND EvidenceSha256=$sha AND State='PendingSecondReview'
              AND RequestedBy<>$reviewer AND AtUtc<=$now
              AND EXISTS (
                SELECT 1 FROM PdmSandboxLease o
                WHERE o.Key=PdmSandboxManualReconcile.Key
                  AND o.Tenant=PdmSandboxManualReconcile.Tenant
                  AND o.Customer=PdmSandboxManualReconcile.Customer
                  AND o.Review=PdmSandboxManualReconcile.Review
                  AND o.State='ReconciliationRequired'
              )
            """;
        cmd.Parameters.AddWithValue("$state", externalExists ?
            "ExternalExistsManuallyReviewed" : "NoExternalOrderManuallyReviewed");
        cmd.Parameters.AddWithValue("$reviewer", reviewer.UserId.ToString("N"));
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$tenant", tenant.ToString("N"));
        cmd.Parameters.AddWithValue("$customer", customer.ToString("N"));
        cmd.Parameters.AddWithValue("$sha", evidenceSha256);
        cmd.Parameters.AddWithValue("$now", atUtc.ToString("O"));
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }
}
