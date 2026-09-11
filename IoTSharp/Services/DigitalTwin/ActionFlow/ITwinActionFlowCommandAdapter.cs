#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using System.Text.Json;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>设备命令适配器结果。适配器只负责可靠送达设备边界，不负责推进流程状态。</summary>
public sealed record TwinActionFlowCommandDispatchResult(bool Accepted, bool Acknowledged, string? DeviceCycleId, JsonElement? Response, string? Error);

/// <summary>
/// Action Flow 与具体 PLC/WCS/机器人协议之间的稳定边界。
/// 服务端运行时只能通过该接口下发命令，浏览器不能直接写 PLC。
/// </summary>
public interface ITwinActionFlowCommandAdapter
{
    Task<TwinActionFlowCommandDispatchResult> SendAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, TwinDeviceCommand command, CancellationToken cancellationToken);

    /// <summary>恢复时读取设备状态进行对账；默认实现可返回 null 表示需要等待后续遥测。</summary>
    Task<TwinActionFlowCommandFeedback?> ReconcileAsync(TwinActionFlowRun run, TwinDeviceCommand command, CancellationToken cancellationToken);
}

/// <summary>设备回执领域合同。</summary>
public sealed record TwinActionFlowCommandFeedback(string CommandId, string CorrelationId, string? CycleId, TwinDeviceCommandStatus Status, JsonElement? Payload, DateTime OccurredAt);
