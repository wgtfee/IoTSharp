using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace IoTSharp.Contracts;

/// <summary>Action Flow 草稿校验/编译请求。</summary>
public sealed class TwinActionFlowCompileRequestDto
{
    public Guid SceneId { get; set; }
    public JsonElement Flow { get; set; }
}

/// <summary>Action Flow 服务端编译结果。</summary>
public sealed class TwinActionFlowCompileResultDto
{
    public bool Valid => Diagnostics.All(item => !string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase));
    public List<TwinValidationDiagnosticDto> Diagnostics { get; set; } = [];
    public string GraphHash { get; set; } = string.Empty;
    public string CompiledPlanHash { get; set; } = string.Empty;
    public JsonElement? CompiledPayload { get; set; }
}

/// <summary>基于不可变发布流程创建 Run。</summary>
public sealed class TwinActionFlowRunCreateDto
{
    public string IdempotencyKey { get; set; } = string.Empty;
    /// <summary>服务端生产 Run 只接受 live；simulation 由确定性客户端模拟器执行。</summary>
    public string RuntimeMode { get; set; } = "live";
    public JsonElement? Input { get; set; }
}

/// <summary>运行控制请求；人工、取消和管理操作都需要写明原因。</summary>
public sealed class TwinActionFlowRunControlDto
{
    public string? Reason { get; set; }
}

/// <summary>人工确认请求。</summary>
public sealed class TwinActionFlowManualConfirmDto
{
    public string StepInstanceId { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public JsonElement? Output { get; set; }
}

/// <summary>设备命令反馈。cycleId 用于防止旧高电平/旧周期推进新 Run。</summary>
public sealed class TwinActionFlowCommandFeedbackDto
{
    public string CommandId { get; set; } = string.Empty;
    public string CorrelationId { get; set; } = string.Empty;
    public string? CycleId { get; set; }
    public string Status { get; set; } = string.Empty;
    public JsonElement? Payload { get; set; }
    public DateTime? DeviceOccurredAt { get; set; }
}

/// <summary>绑定信号输入，供遥测/适配器桥接 Action Flow 等待节点。</summary>
public sealed class TwinActionFlowSignalDto
{
    public string BindingId { get; set; } = string.Empty;
    public string? CycleId { get; set; }
    public JsonElement Value { get; set; }
    public DateTime? DeviceOccurredAt { get; set; }
}

/// <summary>单个运行步骤快照。</summary>
public sealed class TwinActionFlowRunStepDto
{
    public Guid Id { get; set; }
    public string StepInstanceId { get; set; } = string.Empty;
    public string NodeId { get; set; } = string.Empty;
    public int Attempt { get; set; }
    public string Status { get; set; } = string.Empty;
    public JsonElement Input { get; set; }
    public JsonElement Output { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime? DeadlineAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long LastSequence { get; set; }
}

/// <summary>Action Flow 运行快照。</summary>
public sealed class TwinActionFlowRunDto
{
    public Guid Id { get; set; }
    public Guid SceneId { get; set; }
    public Guid SceneVersionId { get; set; }
    public Guid ActionFlowId { get; set; }
    public string FlowKey { get; set; } = string.Empty;
    public string IdempotencyKey { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public JsonElement Input { get; set; }
    public JsonElement Runtime { get; set; }
    public long CurrentSequence { get; set; }
    public long ConcurrencyVersion { get; set; }
    public string GraphHash { get; set; } = string.Empty;
    public string CompiledPlanHash { get; set; } = string.Empty;
    public string? FaultCode { get; set; }
    public string? FaultMessage { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public List<TwinActionFlowRunStepDto> Steps { get; set; } = [];
    public List<TwinDeviceCommandDto> Commands { get; set; } = [];
    public List<TwinResourceReservationDto> Reservations { get; set; } = [];
    public List<TwinMaterialRuntimeDto> Materials { get; set; } = [];
}

/// <summary>不可变 Run Event DTO。</summary>
public sealed class TwinActionFlowEventDto
{
    public Guid Id { get; set; }
    public Guid RunId { get; set; }
    public long Sequence { get; set; }
    public string EventType { get; set; } = string.Empty;
    public string? NodeId { get; set; }
    public string? StepInstanceId { get; set; }
    public string CorrelationId { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
    public JsonElement Payload { get; set; }
    public DateTime OccurredAt { get; set; }
}

/// <summary>设备命令快照。</summary>
public sealed class TwinDeviceCommandDto
{
    public Guid Id { get; set; }
    public string CommandId { get; set; } = string.Empty;
    public string CorrelationId { get; set; } = string.Empty;
    public string BindingKey { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? DeviceCycleId { get; set; }
    public DateTime? SentAt { get; set; }
    public DateTime? AcknowledgedAt { get; set; }
    public DateTime? BusyAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string? LastError { get; set; }
}

/// <summary>资源预留快照。</summary>
public sealed class TwinResourceReservationDto
{
    public string ReservationId { get; set; } = string.Empty;
    public string ResourceType { get; set; } = string.Empty;
    public string ResourceId { get; set; } = string.Empty;
    public Guid OwnerRunId { get; set; }
    public string Status { get; set; } = string.Empty;
    public DateTime LeaseUntil { get; set; }
    public long Revision { get; set; }
}

/// <summary>物料所有权快照。</summary>
public sealed class TwinMaterialRuntimeDto
{
    public string MaterialInstanceId { get; set; } = string.Empty;
    public string? TransportUnitId { get; set; }
    public string? MaterialType { get; set; }
    public string OwnerType { get; set; } = string.Empty;
    public string OwnerId { get; set; } = string.Empty;
    public string PoseSource { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public long Revision { get; set; }
    public long LastEventSequence { get; set; }
}
