using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Dynamic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace IoTSharp.Data.Extensions
{
    public static class PlayloadExtension
    {
        public static ExpandoObject ToDynamic(this Dictionary<string, object> dc)
        {
            ExpandoObject obj = new ExpandoObject();
            foreach (var kv in dc)
            {
                obj.TryAdd(kv.Key, kv.Value);
            }
            return obj;
        }
        public static ExpandoObject ToDynamic(this List<TelemetryDataDto> array)
        {
            ExpandoObject exps = new();
            foreach (var td in array)
            {
                exps.TryAdd(td.KeyName, td.Value);
            }
            return exps;
        }
        public static Dictionary<string, object> ToDictionary(this PlayloadData msg)
        {
            var mb = msg.MsgBody;
            Dictionary<string, object> dc = new Dictionary<string, object>(mb.Count);
            foreach (var kp in mb)
            {
                if (kp.Value?.GetType() == typeof(System.Text.Json.JsonElement))
                {
                    var je = (System.Text.Json.JsonElement)kp.Value;
                    switch (je.ValueKind)
                    {
                        case System.Text.Json.JsonValueKind.Undefined:
                        case System.Text.Json.JsonValueKind.Object:
                        case System.Text.Json.JsonValueKind.Array:
                            dc.Add(kp.Key, je.GetRawText());
                            break;

                        case System.Text.Json.JsonValueKind.String:
                            dc.Add(kp.Key, je.GetString());
                            break;

                        case System.Text.Json.JsonValueKind.Number:
                            dc.Add(kp.Key, je.GetDouble());
                            break;

                        case System.Text.Json.JsonValueKind.True:
                        case System.Text.Json.JsonValueKind.False:
                            dc.Add(kp.Key, je.GetBoolean());
                            break;

                        case System.Text.Json.JsonValueKind.Null:
                            break;

                        default:
                            break;
                    }
                }
                else if (kp.Value != null)
                {
                    dc.Add(kp.Key, kp.Value);
                }

            }
            return dc;
        }

        public static List<TelemetryDataDto> ToRuleTelemetryData(this PlayloadData msg)
        {
            return msg.ToRuleTelemetryPayload(includeTelemetry: false, includeTelemetryArray: true).TelemetryArray
                ?? new List<TelemetryDataDto>();
        }

        /// <summary>
        /// 按实际规则挂载类型一次遍历构造规则输入，避免只需要一种输入时仍创建另一种对象图。
        /// </summary>
        public static (ExpandoObject? Telemetry, List<TelemetryDataDto>? TelemetryArray) ToRuleTelemetryPayload(
            this PlayloadData msg,
            bool includeTelemetry,
            bool includeTelemetryArray)
        {
            ExpandoObject? telemetry = includeTelemetry ? new ExpandoObject() : null;
            IDictionary<string, object>? dynamicValues = telemetry;
            var telemetryArray = includeTelemetryArray
                ? new List<TelemetryDataDto>(msg.MsgBody.Count)
                : null;

            foreach (var kp in msg.MsgBody)
            {
                if (!TryNormalizeRuleValue(kp.Value, msg.ts, out var dataType, out var value))
                {
                    continue;
                }

                if (dynamicValues != null)
                {
                    dynamicValues[kp.Key] = value!;
                }

                telemetryArray?.Add(new TelemetryDataDto
                {
                    KeyName = kp.Key,
                    DateTime = msg.ts,
                    DataType = dataType,
                    Value = value
                });
            }

            return (telemetry, telemetryArray);
        }

        private static bool TryNormalizeRuleValue(object? value, DateTime messageTimestamp, out DataType dataType, out object? normalizedValue)
        {
            dataType = default;
            normalizedValue = null;
            if (value is null)
            {
                return false;
            }

            if (value is System.Text.Json.JsonElement element)
            {
                switch (element.ValueKind)
                {
                    case System.Text.Json.JsonValueKind.Undefined:
                    case System.Text.Json.JsonValueKind.Object:
                    case System.Text.Json.JsonValueKind.Array:
                        dataType = DataType.String;
                        normalizedValue = element.GetRawText();
                        return true;
                    case System.Text.Json.JsonValueKind.String:
                        dataType = DataType.String;
                        normalizedValue = element.GetString();
                        return true;
                    case System.Text.Json.JsonValueKind.Number:
                        dataType = DataType.Double;
                        normalizedValue = element.GetDouble();
                        return true;
                    case System.Text.Json.JsonValueKind.True:
                    case System.Text.Json.JsonValueKind.False:
                        dataType = DataType.Boolean;
                        normalizedValue = element.GetBoolean();
                        return true;
                    case System.Text.Json.JsonValueKind.Null:
                        return false;
                    default:
                        return false;
                }
            }

            switch (Type.GetTypeCode(value.GetType()))
            {
                case TypeCode.Boolean:
                    dataType = DataType.Boolean;
                    normalizedValue = value;
                    break;
                case TypeCode.Single:
                    dataType = DataType.Double;
                    normalizedValue = Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case TypeCode.Double:
                    dataType = DataType.Double;
                    normalizedValue = value;
                    break;
                case TypeCode.Decimal:
                    dataType = DataType.Double;
                    normalizedValue = Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case TypeCode.Int16:
                case TypeCode.Int32:
                case TypeCode.Int64:
                case TypeCode.UInt16:
                case TypeCode.UInt32:
                case TypeCode.UInt64:
                case TypeCode.Byte:
                case TypeCode.SByte:
                    dataType = DataType.Long;
                    normalizedValue = Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case TypeCode.String:
                    dataType = DataType.String;
                    normalizedValue = value;
                    break;
                case TypeCode.Char:
                    dataType = DataType.String;
                    normalizedValue = value.ToString();
                    break;
                case TypeCode.DateTime:
                    dataType = DataType.DateTime;
                    normalizedValue = messageTimestamp;
                    break;
                case TypeCode.DBNull:
                case TypeCode.Empty:
                    return false;
                case TypeCode.Object:
                default:
                    if (value is byte[] bytes)
                    {
                        dataType = DataType.Binary;
                        normalizedValue = bytes;
                    }
                    else if (value is System.Xml.XmlDocument xml)
                    {
                        dataType = DataType.XML;
                        normalizedValue = xml.InnerXml;
                    }
                    else
                    {
                        dataType = DataType.Json;
                        normalizedValue = IoTSharp.Extensions.JsonObjectSerializer.Serialize(value);
                    }
                    break;
            }

            return true;
        }
    }
}
