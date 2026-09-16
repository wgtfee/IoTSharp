using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.EventBus;
using IoTSharp.Extensions;
using IoTSharp.Services.TelemetryIngest;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MQTTnet.AspNetCore.Routing;
using System;
using System.Buffers;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace IoTSharp.Services.MQTTControllers
{
    [MqttController]
    [MqttRoute("devices/{devname}/[controller]")]
    public class TelemetryController : MqttBaseController
    {
        private readonly ILogger _logger;
        private readonly IServiceScopeFactory _scopeFactor;
        private readonly IPublisher _queue;
        private readonly TelemetryIngestPipeline _telemetryIngest;
        private string _devname;
        private Device _sourceDevice;
        private Device device;

        public TelemetryController(
            ILogger<TelemetryController> logger,
            IServiceScopeFactory scopeFactor,
            IPublisher queue,
            TelemetryIngestPipeline telemetryIngest)
        {
            _logger = logger;
            _scopeFactor = scopeFactor;
            _queue = queue;
            _telemetryIngest = telemetryIngest;
        }

        public string devname
        {
            get => _devname;
            set
            {
                _devname = value;
                _sourceDevice = GetSessionItem<Device>();
                device = _sourceDevice.JudgeOrCreateNewDevice(devname, _scopeFactor, _logger);
            }
        }

        [MqttRoute("xml/{keyname}")]
        public async Task telemetry_xml(string keyname)
        {
            try
            {
                var xml = new System.Xml.XmlDocument();
                xml.LoadXml(System.Text.Encoding.UTF8.GetString(Message.Payload.ToArray()));
                await PublishAsync(new Dictionary<string, object> { [keyname] = xml });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "{Message}", ex.Message);
            }

            await Ok();
        }

        [MqttRoute("binary/{keyname}")]
        public async Task telemetry_binary(string keyname)
        {
            try
            {
                await PublishAsync(new Dictionary<string, object> { [keyname] = Message.Payload.ToArray() });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "{Message}", ex.Message);
            }

            await Ok();
        }

        [MqttRoute()]
        public async Task telemetry()
        {
            try
            {
                if (Message.Payload.Length > 0)
                {
                    await PublishAsync(Message.ConvertPayloadToDictionary());
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "{Message}", ex.Message);
            }

            await Ok();
        }

        /// <summary>
        /// 标记接入端活跃并把遥测放入有界接入管道。
        /// </summary>
        private async Task PublishAsync(Dictionary<string, object> values)
        {
            await _queue.PublishActive(_sourceDevice.Id, ActivityStatus.Activity);
            if (_sourceDevice.DeviceType == DeviceType.Gateway && device.Id != _sourceDevice.Id)
            {
                await _queue.PublishActive(device.Id, ActivityStatus.Activity);
            }

            await _telemetryIngest.EnqueueAsync(new PlayloadData
            {
                DeviceId = device.Id,
                MsgBody = values,
                DataSide = DataSide.ClientSide,
                DataCatalog = DataCatalog.TelemetryData
            });
        }
    }
}
