#nullable enable
using System;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using MQTTnet;
using MQTTnet.Protocol;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>
/// 使用 IoTSharp 现有 MQTT RPC 能力发送 Action Flow 命令。
/// RPC 响应仅视为“已接收/Ack”，Busy/Done/Fault 仍由具有 commandId/cycleId 的设备反馈推进。
/// </summary>
public sealed class TwinActionFlowRpcCommandAdapter : ITwinActionFlowCommandAdapter
{
    private readonly ApplicationDbContext _context;
    private readonly MqttClientOptions _mqttOptions;
    private readonly ILogger<TwinActionFlowRpcCommandAdapter> _logger;

    public TwinActionFlowRpcCommandAdapter(ApplicationDbContext context, MqttClientOptions mqttOptions, ILogger<TwinActionFlowRpcCommandAdapter> logger)
    {
        _context = context;
        _mqttOptions = mqttOptions;
        _logger = logger;
    }

    public async Task<TwinActionFlowCommandDispatchResult> SendAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, TwinDeviceCommand command, CancellationToken cancellationToken)
    {
        var binding = await _context.TwinObjectBindings.AsNoTracking()
            .FirstOrDefaultAsync(item => item.SceneId == run.SceneId
                && item.SceneVersionId == run.SceneVersionId
                && !item.Deleted && item.Enabled
                && item.BindingKey == command.BindingKey, cancellationToken);
        if (binding?.DeviceId == null)
            return new(false, false, null, null, $"命令绑定 {command.BindingKey} 未关联已发布 Device。");

        var device = await _context.Device.AsNoTracking()
            .Include(item => item.Owner)
            .FirstOrDefaultAsync(item => item.Id == binding.DeviceId.Value && !item.Deleted, cancellationToken);
        if (device == null)
            return new(false, false, null, null, $"命令绑定 {command.BindingKey} 对应设备不存在。");

        var method = string.IsNullOrWhiteSpace(binding.SourceKey) ? binding.SemanticId : binding.SourceKey;
        if (string.IsNullOrWhiteSpace(method))
            return new(false, false, null, null, $"命令绑定 {command.BindingKey} 缺少 RPC method/sourceKey。");

        var target = device.DeviceType == DeviceType.Device && !string.IsNullOrWhiteSpace(device.Owner?.Name)
            ? device.Name
            : device.Id.ToString();
        try
        {
            using var rpc = new RpcClient(_mqttOptions, _logger);
            await rpc.ConnectAsync();
            var responseBytes = await rpc.ExecuteAsync(TimeSpan.FromSeconds(10), target, method, command.Payload, MqttQualityOfServiceLevel.AtLeastOnce, cancellationToken);
            await rpc.DisconnectAsync();
            JsonElement? response = null;
            var text = Encoding.UTF8.GetString(responseBytes);
            if (!string.IsNullOrWhiteSpace(text))
            {
                try { using var doc = JsonDocument.Parse(text); response = doc.RootElement.Clone(); }
                catch (JsonException) { response = JsonSerializer.SerializeToElement(new { raw = text }); }
            }
            return new(true, true, null, response, null);
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Action Flow command {CommandId} dispatch failed.", command.CommandId);
            return new(false, false, null, null, exception.Message);
        }
    }

    public Task<TwinActionFlowCommandFeedback?> ReconcileAsync(TwinActionFlowRun run, TwinDeviceCommand command, CancellationToken cancellationToken)
    {
        // 现有 IoTSharp RPC 是请求/响应式，无法可靠读取设备内部 cycle 状态。
        // 因此恢复时绝不盲目重发，只保留等待并由后续带 cycleId 的遥测/回执完成对账。
        return Task.FromResult<TwinActionFlowCommandFeedback?>(null);
    }
}
