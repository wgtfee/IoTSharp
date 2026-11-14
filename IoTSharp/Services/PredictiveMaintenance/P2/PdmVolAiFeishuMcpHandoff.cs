using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// An independently approved, explicit VOL.AI Feishu route. Never select the
/// "most recently active" chat for unattended industrial notifications.
/// Channel secrets remain managed by VOL.AI, not by IoTSharp.
/// </summary>
public sealed record PdmVolAiFeishuRoute(
    Guid TenantId, Guid CustomerId,
    string ChannelAccountId, string ExternalConversationId,
    Guid ApprovedBy, DateTimeOffset ApprovedAtUtc, bool Enabled);

/// <summary>
/// Typed arguments for FeishuPushMCP's EXISTING send_feishu_message tool.
/// This handoff does not invoke MCP, persist an outbox, or send any message.
/// The caller must first hold an authorized, durable, unique SQL Server outbox
/// claim, and record any unknown delivery outcome for manual reconciliation.
/// </summary>
public sealed record PdmVolAiFeishuMcpHandoff(
    string ToolName, string Content, string DeliveryKey,
    string AccountId, string ChatId,
    bool IsDeliveryConfirmed = false,
    bool IsExternalWorkOrderCreated = false)
{
    public IReadOnlyDictionary<string, string> ToolArguments() =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["content"] = Content,
            ["delivery_key"] = DeliveryKey,
            ["account_id"] = AccountId,
            ["chat_id"] = ChatId
        };
}

/// <summary>
/// Prepares a safe payload for the existing VOL.AI/FeishuPushMCP provider.
/// Deliberately NOT registered in production DI. This does not replace
/// validated real-world telemetry evidence or production SQL Server outbox.
/// </summary>
public static class PdmVolAiFeishuMcpHandoffFactory
{
    public static PdmVolAiFeishuMcpHandoff Prepare(
        PdmFieldAlertNotification alert, PdmVolAiFeishuRoute route,
        DateTimeOffset nowUtc)
    {
        ArgumentNullException.ThrowIfNull(alert);
        ArgumentNullException.ThrowIfNull(route);
        if (nowUtc.Offset != TimeSpan.Zero ||
            alert.WindowEndUtc.Offset != TimeSpan.Zero ||
            alert.WindowEndUtc == default ||
            alert.WindowEndUtc > nowUtc ||
            nowUtc - alert.WindowEndUtc > TimeSpan.FromHours(24))
            throw new InvalidOperationException("Alert window must be trusted, UTC and recent.");

        if (alert.TenantId == Guid.Empty || alert.CustomerId == Guid.Empty ||
            alert.DeviceId == Guid.Empty || alert.ProfileId == Guid.Empty ||
            alert.ProfileVersion < 1 ||
            alert.TenantId != route.TenantId ||
            alert.CustomerId != route.CustomerId ||
            !alert.PhysicalSensorMappingsApproved ||
            !alert.OperatingStateApproved ||
            !alert.SourceIsRealFieldTelemetry ||
            !alert.ApprovalGateSatisfied ||
            alert.IsSynthetic ||
            alert.Risk is not (PdmRiskLevel.Warning or PdmRiskLevel.Critical) ||
            string.IsNullOrWhiteSpace(alert.EventKey) || alert.EventKey.Length > 128 ||
            alert.ProposalKey is not { Length: 64 } ||
            alert.ProposalKey.Any(c => !char.IsAsciiHexDigit(c)))
            throw new InvalidOperationException("No verified, scope-matched real-field alert proposal.");

        if (!route.Enabled || route.ApprovedBy == Guid.Empty ||
            route.ApprovedAtUtc.Offset != TimeSpan.Zero ||
            route.ApprovedAtUtc > nowUtc ||
            nowUtc - route.ApprovedAtUtc > TimeSpan.FromDays(30) ||
            string.IsNullOrWhiteSpace(route.ChannelAccountId) ||
            route.ChannelAccountId.Length > 120 ||
            string.IsNullOrWhiteSpace(route.ExternalConversationId) ||
            route.ExternalConversationId.Length is < 20 or > 180 ||
            !route.ExternalConversationId.StartsWith("oc_", StringComparison.Ordinal) ||
            !route.ExternalConversationId.All(c => char.IsAsciiLetterOrDigit(c) ||
                c is '_' or '-'))
            throw new InvalidOperationException(
                "An approved, recent, explicit Feishu conversation and account are required.");

        // delivery_key is deterministic across crashes/retries. FeishuPushMCP
        // reserves it before the first HTTP POST, and refuses ambiguous resends.
        var key = "iotsharp-pdm:" + alert.ProposalKey.ToLowerInvariant();
        var text = string.Join("\n",
            "【IoTSharp 现场设备风险告警】",
            "等级：" + alert.Risk,
            "设备 ID：" + alert.DeviceId.ToString("N"),
            "规则版本：" + alert.ProfileVersion.ToString(CultureInfo.InvariantCulture),
            "评估 UTC：" + alert.WindowEndUtc.ToString("O", CultureInfo.InvariantCulture),
            "告警相关键：" + alert.ProposalKey.ToLowerInvariant(),
            "请在 IoTSharp 已授权界面复核真实告警证据。",
            "此消息不是维修工单，也不代表实际维修系统已建单。");
        return new("send_feishu_message", text, key,
            route.ChannelAccountId, route.ExternalConversationId);
    }
}
