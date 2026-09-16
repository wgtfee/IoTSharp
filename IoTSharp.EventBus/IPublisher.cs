using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using System.Dynamic;

namespace IoTSharp.EventBus
{
    public interface IPublisher
    {
        public Task<EventBusMetrics> GetMetrics();
        public Task PublishCreateDevice(Guid devid);
        public Task PublishDeleteDevice(Guid devid);

        public Task PublishAttributeData(PlayloadData msg);
        public Task PublishTelemetryData(PlayloadData msg);

        /// <summary>
        /// 批量发布遥测。未实现专用批量协议的 EventBus 默认按顺序回退到单条发布。
        /// </summary>
        public async Task PublishTelemetryDataBatch(IReadOnlyCollection<PlayloadData> messages)
        {
            foreach (var message in messages)
            {
                await PublishTelemetryData(message);
            }
        }

        public Task PublishConnect(Guid devid, ConnectStatus devicestatus);
        public Task PublishActive(Guid devid, ActivityStatus activity);
        public Task PublishDeviceAlarm(CreateAlarmDto alarmDto);
    }
}