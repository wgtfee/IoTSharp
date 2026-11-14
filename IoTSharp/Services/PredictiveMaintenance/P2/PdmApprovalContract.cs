using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmReviewPacketState { Blocked, AwaitingHumanReview }

/// <summary>
/// Audit-ready draft contract. There is deliberately no Approved, Executed,
/// Notified or WorkOrderCreated transition and no side-effecting service.
/// </summary>
public sealed record PdmReviewPacket(
    Guid TenantId, Guid CustomerId, Guid DeviceId,
    Guid ProfileId, int ProfileVersion, Guid RiskEventId,
    string Fingerprint, PdmReviewPacketState State,
    string Reason, string Title, IReadOnlyList<string> SuggestedChecks,
    bool RequiresVerifiedReviewer = true, bool RequiresAuditPersistence = true,
    bool IsAuthorizedToExecute = false, bool IsAlertDelivered = false,
    bool IsWorkOrderCreated = false);

/// <summary>
/// Builds a proposal to a future authenticated approval pipeline.
/// An idempotency fingerprint is for correlation, not for permission or delivery.
/// </summary>
public static class PdmApprovalContract
{
    public static PdmReviewPacket Prepare(
        PdmDeviceProfile profile, PdmRiskEvent activeEpisode,
        PdmP2AdvisoryBundle bundle)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(activeEpisode);
        ArgumentNullException.ThrowIfNull(bundle);

        if (profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty ||
            profile.DeviceId == Guid.Empty || profile.Id == Guid.Empty ||
            activeEpisode.Id == Guid.Empty ||
            profile.TenantId != activeEpisode.TenantId ||
            profile.CustomerId != activeEpisode.CustomerId ||
            profile.DeviceId != activeEpisode.DeviceId ||
            profile.Id != activeEpisode.ProfileId ||
            profile.Version != activeEpisode.ProfileVersion)
            throw new InvalidOperationException("审批草稿不能跨租户、客户、设备或规则版本");

        var payload = string.Join("|", "pdm-p2-review-v1",
            profile.TenantId.ToString("N"), profile.CustomerId.ToString("N"),
            profile.DeviceId.ToString("N"), profile.Id.ToString("N"),
            profile.Version, activeEpisode.Id.ToString("N"),
            activeEpisode.EventKey);
        var fingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();

        var checks = bundle.Maintenance.SuggestedChecks
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Take(8).Select(c => c.Length <= 300 ? c : c[..300]).ToArray();
        // Never treat an arbitrary in-memory draft as a persisted, trusted decision.
        var evidenceValid = false;
        if (!string.IsNullOrWhiteSpace(activeEpisode.EvidenceJson) &&
            activeEpisode.EvidenceJson.Length <= 65536)
        {
            try
            {
                using var doc = JsonDocument.Parse(activeEpisode.EvidenceJson);
                evidenceValid = doc.RootElement.ValueKind == JsonValueKind.Object &&
                    doc.RootElement.EnumerateObject().Any();
            }
            catch (JsonException) { evidenceValid = false; }
        }
        var proposalKey = bundle.Alert.IdempotencyKey;
        var proposalKeyValid = proposalKey is { Length: 64 } &&
            proposalKey.All(char.IsAsciiHexDigit);
        var sameUtcWindow = bundle.Trend.WindowEndUtc.HasValue &&
            bundle.Trend.WindowEndUtc.Value.Kind == DateTimeKind.Utc &&
            activeEpisode.LastEvaluatedWindowEndUtc.Kind == DateTimeKind.Utc &&
            bundle.Trend.WindowEndUtc.Value == activeEpisode.LastEvaluatedWindowEndUtc;
        var valid = evidenceValid && proposalKeyValid && sameUtcWindow && bundle.IsReadOnly &&
            activeEpisode.Status == "Open" &&
            profile.Enabled && profile.PointMappingsVerified && profile.RunStateVerified &&
            activeEpisode.RiskType == PdmRiskEventTransitions.HealthRiskType &&
            !string.IsNullOrWhiteSpace(activeEpisode.EventKey) &&
            bundle.Trend.Direction != PdmTrendDirection.Unknown &&
            bundle.Alert.RequiresNotificationProposal &&
            bundle.Maintenance.State == PdmAdviceState.ReadyForHumanReview &&
            bundle.Maintenance.LinkedRiskEventId == activeEpisode.Id &&
            bundle.Maintenance.DeviceId == profile.DeviceId &&
            bundle.Maintenance.RequiresHumanApproval &&
            !bundle.Maintenance.IsWorkOrderIssued &&
            checks.Length > 0 &&
            !string.IsNullOrWhiteSpace(bundle.Maintenance.Title);

        var state = valid ? PdmReviewPacketState.AwaitingHumanReview : PdmReviewPacketState.Blocked;
        var reason = valid
            ? "仅生成待审核资料，后续必须进行身份、审批权限、审计持久化及幂等写入验证"
            : "缺少可信风险、趋势、提案或审核上下文，禁止工单/通知执行";
        return new(profile.TenantId, profile.CustomerId, profile.DeviceId,
            profile.Id, profile.Version, activeEpisode.Id, fingerprint,
            state, reason, valid ? bundle.Maintenance.Title : "待核验",
            valid ? checks : Array.Empty<string>());
    }
}

