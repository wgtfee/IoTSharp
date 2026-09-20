using InfluxDB.Client;
using InfluxDB.Client.Api.Domain;
using InfluxDB.Client.Core.Flux.Domain;
using InfluxDB.Client.Writes;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.ObjectPool;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web;

namespace IoTSharp.Storage
{

    public class InfluxDBStorage : IStorage, ISplitTelemetryBatchStorage
    {
        private const int BatchTelemetryValueChunkSize = 5000;
        private readonly AppSettings _appSettings;
        private readonly ILogger _logger;
        private readonly ObjectPool<InfluxDBClient> _taospool;
        private readonly InfluxTelemetryHistoryWriter _historyWriter;
        private readonly string? _org;
        private readonly string? _bucket;
        private readonly string? _token;
        private readonly string? _latest;

        public InfluxDBStorage(
            ILogger<InfluxDBStorage> logger,
            IOptions<AppSettings> options,
            ObjectPool<InfluxDBClient> taospool,
            InfluxTelemetryHistoryWriter historyWriter)
        {
            _appSettings = options.Value;
            _logger = logger;
            _taospool = taospool;
            _historyWriter = historyWriter;
            if (_appSettings.ConnectionStrings?.TryGetValue("TelemetryStorage", out var connectionString) != true
                || string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException("ConnectionStrings:TelemetryStorage is required for InfluxDB telemetry storage.");
            }

            Uri uri = new Uri(connectionString);
            string leftPart = uri.GetLeftPart(UriPartial.Path);
            NameValueCollection nameValueCollection = HttpUtility.ParseQueryString(uri.Query);
            _org = nameValueCollection.Get("org");
            _bucket = nameValueCollection.Get("bucket");
            _token = nameValueCollection.Get("token");
            _latest = nameValueCollection.Get("latest");
            _latest ??= "-72h";
            //string logLevel = nameValueCollection.Get("logLevel");
            //string timeout = nameValueCollection.Get("timeout");
            //string readWriteTimeout = nameValueCollection.Get("readWriteTimeout");
        }

        public bool SupportsTelemetryHistoryRowReplay => _historyWriter.IsConfigured;


