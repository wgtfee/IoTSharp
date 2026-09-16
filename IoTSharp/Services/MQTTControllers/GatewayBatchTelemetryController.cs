using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Services.Ingestion;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MQTTnet.AspNetCore.Routing;
using System;
using System.Buffers;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Services.MQTTControllers;

[MqttController]
[MqttRoute("gateway/{gatewayId}/telemetry")]
public sealed class GatewayBatchTelemetryController : MqttBaseController
{
    private readonly GatewayBatchIngestOptions _options;
    private readonly GatewayChildDeviceResolver _resolver;
    private readonly TelemetryIngestPipeline _telemetryIngest;
    private readonly IPublisher _publisher;
    private readonly GatewayRuntimeRegistry _gatewayRuntimeRegistry;
    private readonly GatewayActivitySignalGate _activitySignalGate;
    private readonly ILogger<GatewayBatchTelemetryController> _logger;

    public GatewayBatchTelemetryController(
        IOptions<GatewayBatchIngestOptions> options,
        GatewayChildDeviceResolver resolver,
        TelemetryIngestPipeline telemetryIngest,
        IPublisher publisher,
        GatewayRuntimeRegistry gatewayRuntimeRegistry,
        GatewayActivitySignalGate activitySignalGate,
        ILogger<GatewayBatchTelemetryController> logger)
    {
        _options = options.Value;
        _resolver = resolver;
        _telemetryIngest = telemetryIngest;
        _publisher = publisher;
        _gatewayRuntimeRegistry = gatewayRuntimeRegistry;
        _activitySignalGate = activitySignalGate;
        _logger = logger;
    }

    [MqttRoute("batch")]
    public async Task Batch(string gatewayId)
    {
        var sourceGateway = GetSessionItem<Device>();
        if (Message.Payload.Length > _options.MaxBatchBytes)
        {
            _logger.LogWarning(
                "Rejected gateway telemetry batch before deserialization. Gateway={GatewayId}, Bytes={Bytes}, Limit={Limit}",
                gatewayId,
                Message.Payload.Length,
                _options.MaxBatchBytes);
            await BadMessage();
            return;
        }

        var validation = GatewayBatchIngestValidator.Validate(
            Message.Payload.ToArray(),
            gatewayId,
            sourceGateway,
            _options);
        if (!validation.Success || validation.Batch is null)
        {
            _logger.LogWarning(
                "Rejected gateway telemetry batch. Gateway={GatewayId}, Error={Error}",
                gatewayId,
                validation.Error);
            await BadMessage();
            return;
        }

        var batch = validation.Batch;
        var childDevices = await _resolver.ResolveManyAsync(
            sourceGateway,
            batch.Devices.Select(device => device.DeviceId).ToArray());

        if (_activitySignalGate.ShouldPublish(sourceGateway))
            await _publisher.PublishActive(sourceGateway.Id, ActivityStatus.Activity);
        foreach (var item in batch.Devices)
        {
            var child = childDevices[item.DeviceId];
            await _telemetryIngest.EnqueueAsync(new PlayloadData
            {
                DeviceId = child.Id,
                ts = validation.TimestampUtc,
                MsgBody = GatewayBatchIngestValidator.ToTelemetryValues(item),
                DataSide = DataSide.ClientSide,
                DataCatalog = DataCatalog.TelemetryData
            });
        }

        await Task.WhenAll(batch.Devices
            .Select(item => childDevices[item.DeviceId])
            .Where(_activitySignalGate.ShouldPublish)
            .Select(device => _publisher.PublishActive(device.Id, ActivityStatus.Activity)));
        _gatewayRuntimeRegistry.TouchBatch(sourceGateway, batch.Devices.Count, validation.PointCount);

        _logger.LogDebug(
            "Accepted gateway telemetry batch. Gateway={GatewayId}, BatchId={BatchId}, Devices={DeviceCount}, Points={PointCount}",
            gatewayId,
            batch.BatchId,
            batch.Devices.Count,
            validation.PointCount);
        await Ok();
    }
}
