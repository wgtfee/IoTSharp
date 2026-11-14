using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmMeasurementCategory { Unclassified, Temperature, Vibration, MotorCurrent, Pressure }
public enum PdmAdviceState { NotApplicable, NeedsDataVerification, ReadyForHumanReview }

/// <summary>
/// Read-only recommendation draft. Every action needs a human review before any work order.
/// No control instructions, automated work order or predictive failure probability.
/// </summary>
public sealed record PdmMaintenanceDraft(
    PdmAdviceState State, Guid? LinkedRiskEventId, Guid DeviceId,
    string Title, string Explanation, IReadOnlyList<string> SuggestedChecks,
    bool RequiresHumanApproval = true, bool IsWorkOrderIssued = false,
    double? FailureProbability = null, TimeSpan? RemainingUsefulLife = null);

public static class PdmMaintenanceAdvisor
{
    private static bool HasStructuredEvidence(string? evidence)
    {
        if (string.IsNullOrWhiteSpace(evidence) || evidence.Length > 65536)
            return false;
        try
        {
            using var doc = JsonDocument.Parse(evidence);
            return doc.RootElement.ValueKind == JsonValueKind.Object &&
                   doc.RootElement.EnumerateObject().Any();
        }
        catch (JsonException) { return false; }
    }
    public static PdmMaintenanceDraft Propose(
        PdmDeviceProfile profile, PdmRiskEvent episode,
        PdmMeasurementCategory explicitlyVerifiedCategory,
        bool evidenceVerified)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(episode);

        PdmMaintenanceDraft Result(PdmAdviceState state, string title, string explanation,
            params string[] checks) => new(state, episode.Id, profile.DeviceId,
                title, explanation, checks);

        if (profile.Id == Guid.Empty || profile.TenantId == Guid.Empty ||
            profile.CustomerId == Guid.Empty || profile.DeviceId == Guid.Empty ||
            profile.Id != episode.ProfileId ||
            profile.TenantId != episode.TenantId ||
            profile.CustomerId != episode.CustomerId ||
            profile.DeviceId != episode.DeviceId ||
            profile.Version != episode.ProfileVersion)
            throw new InvalidOperationException("PdM maintenance advice cannot mix tenants, devices or versions.");

        if (episode.Status == "Cleared")
            return Result(PdmAdviceState.NotApplicable,
                "风险已解除", "无需生成新的维护建议；保留历史记录供追溯");
        if (episode.Status != "Open")
            return Result(PdmAdviceState.NeedsDataVerification,
                "风险状态未知", "先核对事件生命周期与来源");

        if (!profile.Enabled || !profile.PointMappingsVerified ||
            !profile.RunStateVerified || !evidenceVerified ||
            explicitlyVerifiedCategory == PdmMeasurementCategory.Unclassified ||
            !HasStructuredEvidence(episode.EvidenceJson))
            return Result(PdmAdviceState.NeedsDataVerification,
                "先核验传感器与工况", "尚未具备可信的维护建议依据",
                "核对设备、监测点位、测量单位和运行状态", "复核历史数据质量及异常证据");

        if (episode.RiskLevel is not ("Warning" or "Critical" or "Attention"))
            return Result(PdmAdviceState.NotApplicable,
                "没有需要处理的可信风险", "当前风险级别不支持生成维护提案");

        var checks = explicitlyVerifiedCategory switch
        {
            PdmMeasurementCategory.Temperature => new[]
            {
                "复核温度传感器测量值与安装位置",
                "安排授权人员检查散热、通风和实际负载",
                "核对设备运行工况并记录复测结果"
            },
            PdmMeasurementCategory.Vibration => new[]
            {
                "核对振动点位、方向和安装紧固状态",
                "安排授权人员检查振动、轴承与机构紧固件",
                "比较同工况下历史趋势并记录复测结果"
            },
            PdmMeasurementCategory.MotorCurrent => new[]
            {
                "核对电流互感器、量程及运行负载",
                "由授权人员检查机械负载与电气异常",
                "记录电流与运行状态的对应历史"
            },
            PdmMeasurementCategory.Pressure => new[]
            {
                "核对压力传感器量程、安装点和介质条件",
                "由授权人员检查压力变化原因及相关工况",
                "记录复核结果，遵循现场安全操作规范"
            },
            _ => Array.Empty<string>()
        };
        var urgent = episode.RiskLevel == "Critical";
        return Result(PdmAdviceState.ReadyForHumanReview,
            urgent ? "严重风险：建议优先现场复核" : "设备异常：生成待审核维护建议",
            "本建议来自经核验点位的规则风险，并非故障确定诊断；不得直接下发控制指令或自动创建工单。",
            checks);
    }
}