        public async Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
        {
            InfluxDBClient client = _taospool.Get();
            try
            {
                var query = client.GetQueryApi();
                var v = query.QueryAsync(@$"
from(bucket: ""{_bucket}"")
|> range(start: {_latest})
  |> filter(fn: (r) => r[""_measurement""] == ""TelemetryData"")
  |> filter(fn: (r) => r[""DeviceId""] == ""{deviceId}"")
  |> last()");
                return await FluxToDtoAsync(v);
            }
            finally
            {
                _taospool.Return(client);
            }
        }

        public async Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
        {
            InfluxDBClient client = _taospool.Get();
            try
            {
                var query = client.GetQueryApi();
                var kvs = from k in keys.Split(';', ',')
                          select $"r[\"_field\"] == \"{k}\"";
                var v = query.QueryAsync(@$"
from(bucket: ""{_bucket}"")
|> range(start: {_latest})
|> filter(fn: (r) => r[""_measurement""] == ""TelemetryData"")
|> filter(fn: (r) => r[""DeviceId""] == ""{deviceId}"")
|> filter(fn: (r) => {string.Join(" or ", kvs)})
|> group(columns: [""_field""])
|> last()");
                return await FluxToDtoAsync(v);
            }
            finally
            {
                _taospool.Return(client);
            }
        }



        private async Task<List<TelemetryDataDto>> FluxToDtoAsync(Task<List<FluxTable>> v)
        {
            List<TelemetryDataDto> dt = new List<TelemetryDataDto>();
            (await v)?.ForEach(ft =>
            {
                ft.Records.ForEach(fr =>
                {
                    var _frtype = ft.Columns.Find(fv => fv.Label == "_value")?.DataType;
                    if (_frtype != null)
                    {
                        var dt_iot_type = InfluxTypeToIoTSharpType(_frtype);
                        dt.Add(new TelemetryDataDto()
                        {
                            KeyName = fr.GetField(),
                            DateTime = fr.GetTimeInDateTime().GetValueOrDefault(),
                            Value = fr.GetValue(),
                            DataType = dt_iot_type
                        });
                    }

                });
            });
            return dt;
        }
        Contracts.DataType InfluxTypeToIoTSharpType(string _itype)
        {
            Contracts.DataType data = DataType.String;
            switch (_itype)
            {
                case "long":
                    data = DataType.Long;
                    break;
                case "double":
                    data = DataType.Double;
                    break;
                case "boolean":
                case "bool":
                    data = DataType.Boolean;
                    break;
                case "dateTime:RFC3339":
                    data = DataType.DateTime;
                    break;
                case "string":
                default:
                    data = DataType.String;
                    break;
            }
            return data;
        }


        /// <summary>
        /// 加载遥测数据
        /// </summary>
        /// <param name="deviceId">设备ID</param>
        /// <param name="keys">如果为空则全部 ， 否则都好分隔</param>
        /// <param name="begin">时间开始</param>
        /// <param name="end">结束</param>
        /// <param name="every">数据堆叠断面时间</param>
        /// <param name="aggregate">聚合方式</param>
        /// <returns></returns>
        public async Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate)
        {
            InfluxDBClient client = _taospool.Get();
            try
            {
                var query = client.GetQueryApi();
                var sb = new StringBuilder();
                sb.AppendLine(@$"from(bucket: ""{_bucket}"")");
                sb.AppendLine($"|> range(start: {begin.ToLocalTime():o},stop:{end.ToLocalTime():o})");
                sb.AppendLine(@$"|> filter(fn: (r) => r[""_measurement""] == ""TelemetryData"")");
                sb.AppendLine(@$"|> filter(fn: (r) => r[""DeviceId""] == ""{deviceId}"")");
                if (!string.IsNullOrEmpty(keys))
                {
                    var kvs = from k in keys.Split(';', ',')
                              select $"r[\"_field\"] == \"{k}\"";
                    sb.AppendLine(@$"|> filter(fn: (r) => {string.Join(" or ", kvs)})");
                    sb.AppendLine(@$"|> group(columns: [""_field""])");
                }
                if (every > TimeSpan.Zero && aggregate != Aggregate.None)
                {
                    sb.AppendLine($@"|> aggregateWindow(every: {(long)every.TotalMilliseconds}ms, fn: {Enum.GetName(aggregate)?.ToLower()}, createEmpty: false)");
                    sb.AppendLine(@$"|> yield(name: ""{Enum.GetName(aggregate)?.ToLower()}"")");
                }
                else
                {
                    sb.AppendLine(@$"|> yield()");
                }
                _logger.LogInformation(sb.ToString());
                var v = query.QueryAsync(sb.ToString());
                return await FluxToDtoAsync(v);
            }
            finally
            {
                _taospool.Return(client);
            }
        }

        public async Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
        {
            bool result = false;
            List<TelemetryData> telemetries = new List<TelemetryData>(); ;
            InfluxDBClient? client = null;
            try
            {
                var point = BuildPoint(msg, telemetries, out var valueCount);

                if (point != null)
                {
                    client = _taospool.Get();
                    var writeApi = client.GetWriteApiAsync();
                    await writeApi.WritePointsAsync([point]);
                }
                result = true;
                _logger.LogInformation("InfluxDB数据入库完成, 共{ValueCount}个遥测值", valueCount);

            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{msg.DeviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
            }
            finally
            {
                if (client != null)
                {
                    _taospool.Return(client);
                }
            }
            return (result, telemetries);
        }

        public Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
            => StoreTelemetryHistoryBatchAsync(messages);

        public Task<TelemetryBatchStoreResult> StoreTelemetryLatestBatchAsync(IReadOnlyCollection<PlayloadData> messages)
            => Task.FromResult(new TelemetryBatchStoreResult(true, [], messages.Count));

        public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
            => _historyWriter.WriteMessagesAsync(messages);

        public Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(
            IReadOnlyCollection<TelemetryData> rows,
            int messageCount)
            => _historyWriter.WriteRowsAsync(rows, messageCount);

        private async Task<TelemetryBatchStoreResult> StoreTelemetryBatchLegacyAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            var telemetries = new List<TelemetryData>();
            InfluxDBClient? client = null;
            try
            {
                client = _taospool.Get();
                var writeApi = client.GetWriteApiAsync();
                var points = new List<PointData>();
                var pendingValueCount = 0;
                var totalValueCount = 0;

                foreach (var msg in messages)
                {
                    var point = BuildPoint(msg, telemetries, out var valueCount);
                    if (point == null)
                    {
                        continue;
                    }

                    points.Add(point);
                    pendingValueCount += valueCount;
                    totalValueCount += valueCount;

                    if (pendingValueCount >= BatchTelemetryValueChunkSize)
                    {
                        await writeApi.WritePointsAsync(points, _bucket, _org);
                        points.Clear();
                        pendingValueCount = 0;
                    }
                }

                if (points.Count > 0)
                {
                    await writeApi.WritePointsAsync(points, _bucket, _org);
                }

                _logger.LogInformation("InfluxDB telemetry batch write completed. Messages={Messages}, Values={Values}", messages.Count, totalValueCount);
                return new TelemetryBatchStoreResult(true, telemetries, messages.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "InfluxDB telemetry batch write failed. Messages={Messages}, ValuesPrepared={Values}", messages.Count, telemetries.Count);
                return new TelemetryBatchStoreResult(false, telemetries, messages.Count);
            }
            finally
            {
                if (client != null)
                {
                    _taospool.Return(client);
                }
            }
        }

        private static PointData? BuildPoint(PlayloadData msg, List<TelemetryData> telemetries, out int valueCount)
        {
            var point = PointData.Measurement(nameof(TelemetryData))
                .Tag("DeviceId", msg.DeviceId.ToString());
            valueCount = 0;

            foreach (var kp in msg.MsgBody)
            {
                if (kp.Value == null)
                {
                    continue;
                }

                var tdata = new TelemetryData
                {
                    DateTime = msg.ts,
                    DeviceId = msg.DeviceId,
                    KeyName = kp.Key,
                    Value_DateTime = DateTime.UnixEpoch
                };
                tdata.FillKVToMe(kp);

                var added = true;
                switch (tdata.Type)
                {
                    case DataType.Boolean:
                        if (tdata.Value_Boolean.HasValue) point = point.Field(tdata.KeyName, tdata.Value_Boolean.Value); else added = false;
                        break;
                    case DataType.String:
                        point = point.Field(tdata.KeyName, tdata.Value_String);
                        break;
                    case DataType.Long:
                        if (tdata.Value_Long.HasValue) point = point.Field(tdata.KeyName, tdata.Value_Long.Value); else added = false;
                        break;
                    case DataType.Double:
                        if (tdata.Value_Double.HasValue) point = point.Field(tdata.KeyName, tdata.Value_Double.Value); else added = false;
                        break;
                    case DataType.Json:
                        point = point.Field(tdata.KeyName, tdata.Value_Json);
                        break;
                    case DataType.XML:
                        point = point.Field(tdata.KeyName, tdata.Value_XML);
                        break;
                    case DataType.Binary:
                        point = point.Field(tdata.KeyName, Hex.BytesToHex(tdata.Value_Binary));
                        break;
                    case DataType.DateTime:
                        if (tdata.Value_DateTime.HasValue)
                            point = point.Field(tdata.KeyName, tdata.Value_DateTime.Value.Subtract(DateTime.UnixEpoch).TotalMilliseconds);
                        else
                            added = false;
                        break;
                    default:
                        added = false;
                        break;
                }

                if (!added)
                {
                    continue;
                }

                telemetries.Add(tdata);
                valueCount++;
            }

            return valueCount == 0
                ? null
                : point.Timestamp(msg.ts.ToUniversalTime(), WritePrecision.Ns);
        }

        public Task<bool> CheckTelemetryStorage()
        {
            return Task.FromResult(true);
        }
    }
}