using Apache.IoTDB;
using Apache.IoTDB.Data;
using Apache.IoTDB.DataStructure;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace IoTSharp.Storage
{
    public class IoTDBStorage : IStorage, ISplitTelemetryBatchStorage
    {
        private const int BatchMessageChunkSize = 1000;
        private const int BatchTelemetryValueChunkSize = 5000;
        private readonly AppSettings _appSettings;
        private readonly ILogger _logger;
        private readonly Apache.IoTDB.SessionPool _session;
        private readonly IoTDBConnection _ioTDB;
        private readonly IoTDBTelemetryHistoryWriter _historyWriter;
        private readonly string _StorageGroupName;
        public IoTDBStorage(
            ILogger<IoTDBStorage> logger,
            IOptions<AppSettings> options,
            IoTDBConnection ioTDB,
            IoTDBTelemetryHistoryWriter historyWriter
            )
        {
            _appSettings = options.Value;
            _logger = logger;
            _session = ioTDB.SessionPool;
            _ioTDB = ioTDB;
            _historyWriter = historyWriter;
            _StorageGroupName = ResolveStorageGroupName(_appSettings.ConnectionStrings?["TelemetryStorage"]);
        }

        public bool SupportsTelemetryHistoryRowReplay => _historyWriter.IsConfigured;
        public async Task<bool> CheckTelemetryStorage()
        {
            bool _ok = _session.IsOpen();
            if (!_session.IsOpen())
            {
                _ok = Retry.RetryOnAny(10, f =>
                {
                    _session.Open().Wait(TimeSpan.FromMilliseconds(100));
                    return true;
                }, ef =>
                {
                    _logger.LogError(ef.ex, $" open iotdb error。{ef.current}次失败{ef.ex.Message} {ef.ex.InnerException?.Message} ");
                });
            }
            if (_ok)
            {
                try
                {
                    var groupName = $"root.{_StorageGroupName}";
                    using var query = await _session.ExecuteQueryStatementAsync($"show storage group {groupName}");//判断存储组是否已经存在
                    if (query.HasNext())
                    {
                        //存储组已经存在，无需处理
                    }
                    else
                    {
                        await _session.CreateDatabase(groupName);
                    }
                }
                catch (Exception ex)
                {
                    _ok = false;
                    _logger.LogWarning(ex, "无法存储时序数据。");
                }
            }
            return _ok;
        }

        private static string ResolveStorageGroupName(string? connectionString)
        {
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                return "iotsharp";
            }

            foreach (var item in connectionString.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var pair = item.Split('=', 2, StringSplitOptions.TrimEntries);
                if (pair.Length == 2
                    && pair[0].Equals("DefaultGroupName", StringComparison.OrdinalIgnoreCase)
                    && !string.IsNullOrWhiteSpace(pair[1]))
                {
                    return pair[1];
                }
            }

            return "iotsharp";
        }


        private async Task<List<MapItem>> GetIotDbMeasurementPointInfor(string device, string measureKeys = "*")
        {
            //show timeseries root.iotsharp.8984003f7016487db7f26528b246198f.**\
            var keylist = measureKeys.Split(';', ',').ToList();
            var sql = $"show timeseries  {device}.**";
            List<MapItem> dt = new List<MapItem>();
            var query = await _session.ExecuteQueryStatementAsync(sql);
            while (query.HasNext())
            {
                var next = query.Next();
                var values = next.Values;
                var measurePointName = values?[0]?.ToString()?.Replace(@$"{device}.", "");
                var _value = values?[3] as string;
                if (!string.IsNullOrEmpty(measurePointName) && !string.IsNullOrEmpty(_value))
                {
                    var _v = new MapItem(measurePointName, _value);
                    if (measureKeys == "*" || (!string.IsNullOrEmpty(measurePointName) && keylist.Contains(measurePointName)))
                        dt.Add(_v);
                }
            }
            return dt;
        }
        private dynamic? GetIotSharpValue(object v, string iotDataType)
        {
            dynamic? result = null;
            if (v != null && (v.ToString()?.ToUpper()) != "NULL")
            {
                switch (iotDataType.ToUpper())
                {
                    case "DOUBLE":
                        result = Convert.ToDouble(v);
                        break;
                    case "FLOAT":
                        result = Convert.ToSingle(v);
                        break;
                    case "TEXT":
                    case "STRING":
                        result = Convert.ToString(v);
                        break;
                    case "INT64":
                        result = Convert.ToInt64(v);
                        break;
                    case "IN32":
                    case "INT32":
                        result = Convert.ToInt32(v);
                        break;
                    case "BOOLEAN":
                        result = Convert.ToBoolean(v);
                        break;
                    case "DATE":
                        result = v is DateTime dateValue ? dateValue : Convert.ToDateTime(v);
                        break;
                    case "TIMESTAMP":
                        result = DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(v)).UtcDateTime;
                        break;
                    case "BLOB":
                        result = v as byte[] ?? throw new Exception("IoTDB BLOB value is not a byte array.");
                        break;
                    default:
                        throw new Exception($"不支持的IotDB数据类型：{iotDataType}");
                }
            }
            return result;
        }
        private DataType GetIoTSharpDataType(string iotDataType)
        {
            string _iot_dt_up = iotDataType.ToUpper();
            return _iot_dt_up switch
            {
                "DOUBLE" => DataType.Double,
                "FLOAT" => DataType.Double,
                "TEXT" => DataType.String,
                "STRING" => DataType.String,
                "INT64" => DataType.Long,
                "INT32" => DataType.Long,
                "BOOLEAN" => DataType.Boolean,
                "DATE" => DataType.DateTime,
                "TIMESTAMP" => DataType.DateTime,
                "BLOB" => DataType.Binary,
                _ => throw new Exception($"不支持的IotDB数据类型：{iotDataType}")
            };
        }


        public async Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId)
        {
            return await GetTelemetryLatest(deviceId, "*");
        }



        /// <summary>
        /// 将IotSharp中的聚合转换为IotDB中的聚合函数名称
        /// </summary>
        /// <param name="aggregate"></param>
        /// <returns></returns>
        private string SharpAggregate2IotDBAggregate(Aggregate aggregate)
        {
            var result = "";
            switch (aggregate)
            {
                case Aggregate.Mean:
                    result = "AVG";
                    break;
                case Aggregate.Last:
                    result = "LAST_VALUE";
                    break;
                case Aggregate.First:
                    result = "FIRST_VALUE";
                    break;
                case Aggregate.Max:
                    result = "MAX_VALUE";
                    break;
                case Aggregate.Min:
                    result = "MIN_VALUE";
                    break;
                case Aggregate.Sum:
                    result = "SUM";
                    break;
                case Aggregate.None:
                default:
                    result = "ALL";
                    break;
            }
            return result;
        }
        public async Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate)
        {
            //select count(status), max_value(temperature) from root.ln.wf01.wt01 group by ([2017-11-01T00:00:00, 2017-11-07T23:00:00),1d);
            //select avg(v2) from root.iotsharp.8984003f7016487db7f26528b246198f group by ([2022-06-10 00:00:00, 2022-06-10 23:00:00),1000ms);
            //2022-06-08T00:56:04.452+08:00
            List<TelemetryDataDto> dt = new List<TelemetryDataDto>();
            var aggStr = SharpAggregate2IotDBAggregate(aggregate);
            if (!string.IsNullOrEmpty(aggStr))//
            {
                if (string.IsNullOrEmpty(keys))
                    keys = "*";

                string device = $"root.{_StorageGroupName}.{deviceId:N}";
                var sb = new StringBuilder();
                var MeasurementPointList = await this.GetIotDbMeasurementPointInfor(device, keys);
                var selectItemStr = string.Join(",", from m in MeasurementPointList select $"{aggStr}({m.key})");
                if (aggStr == "ALL")
                    selectItemStr = string.Join(',', MeasurementPointList.Select(x => x.key));
                sb.AppendLine($@"select {selectItemStr} from {device} where Time >= {begin:yyyy-MM-ddTHH:mm:ss.fff+00:00} and Time < {end:yyyy-MM-ddTHH:mm:ss.fff+00:00}  ");

                if (every > TimeSpan.Zero && aggStr != "ALL")
                {
                    sb.AppendLine($@" group by ([{begin:yyyy-MM-ddTHH:mm:ss.fff+00:00}, {end:yyyy-MM-ddTHH:mm:ss.fff+00:00}),{(long)every.TotalMilliseconds}ms)");
                }

                _logger.LogInformation(sb.ToString());
                var query = await _session.ExecuteQueryStatementAsync(sb.ToString());
                while (query.HasNext())
                {
                    var next = query.Next();
                    var values = next.Values;
                    var time = next.GetDateTime();
                    for (int i = 0; i < MeasurementPointList.Count; i++)
                    {
                        var _value = GetIotSharpValue(values[i], MeasurementPointList[i].type);
                        if (_value != null)
                        {
                            TelemetryDataDto telemetry = new TelemetryDataDto()
                            {
                                DateTime = time, //传入的时间为UTC+0,推给web，转为UTC+8
                                KeyName = MeasurementPointList[i].key,
                                Value = _value,
                                DataType = GetIoTSharpDataType(MeasurementPointList[i].type),
                            };
                            dt.Add(telemetry);
                        }
                    }
                }

            }


            return dt;
        }



        public async Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys)
        {

            string device = $"root.{_StorageGroupName}.{deviceId:N}";
            if (string.IsNullOrEmpty(keys))
                keys = "*";
            var selectItemStr = string.Join(",", from m in keys.Split(',') select $"last({m})");

            var sql = $"select {selectItemStr} from {device}";

            List<TelemetryDataDto> dt = new List<TelemetryDataDto>();
            var query = await _session.ExecuteQueryStatementAsync(sql);

            while (query.HasNext())
            {

                var next = query.Next();
                var values = next.Values;
                var time = next.GetDateTime();
                if (values != null && values.Count >= 3)
                {
                    var _iottype = values[2] as string;
                    var _keyname = values[0]?.ToString()?.Replace($"{device}.", "");
                    if (!string.IsNullOrEmpty(_iottype) && !string.IsNullOrEmpty(_keyname))
                    {
                        var _value = GetIotSharpValue(values[1], _iottype);
                        if (_value != null)
                        {
                            TelemetryDataDto telemetry = new TelemetryDataDto()
                            {
                                DateTime = next.GetDateTime(),
                                KeyName = _keyname,
                                Value = _value,
                                DataType = GetIoTSharpDataType(_iottype),
                            };
                            dt.Add(telemetry);
                        }
                    }
                }

            }
            return dt;

        }

        public async Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg)
        {
            bool result = false;
            List<TelemetryData> telemetries = new List<TelemetryData>();
            try
            {
                var record = BuildRecord(msg, telemetries);
                if (record != null)
                {
                    string device = $"root.{_StorageGroupName}.{msg.DeviceId:N}";
                    var okCount = await _session.InsertRecordAsync(device, record);
                    _logger.LogInformation($"数据入库完成，准备写入{record.Values.Count}条数据，写入结果{okCount}");
                }
                result = true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{msg.DeviceId}数据处理失败{ex.Message} {ex.InnerException?.Message} ");
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
            if (messages.Count == 0)
            {
                return new TelemetryBatchStoreResult(true, telemetries, 0);
            }

            try
            {
                var devices = new List<string>(Math.Min(messages.Count, BatchMessageChunkSize));
                var records = new List<RowRecord>(Math.Min(messages.Count, BatchMessageChunkSize));
                var pendingValueCount = 0;

                foreach (var msg in messages)
                {
                    var record = BuildRecord(msg, telemetries);
                    if (record == null)
                    {
                        continue;
                    }

                    devices.Add($"root.{_StorageGroupName}.{msg.DeviceId:N}");
                    records.Add(record);
                    pendingValueCount += record.Values.Count;

                    if (records.Count >= BatchMessageChunkSize || pendingValueCount >= BatchTelemetryValueChunkSize)
                    {
                        var writeResult = await _session.InsertRecordsAsync(devices, records);
                        _logger.LogInformation("IoTDB批量遥测写入完成，消息{Messages}条，写入结果{WriteResult}", records.Count, writeResult);
                        devices.Clear();
                        records.Clear();
                        pendingValueCount = 0;
                    }
                }

                if (records.Count > 0)
                {
                    var writeResult = await _session.InsertRecordsAsync(devices, records);
                    _logger.LogInformation("IoTDB批量遥测写入完成，消息{Messages}条，写入结果{WriteResult}", records.Count, writeResult);
                }

                return new TelemetryBatchStoreResult(true, telemetries, messages.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "IoTDB批量遥测数据处理失败，消息{Messages}条: {Message} {InnerMessage}", messages.Count, ex.Message, ex.InnerException?.Message);
                return new TelemetryBatchStoreResult(false, telemetries, messages.Count);
            }
        }

        private static RowRecord? BuildRecord(PlayloadData msg, List<TelemetryData> telemetries)
        {
            var values = new List<object>();
            var dataTypes = new List<TSDataType>();
            var measurements = new List<string>();

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

                object? value = null;
                bool hasValue = true;
                TSDataType dataType = TSDataType.NONE;
                switch (tdata.Type)
                {
                    case DataType.Boolean:
                        value = tdata.Value_Boolean;
                        dataType = TSDataType.BOOLEAN;
                        hasValue = tdata.Value_Boolean.HasValue;
                        break;
                    case DataType.String:
                        value = tdata.Value_String;
                        dataType = TSDataType.STRING;
                        break;
                    case DataType.Long:
                        value = tdata.Value_Long;
                        dataType = TSDataType.INT64;
                        hasValue = tdata.Value_Long.HasValue;
                        break;
                    case DataType.Double:
                        value = tdata.Value_Double;
                        dataType = TSDataType.DOUBLE;
                        hasValue = tdata.Value_Double.HasValue;
                        break;
                    case DataType.Json:
                        value = tdata.Value_Json;
                        dataType = TSDataType.STRING;
                        hasValue = tdata.Value_Json != null;
                        break;
                    case DataType.XML:
                        value = tdata.Value_XML;
                        dataType = TSDataType.STRING;
                        hasValue = tdata.Value_XML != null;
                        break;
                    case DataType.Binary:
                        value = tdata.Value_Binary;
                        dataType = TSDataType.BLOB;
                        hasValue = tdata.Value_Binary != null;
                        break;
                    case DataType.DateTime:
                        value = tdata.Value_DateTime;
                        dataType = TSDataType.DATE;
                        hasValue = tdata.Value_DateTime.HasValue;
                        break;
                }

                if (!hasValue || value == null)
                {
                    continue;
                }

                values.Add(value);
                telemetries.Add(tdata);
                dataTypes.Add(dataType);
                measurements.Add(kp.Key);
            }

            return values.Count == 0
                ? null
                : new RowRecord(msg.ts, values, measurements, dataTypes);
        }
    }

    internal record struct MapItem(string key, string type)
    {
        public static implicit operator (string key, string type)(MapItem value)
        {
            return (value.key, value.type);
        }

        public static implicit operator MapItem((string key, string type) value)
        {
            return new MapItem(value.key, value.type);
        }
    }
}
