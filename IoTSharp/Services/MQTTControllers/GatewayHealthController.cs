using IoTSharp.Data;
using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MQTTnet.AspNetCore.Routing;
using MQTTnet.Protocol;
using System;
using System.Buffers;

namespace IoTSharp.Services.MQTTControllers;

[MqttController]
[MqttRoute("gateway/{gatewayId}/health")]
public sealed class GatewayHealthController : MqttBaseController
{
    private readonly GatewayHealthIngestOptions _options;
    private readonly GatewayRuntimeRegistry _registry;
    private readonly ILogger<GatewayHealthController> _logger;

    public GatewayHealthController(
        IOptions<GatewayHealthIngestOptions> options,
        GatewayRuntimeRegistry registry,
        ILogger<GatewayHealthController> logger)
    {
        _options = options.Value;
        _registry = registry;
        _logger = logger;
    }

    [MqttRoute()]
    public MqttResult Report(string gatewayId)
    {
        var sourceGateway = GetSessionItem<Device>();
        var maxBytes = Math.Max(1024, _options.MaxPayloadBytes);
        if (Message.Payload.Length > maxBytes)
            return Reject(MqttPubAckReasonCode.ImplementationSpecificError, $"Gateway health payload exceeds {maxBytes} bytes.");

        var validation = GatewayHealthValidator.Validate(Message.Payload.ToArray(), gatewayId, sourceGateway, _options);
        if (!validation.Success || validation.Report is null)
        {
            _logger.LogWarning("Rejected gateway health report. Gateway={GatewayId}, Error={Error}", gatewayId, validation.Error);
            return Reject(MqttPubAckReasonCode.PayloadFormatInvalid, validation.Error);
        }

        _registry.UpdateHealth(sourceGateway, validation.Report);
        return Suppress();
    }
}
