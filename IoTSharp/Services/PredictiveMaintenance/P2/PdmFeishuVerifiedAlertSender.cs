using System;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// Optional verified field-rule notification transport, NOT wired into the
/// application host or any worker by default. Caller MUST supply its own
/// approved, durable claim/unknown-result reconciliation mechanism.
/// This Feishu message is never a repair order or an alarm receipt in IoTSharp.
/// </summary>
public sealed record PdmFieldAlertNotification(
    Guid TenantId, Guid CustomerId, Guid DeviceId,
    Guid ProfileId, int ProfileVersion, string EventKey,
    string ProposalKey, PdmRiskLevel Risk, DateTimeOffset WindowEndUtc,
    bool PhysicalSensorMappingsApproved,
    bool OperatingStateApproved,
    bool SourceIsRealFieldTelemetry,
    bool ApprovalGateSatisfied,
    bool IsSynthetic = false);

public sealed record PdmFeishuDeliveryResult(
    bool FeishuAccepted, bool IsExternalWorkOrderCreated = false,
    bool IsIoTSharpAlarmPersisted = false);

public sealed class PdmFeishuVerifiedAlertSender(HttpClient http)
{
    /// <summary>
    /// Use this factory for any permitted live webhook integration. Redirects
    /// MUST be disabled so a compromised Feishu response cannot forward a
    /// secret webhook URL or alert content to an unrelated host.
    /// The injected HttpClient constructor is for test transports only.
    /// </summary>
    public static PdmFeishuVerifiedAlertSender CreateRedirectSafeClient() =>
        new(new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false
        })
        {
            Timeout = TimeSpan.FromSeconds(10)
        });

    /// <summary>Only the official Feishu/Lark group-bot webhook endpoint is accepted.</summary>
    public async Task<PdmFeishuDeliveryResult> SendAsync(
        Uri webhook, PdmFieldAlertNotification input,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(webhook);
        ArgumentNullException.ThrowIfNull(input);
        if (!webhook.IsAbsoluteUri ||
            webhook.Scheme != Uri.UriSchemeHttps ||
            webhook.Port != 443 || !string.IsNullOrEmpty(webhook.UserInfo) ||
            !string.IsNullOrEmpty(webhook.Query) ||
            !string.IsNullOrEmpty(webhook.Fragment) ||
            webhook.Host is not ("open.feishu.cn" or "open.larksuite.com") ||
            !webhook.AbsolutePath.StartsWith("/open-apis/bot/v2/hook/", StringComparison.Ordinal) ||
            webhook.AbsolutePath["/open-apis/bot/v2/hook/".Length..] is not { Length: >= 16 and <= 180 } secret ||
            secret.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_'))
            throw new InvalidOperationException("An explicitly approved Feishu/Lark HTTPS group-bot webhook is required.");

        if (!input.PhysicalSensorMappingsApproved ||
            !input.OperatingStateApproved ||
            !input.SourceIsRealFieldTelemetry ||
            !input.ApprovalGateSatisfied ||
            input.IsSynthetic ||
            input.TenantId == Guid.Empty ||
            input.CustomerId == Guid.Empty ||
            input.DeviceId == Guid.Empty ||
            input.ProfileId == Guid.Empty ||
            input.ProfileVersion < 1 ||
            input.WindowEndUtc.Offset != TimeSpan.Zero ||
            input.Risk is not (PdmRiskLevel.Warning or PdmRiskLevel.Critical) ||
            string.IsNullOrWhiteSpace(input.EventKey) ||
            input.EventKey.Length > 128 ||
            input.ProposalKey is not { Length: 64 } ||
            input.ProposalKey.Any(c => !char.IsAsciiHexDigit(c)))
            throw new InvalidOperationException(
                "Only approved, non-synthetic, real field P1/P2 alert proposals can be sent.");

        // Deliberately omit tenant/customer IDs, personal information, raw
        // sensor values, device names and API secrets from Feishu message text.
        var text = string.Join("\n",
            "【IoTSharp 设备健康告警】",
            "等级：" + input.Risk,
            "设备标识：" + input.DeviceId.ToString("N"),
            "事件相关键：" + input.ProposalKey.ToLowerInvariant(),
            "评估时间（UTC）：" + input.WindowEndUtc.ToString("O"),
            "来源：现场已核验规则风险；请在 IoTSharp 授权页面查看详情。",
            "提示：此消息不是维修工单，也不代表外部系统已建单。");
        using var request = new HttpRequestMessage(HttpMethod.Post, webhook)
        {
            Content = JsonContent.Create(new
            {
                msg_type = "text",
                content = new { text }
            })
        };
        // No automatic retries. A timeout could mean Feishu did accept the
        // first send; the caller must reconcile from durable unknown state.
        using var response = await http.SendAsync(request,
            HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(
                "Feishu returned HTTP failure; delivery state is unknown, do not automatically retry.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream,
            new JsonDocumentOptions { MaxDepth = 8 }, ct);
        if (!document.RootElement.TryGetProperty("code", out var code) ||
            code.ValueKind != JsonValueKind.Number || !code.TryGetInt32(out var value) ||
            value != 0)
            throw new InvalidOperationException(
                "Feishu acknowledgement missing or failed; delivery must be reconciled manually.");
        return new(true);
    }
}
