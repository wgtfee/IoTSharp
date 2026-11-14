using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// A trusted managed FeishuPushMCP caller, NOT a direct webhook or shell command.
/// Implementations must call the already registered send_feishu_message tool
/// using exactly ToolArguments(), and pass its existing durable delivery_key.
/// No production implementation is registered until MCP provider is authorized.
/// </summary>
public interface IPdmManagedFeishuMcpSender
{
    Task<PdmManagedFeishuSendResult> SendAsync(
        PdmVolAiFeishuMcpHandoff message, CancellationToken cancellationToken);
}

public sealed record PdmManagedFeishuSendResult(
    bool Delivered, string ExternalMessageSha256);

public sealed record PdmWorkOrderDeliveryOutcome(
    bool Claimed, bool Confirmed, bool OutcomeUnknown);

/// <summary>
/// Local SQL Server durable claim -> managed FeishuPushMCP -> receipt.
/// A timeout/crash after claim NEVER permits blind automatic resend.
/// This coordinator is only activated by an independently approved scheduler
/// and recipient mapping. It does not create external maintenance tickets.
/// </summary>
public sealed class PdmInternalWorkOrderFeishuDispatcher(
    PdmInternalWorkOrderDbContext db,
    PdmInternalWorkOrderService orders,
    IPdmManagedFeishuMcpSender sender)
{
    public async Task<PdmWorkOrderDeliveryOutcome> DispatchOneAsync(
        Guid tenant, Guid customer, Guid notificationId, Guid workerId,
        PdmVolAiFeishuRoute approvedRoute, DateTimeOffset nowUtc,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(approvedRoute);
        if (tenant == Guid.Empty || customer == Guid.Empty ||
            notificationId == Guid.Empty || workerId == Guid.Empty ||
            approvedRoute.TenantId != tenant ||
            approvedRoute.CustomerId != customer ||
            !approvedRoute.Enabled || approvedRoute.ApprovedBy == Guid.Empty ||
            approvedRoute.ApprovedAtUtc.Offset != TimeSpan.Zero ||
            nowUtc.Offset != TimeSpan.Zero ||
            approvedRoute.ApprovedAtUtc > nowUtc ||
            nowUtc - approvedRoute.ApprovedAtUtc > TimeSpan.FromDays(30) ||
            string.IsNullOrWhiteSpace(approvedRoute.ChannelAccountId) ||
            !approvedRoute.ExternalConversationId.StartsWith("oc_", StringComparison.Ordinal))
            throw new UnauthorizedAccessException("Approved scoped Feishu routing is required.");

        // Read-only preflight prevents reserving a ticket for a nonexistent
        // recipient, wrong tenant, invalid notification or nonexistent order.
        var before = await db.Notifications.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == notificationId && x.TenantId == tenant &&
                 x.CustomerId == customer, ct);
        if (before is null || before.State != "Pending")
            return new(false, false, false);
        var order = await db.WorkOrders.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == before.WorkOrderId && x.TenantId == tenant &&
                 x.CustomerId == customer, ct);
        if (order is null) throw new InvalidOperationException("Internal order is missing.");

        if (!await orders.ClaimFeishuNotificationAsync(
                tenant, customer, notificationId, workerId, ct))
            return new(false, false, false);

        // After this point ANY exception is conservatively OutcomeUnknown.
        try
        {
            var claimed = await db.Notifications.AsNoTracking().SingleAsync(
                x => x.Id == notificationId && x.TenantId == tenant &&
                     x.CustomerId == customer && x.ClaimedBy == workerId, ct);
            var message = PdmInternalWorkOrderService.PrepareFeishuNotification(
                order, claimed, approvedRoute, nowUtc);
            var receipt = await sender.SendAsync(message, ct);
            if (!receipt.Delivered || receipt.ExternalMessageSha256 is not { Length: 64 } ||
                receipt.ExternalMessageSha256.Any(c => !char.IsAsciiHexDigit(c)))
                throw new InvalidOperationException(
                    "Feishu MCP did not return a trustworthy confirmed receipt.");
            if (!await orders.RecordFeishuResultAsync(
                    tenant, customer, notificationId, workerId, true,
                    receipt.ExternalMessageSha256, ct))
                throw new InvalidOperationException("Feishu delivery acknowledgement journal conflict.");
            return new(true, true, false);
        }
        catch
        {
            // Cancellation of caller does not cancel mandatory conservative
            // local reconciliation write. No retries, regardless of outcome.
            try
            {
                await orders.RecordFeishuResultAsync(
                    tenant, customer, notificationId, workerId, false, "",
                    CancellationToken.None);
            }
            catch
            {
                // Claimed still blocks duplicate send; alert operators to
                // reconcile this notification manually.
            }
            throw;
        }
    }
}
