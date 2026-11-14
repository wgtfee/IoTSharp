using System;
using System.Collections.Generic;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public enum PdmP3ShadowState { Disabled, Unverified, ExplainableBaseline }

/// <summary>
/// Read-only statistical evidence only. Absolutely no notification,
/// work-order, device control, failure probability or RUL semantics.
/// </summary>
public sealed record PdmP3ShadowReport(
    PdmP3ShadowState State, PdmP3AnomalyFinding Finding,
    string Explanation, bool IsReadOnly = true,
    bool IsAlertDelivered = false, bool IsWorkOrderCreated = false,
    double? FailureProbability = null, TimeSpan? RemainingUsefulLife = null);

public static class PdmP3ShadowCoordinator
{
    /// <summary>
    /// Used only by an explicitly approved offline/Shadow caller; this is not
    /// registered as a HostedService, HTTP action or data store. A client must
    /// never be allowed to claim featureGateApproved on its own.
    /// </summary>
    public static PdmP3ShadowReport Evaluate(
        PdmDeviceProfile profile,
        PdmP2AdvisoryBundle existingP2,
        IReadOnlyList<PdmP3Observation> offlineHistory,
        bool featureGateApproved)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(existingP2);
        ArgumentNullException.ThrowIfNull(offlineHistory);
        var fallback = new PdmP3AnomalyFinding(
            offlineHistory.Count > 0 ? offlineHistory[0]?.Scope : null,
            offlineHistory.Count > 0 ? offlineHistory[^1]?.EventTimeUtc : null,
            PdmP3AnomalyState.Unknown, null, null, null, null, 0,
            "来源、发布门禁或连续证据尚未确认");
        PdmP3ShadowReport Block(PdmP3ShadowState state, string why) =>
            new(state, fallback, why);

        if (!featureGateApproved)
            return Block(PdmP3ShadowState.Disabled, "P3 离线影子评估未授权，禁止计算");
        if (!existingP2.IsReadOnly ||
            existingP2.Trend.Direction == PdmTrendDirection.Unknown ||
            existingP2.Trend.WindowEndUtc is null ||
            existingP2.Trend.WindowEndUtc.Value.Kind != DateTimeKind.Utc ||
            !profile.Enabled || !profile.PointMappingsVerified ||
            !profile.RunStateVerified || profile.Version < 1 ||
            profile.Id == Guid.Empty ||
            profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty ||
            profile.DeviceId == Guid.Empty)
            return Block(PdmP3ShadowState.Unverified, "P1/P2 状态或运行工况尚未完成可信校验");
        if (offlineHistory.Count == 0)
            return Block(PdmP3ShadowState.Unverified, "缺少同设备离线时间序列");
        var scope = offlineHistory[0].Scope;
        if (scope.TenantId != profile.TenantId ||
            scope.CustomerId != profile.CustomerId ||
            scope.DeviceId != profile.DeviceId ||
            scope.ProfileId != profile.Id ||
            scope.ProfileVersion != profile.Version)
            return Block(PdmP3ShadowState.Unverified, "P2 和 P3 租户、设备或配置版本不一致");
        var finding = PdmP3AnomalyDetector.Evaluate(offlineHistory);
        if (finding.State == PdmP3AnomalyState.Unknown ||
            finding.AtUtc is null ||
            finding.AtUtc.Value.UtcDateTime != existingP2.Trend.WindowEndUtc.Value)
            return new(PdmP3ShadowState.Unverified, finding,
                "离线统计窗口与可信 P2 健康窗口不一致或数据质量不足，不给出可操作结论");
        return new(PdmP3ShadowState.ExplainableBaseline, finding,
            "同一已核验设备/版本/时间窗口的离线统计结果；不修改 P2 风险状态或外部工单");
    }
}

