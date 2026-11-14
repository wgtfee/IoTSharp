using System;

namespace IoTSharp.Data;

/// <summary>
/// PdM 试点设备配置；绑定运行实例 Device，而不是把产品模板当设备。
/// P1 首期仅持久化配置，不自动打开推理/生产写入。
/// </summary>
public sealed class PdmDeviceProfile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid? ProductId { get; set; }
    public Guid? AssetId { get; set; }
    public int Version { get; set; } = 1;
    public bool Enabled { get; set; }
    public bool PointMappingsVerified { get; set; }
    public bool RunStateVerified { get; set; }
    public string RunStateTelemetryKey { get; set; } = string.Empty;
    public int RunStateIntervalSeconds { get; set; } = 60;
    public double RunStateRunningValue { get; set; } = 1;
    public int WindowMinutes { get; set; } = 15;
    public double MinimumCoverageRatio { get; set; } = 0.8;
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 一个真实 Telemetry Key 的规则约束。单位和物理界限必须经现场确认后才能启用。
/// </summary>
public sealed class PdmPointPolicy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ProfileId { get; set; }
    public string TelemetryKey { get; set; } = string.Empty;
    public string Unit { get; set; } = string.Empty;
    public int ExpectedIntervalSeconds { get; set; } = 60;
    public double MinValidValue { get; set; }
    public double MaxValidValue { get; set; }
    public double WarningHighValue { get; set; }
    public double CriticalHighValue { get; set; }
    public double? RisingTrendPerMinute { get; set; }
    public double Weight { get; set; } = 1;
    public bool Required { get; set; } = true;
    public bool Enabled { get; set; }
}

/// <summary>
/// 一个设备一个半开时间窗口的一次评估快照。
/// Score 仅为可解释的规则指标，不是故障概率或 RUL。
/// </summary>
public sealed class PdmHealthSnapshot
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid ProfileId { get; set; }
    public int ProfileVersion { get; set; }
    public DateTime WindowStartUtc { get; set; }
    public DateTime WindowEndUtc { get; set; }
    public string DataQuality { get; set; } = "Unknown";
    public string RiskLevel { get; set; } = "Unknown";
    public double? HealthIndex { get; set; }
    public double CoverageRatio { get; set; }
    public int EvaluatedPointCount { get; set; }
    public int FailedPointCount { get; set; }
    public string ExplanationJson { get; set; } = "{}";
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}



/// <summary>
/// 未来 P1-04 风险事件持久化合同。创建/恢复/关单逻辑尚未启用。
/// EventKey 必须由可信服务器按设备、规则版本和连续事件片段确定生成。
/// </summary>
public sealed class PdmRiskEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid ProfileId { get; set; }
    public int ProfileVersion { get; set; } = 1;
    public string EventKey { get; set; } = string.Empty;
    public string RiskType { get; set; } = string.Empty;
    public string RiskLevel { get; set; } = "Unknown";
    public string Status { get; set; } = "Open";
    public DateTime FirstObservedUtc { get; set; }
    public DateTime LastObservedUtc { get; set; }
    public DateTime LastEvaluatedWindowEndUtc { get; set; }
    public int RecoveryStreak { get; set; }
    public DateTime? ClearedAtUtc { get; set; }
    public int OccurrenceCount { get; set; } = 1;
    public Guid? LinkedAlarmId { get; set; }
    public string EvidenceJson { get; set; } = "{}";
}