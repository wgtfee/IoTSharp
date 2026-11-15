using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// IoTSharp-local repair management: own work order, audit and one Feishu
/// notification request per verified risk episode. No external maintenance API.
/// No notification can be sent until a separately approved dispatcher is wired.
/// </summary>
public sealed class PdmInternalWorkOrderService(
    PdmInternalWorkOrderDbContext db,
    Microsoft.Extensions.Configuration.IConfiguration? config = null)
{
    private static void Scope(Guid tenant, Guid customer)
    {
        if (tenant == Guid.Empty || customer == Guid.Empty)
            throw new UnauthorizedAccessException("Trusted tenant/customer required.");
    }

    private static void VerifyRealRisk(
        PdmDeviceProfile profile, PdmRiskEvent episode, PdmHealthSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(episode);
        ArgumentNullException.ThrowIfNull(snapshot);
        Scope(profile.TenantId, profile.CustomerId);
        if (profile.Id == Guid.Empty || profile.DeviceId == Guid.Empty ||
            !profile.Enabled || !profile.PointMappingsVerified || !profile.RunStateVerified ||
            string.IsNullOrWhiteSpace(profile.RunStateTelemetryKey) ||
            profile.Version < 1 || episode.Id == Guid.Empty ||
            episode.TenantId != profile.TenantId ||
            episode.CustomerId != profile.CustomerId ||
            episode.DeviceId != profile.DeviceId ||
            episode.ProfileId != profile.Id ||
            episode.ProfileVersion != profile.Version ||
            episode.Status != "Open" ||
            episode.RiskType != PdmRiskEventTransitions.HealthRiskType ||
            episode.OccurrenceCount < 2 ||
            episode.RiskLevel is not ("Warning" or "Critical") ||
            episode.LastEvaluatedWindowEndUtc.Kind != DateTimeKind.Utc ||
            snapshot.TenantId != profile.TenantId ||
            snapshot.CustomerId != profile.CustomerId ||
            snapshot.DeviceId != profile.DeviceId ||
            snapshot.ProfileId != profile.Id ||
            snapshot.ProfileVersion != profile.Version ||
            snapshot.WindowStartUtc.Kind != DateTimeKind.Utc ||
            snapshot.WindowEndUtc.Kind != DateTimeKind.Utc ||
            snapshot.WindowEndUtc != episode.LastEvaluatedWindowEndUtc ||
            snapshot.WindowEndUtc <= snapshot.WindowStartUtc ||
            snapshot.RiskLevel != episode.RiskLevel ||
            snapshot.DataQuality != "Good" ||
            snapshot.CoverageRatio < profile.MinimumCoverageRatio ||
            !double.IsFinite(snapshot.CoverageRatio) ||
            snapshot.CoverageRatio > 1 ||
            snapshot.EvaluatedPointCount < 1 ||
            snapshot.HealthIndex is not { } healthIndex ||
            !double.IsFinite(healthIndex) ||
            healthIndex is < 0 or > 100 ||
            string.IsNullOrWhiteSpace(episode.EventKey) ||
            episode.EventKey.Length > 128)
            throw new InvalidOperationException(
                "Work orders require a scoped, persistent real-field risk and verified current health window.");

        // The server's independent PdM DB is the source of this evidence,
        // never an inbound JSON body or uncalibrated synthetic classifier.
        if (episode.EvidenceJson.Length is < 2 or > 65536 ||
            episode.EvidenceJson.Contains("synthetic", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Missing or synthetic risk evidence.");
        try
        {
            using var doc = JsonDocument.Parse(episode.EvidenceJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object ||
                !doc.RootElement.EnumerateObject().Any())
                throw new InvalidOperationException("Empty risk evidence.");
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("Invalid risk evidence.");
        }
    }

    /// <summary>
    /// Must be called by a trusted server after reading profile, risk and
    /// latest snapshot from PdmDbContext. Human callers cannot supply
    /// arbitrary telemetry records. Unique SQL index enforces idempotency.
    /// </summary>
    public async Task<PdmInternalWorkOrder> OpenFromVerifiedRiskAsync(
        PdmDeviceProfile profile, PdmRiskEvent episode, PdmHealthSnapshot snapshot,
        Guid? initiatingActorId = null, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        VerifyRealRisk(profile, episode, snapshot);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var existing = await db.WorkOrders.AsNoTracking().SingleOrDefaultAsync(
            x => x.TenantId == profile.TenantId &&
                 x.CustomerId == profile.CustomerId &&
                 x.RiskEventId == episode.Id, ct);
        if (existing is not null)
        {
            if (existing.DeviceId != profile.DeviceId || existing.ProfileId != profile.Id)
                throw new InvalidOperationException("Work order episode identity collision.");
            await transaction.CommitAsync(ct);
            return existing;
        }

        var utc = DateTime.UtcNow;
        var workOrder = new PdmInternalWorkOrder
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            DeviceId = profile.DeviceId, ProfileId = profile.Id,
            ProfileVersion = profile.Version, RiskEventId = episode.Id,
            RiskSourceEventKey = episode.EventKey,
            RiskLevel = episode.RiskLevel,
            Title = (episode.RiskLevel == "Critical" ? "严重" : "预警") +
                    "设备异常 · 待检修",
            Description = "由已核验的真实设备遥测规则风险自动生成，需维修人员检查实际现场情况。",
            FirstObservedUtc = episode.FirstObservedUtc.Kind == DateTimeKind.Utc
                ? episode.FirstObservedUtc : snapshot.WindowStartUtc,
            CreatedAtUtc = utc, UpdatedAtUtc = utc
        };
        workOrder.WorkOrderNo = "PM-" + workOrder.Id.ToString("N").ToUpperInvariant();
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("|",
            "iotsharp-internal-workorder-feishu-v1",
            profile.TenantId.ToString("N"), profile.CustomerId.ToString("N"),
            episode.Id.ToString("N"))));
        var deliveryKey = "iotsharp-wo:" +
            Convert.ToHexString(digest).ToLowerInvariant();
        db.WorkOrders.Add(workOrder);
        db.Notifications.Add(new PdmInternalWorkOrderNotification
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            WorkOrderId = workOrder.Id, DeliveryKey = deliveryKey,
            CreatedAtUtc = utc
        });
        db.Audits.Add(new PdmInternalWorkOrderAudit
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            WorkOrderId = workOrder.Id, ActorId = initiatingActorId,
            Action = "CreatedFromVerifiedRisk", FromState = "",
            ToState = "Open", Reason = "持久化内部工单及飞书待发送记录", AtUtc = utc
        });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return workOrder;
    }

    /// <summary>All state changes require tenant-scoped, authenticated humans.</summary>
    public async Task<PdmInternalWorkOrder> TransitionAsync(
        Guid tenant, Guid customer, Guid id, int expectedRevision,
        string action, Guid actor, Guid? assignedTo, string reason,
        CancellationToken ct = default)
    {
        Scope(tenant, customer);
        if (id == Guid.Empty || actor == Guid.Empty || expectedRevision < 1 ||
            string.IsNullOrWhiteSpace(reason) || reason.Length > 512 ||
            action is not ("Assign" or "Start" or "Complete" or "Close"))
            throw new ArgumentException("Authenticated actor, action, version and reason required.");
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var order = await db.WorkOrders.SingleOrDefaultAsync(
            x => x.Id == id && x.TenantId == tenant && x.CustomerId == customer, ct)
            ?? throw new KeyNotFoundException("Work order not found within trusted scope.");
        if (order.Revision != expectedRevision)
            throw new DbUpdateConcurrencyException("Work order revision mismatch.");
        var previous = order.State;
        var now = DateTime.UtcNow;
        switch (action)
        {
            case "Assign" when (order.State is "Open" or "Assigned") &&
                               assignedTo is { } recipient && recipient != Guid.Empty:
                order.State = "Assigned";
                order.AssignedTo = recipient;
                break;
            case "Start" when order.State == "Assigned" && order.AssignedTo == actor:
                order.State = "InProgress";
                break;
            case "Complete" when order.State == "InProgress" && order.AssignedTo == actor:
                order.State = "Completed";
                order.CompletedAtUtc = now;
                order.Resolution = reason.Length <= 2000 ? reason : reason[..2000];
                break;
            case "Close" when order.State == "Completed":
                order.State = "Closed";
                order.ClosedAtUtc = now;
                break;
            default:
                throw new InvalidOperationException("Invalid work order transition or assigned technician.");
        }
        order.Revision++;
        order.UpdatedAtUtc = now;
        db.Audits.Add(new PdmInternalWorkOrderAudit
        {
            TenantId = tenant, CustomerId = customer, WorkOrderId = id,
            ActorId = actor, Action = action, FromState = previous,
            ToState = order.State, Reason = reason, AtUtc = now
        });
        if (action is "Complete" or "Close" &&
            config?.GetValue<bool>("PredictiveMaintenance:WorkOrders:MesSync:Enabled") == true)
        {
            if (!config.GetValue<bool>("PredictiveMaintenance:WorkOrders:MesSync:SchemaReady"))
                throw new InvalidOperationException("MES work-order outbox schema not approved.");
            // Append the message into the SAME transaction as the human transition.
            PdmWorkOrderMesProjector.Append(db, order, action, actor, now);
        }
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return order;
    }

    public Task<PdmInternalWorkOrder?> GetAsync(Guid tenant, Guid customer,
        Guid id, CancellationToken ct = default)
    {
        Scope(tenant, customer);
        return db.WorkOrders.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == id && x.TenantId == tenant && x.CustomerId == customer, ct);
    }

    /// <summary>
    /// Prepares one message for the EXISTING VOL.AI FeishuPushMCP provider.
    /// This is NOT itself delivery. A durable claim MUST be acquired first.
    /// </summary>
    public static PdmVolAiFeishuMcpHandoff PrepareFeishuNotification(
        PdmInternalWorkOrder order, PdmInternalWorkOrderNotification notice,
        PdmVolAiFeishuRoute route, DateTimeOffset nowUtc)
    {
        ArgumentNullException.ThrowIfNull(order);
        ArgumentNullException.ThrowIfNull(notice);
        ArgumentNullException.ThrowIfNull(route);
        if (order.TenantId == Guid.Empty || order.CustomerId == Guid.Empty ||
            order.DeviceId == Guid.Empty || order.Id == Guid.Empty ||
            order.TenantId != route.TenantId || order.CustomerId != route.CustomerId ||
            order.TenantId != notice.TenantId || order.CustomerId != notice.CustomerId ||
            notice.WorkOrderId != order.Id || notice.State != "Claimed" ||
            notice.ClaimedBy == null || notice.ClaimedAtUtc == null ||
            notice.DeliveryKey is not { Length: >= 20 and <= 128 } ||
            !notice.DeliveryKey.StartsWith("iotsharp-wo:", StringComparison.Ordinal) ||
            route.ApprovedBy == Guid.Empty || !route.Enabled ||
            route.ApprovedAtUtc.Offset != TimeSpan.Zero ||
            nowUtc.Offset != TimeSpan.Zero ||
            route.ApprovedAtUtc > nowUtc ||
            nowUtc - route.ApprovedAtUtc > TimeSpan.FromDays(30) ||
            !route.ExternalConversationId.StartsWith("oc_", StringComparison.Ordinal) ||
            route.ExternalConversationId.Length is < 20 or > 180 ||
            !route.ExternalConversationId.All(c =>
                char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ||
            string.IsNullOrWhiteSpace(route.ChannelAccountId) ||
            route.ChannelAccountId.Length > 120)
            throw new InvalidOperationException("No confirmed scoped internal order and approved Feishu route.");
        var content = string.Join("\n",
            "【IoTSharp 内部维修工单】",
            "工单号：" + order.WorkOrderNo,
            "设备 ID：" + order.DeviceId.ToString("N"),
            "风险级别：" + order.RiskLevel,
            "当前状态：" + order.State,
            "创建时间 UTC：" + order.CreatedAtUtc.ToString("O", CultureInfo.InvariantCulture),
            "请登录 IoTSharp 的维修工单页面接单、处理和反馈。");
        return new PdmVolAiFeishuMcpHandoff("send_feishu_message",
            content, notice.DeliveryKey, route.ChannelAccountId,
            route.ExternalConversationId);
    }

    public async Task<bool> ClaimFeishuNotificationAsync(
        Guid tenant, Guid customer, Guid noticeId, Guid workerId,
        CancellationToken ct = default)
    {
        Scope(tenant, customer);
        if (noticeId == Guid.Empty || workerId == Guid.Empty)
            throw new ArgumentException("A stable notification and worker identity are required.");
        return await db.Notifications.Where(n => n.Id == noticeId &&
                n.TenantId == tenant && n.CustomerId == customer &&
                n.Channel == "feishu" && n.State == "Pending")
            .ExecuteUpdateAsync(x => x
                .SetProperty(n => n.State, "Claimed")
                .SetProperty(n => n.ClaimedBy, workerId)
                .SetProperty(n => n.ClaimedAtUtc, DateTime.UtcNow), ct) == 1;
    }

    /// <summary>
    /// Unexpected failure or timeout -> OutcomeUnknown, never return to Pending.
    /// FeishuPushMCP's own durable delivery_key independently blocks duplicates.
    /// </summary>
    public async Task<bool> RecordFeishuResultAsync(
        Guid tenant, Guid customer, Guid noticeId, Guid workerId,
        bool confirmed, string externalMessageFingerprint,
        CancellationToken ct = default)
    {
        Scope(tenant, customer);
        if (noticeId == Guid.Empty || workerId == Guid.Empty ||
            externalMessageFingerprint is null ||
            externalMessageFingerprint.Length > 64 ||
            (confirmed && externalMessageFingerprint.Length != 64) ||
            externalMessageFingerprint.Any(c => !char.IsAsciiHexDigit(c)))
            throw new ArgumentException("Invalid delivery receipt / worker.");
        return await db.Notifications.Where(n => n.Id == noticeId &&
                n.TenantId == tenant && n.CustomerId == customer &&
                n.ClaimedBy == workerId && n.State == "Claimed")
            .ExecuteUpdateAsync(x => x
                .SetProperty(n => n.State, confirmed ? "Confirmed" : "OutcomeUnknown")
                .SetProperty(n => n.ExternalMessageFingerprint, externalMessageFingerprint)
                .SetProperty(n => n.AcknowledgedAtUtc, DateTime.UtcNow), ct) == 1;
    }
}
