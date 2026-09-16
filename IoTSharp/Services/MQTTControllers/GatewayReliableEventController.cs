using IoTSharp.Data;
using IoTSharp.Services.Ingestion;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MQTTnet;
using MQTTnet.AspNetCore.Routing;
using MQTTnet.Protocol;
using System;
using System.Buffers;
using System.Text.Json;
using System.Threading.Tasks;

namespace IoTSharp.Services.MQTTControllers;

[MqttController]
[MqttRoute("gateway/{gatewayId}/events")]
public sealed class GatewayReliableEventController : MqttBaseController
{
    private readonly ReliableEventOptions _options;
    private readonly ReliableEventProcessor _processor;
    private readonly GatewayRuntimeRegistry _gatewayRuntimeRegistry;
    private readonly ILogger<GatewayReliableEventController> _logger;

    public GatewayReliableEventController(
        IOptions<ReliableEventOptions> options,
        ReliableEventProcessor processor,
        GatewayRuntimeRegistry gatewayRuntimeRegistry,
        ILogger<GatewayReliableEventController> logger)
    {
        _options = options.Value;
        _processor = processor;
        _gatewayRuntimeRegistry = gatewayRuntimeRegistry;
        _logger = logger;
    }

    [MqttRoute()]
    public async Task<MqttResult> PublishEvent(string gatewayId)
    {
        var gateway = GetSessionItem<Device>();
        var maxPayloadBytes = Math.Max(1024, _options.MaxPayloadBytes);
        if (Message.Payload.Length > maxPayloadBytes)
        {
            _logger.LogWarning(
                "Rejected oversized reliable event before payload copy. Gateway={GatewayId}, Bytes={Bytes}, Limit={Limit}",
                gatewayId,
                Message.Payload.Length,
                maxPayloadBytes);
            return Reject(MqttPubAckReasonCode.ImplementationSpecificError, $"Reliable event payload exceeds {maxPayloadBytes} bytes.");
        }

        var validation = ReliableEventParserValidator.Validate(
            Message.Payload.ToArray(),
            gatewayId,
            gateway,
            _options);
        if (!validation.Success || validation.Event is null)
        {
            _logger.LogWarning("Rejected reliable event. Gateway={GatewayId}, Error={Error}", gatewayId, validation.Error);
            return Reject(MapReason(validation.Failure), validation.Error);
        }

        _gatewayRuntimeRegistry.TouchActivity(gateway);

        var result = await _processor.ProcessAsync(gateway, validation.Event, validation.PayloadHash);
        if (!result.Success)
        {
            _logger.LogWarning(
                "Reliable event was not acknowledged. Gateway={GatewayId}, EventId={EventId}, Conflict={Conflict}, Error={Error}",
                gatewayId,
                validation.Event.EventId,
                result.Conflict,
                result.Message);
            return Reject(
                result.Conflict ? MqttPubAckReasonCode.ImplementationSpecificError : MqttPubAckReasonCode.UnspecifiedError,
                result.Message);
        }

        var ack = new ReliableEventAck
        {
            Version = _options.Version <= 0 ? 1 : _options.Version,
            GatewayId = validation.Event.GatewayId,
            EventId = validation.Event.EventId,
            Success = true,
            Duplicate = result.Duplicate,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Message = result.Message
        };
        var message = new MqttApplicationMessageBuilder()
            .WithTopic($"gateway/{gatewayId}/events/ack")
            .WithPayload(JsonSerializer.SerializeToUtf8Bytes(ack))
            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
            .Build();
        return Publish(message, MqttInboundPublishDisposition.Suppress);
    }

    private static MqttPubAckReasonCode MapReason(ReliableEventValidationFailure failure)
        => failure switch
        {
            ReliableEventValidationFailure.Unauthorized => MqttPubAckReasonCode.NotAuthorized,
            ReliableEventValidationFailure.Malformed => MqttPubAckReasonCode.PayloadFormatInvalid,
            ReliableEventValidationFailure.TooLarge => MqttPubAckReasonCode.ImplementationSpecificError,
            ReliableEventValidationFailure.Unsupported => MqttPubAckReasonCode.ImplementationSpecificError,
            _ => MqttPubAckReasonCode.UnspecifiedError
        };
}
