using IoTSharp.Extensions;
using System.Collections.Generic;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Dtos;
using System.Text.Json;
using System.Text.Json.Nodes;
using System;
using System.Text;
using System.Linq;
using System.Xml;
using IoTSharp.Data.Extensions;
using Xunit;

namespace IoTSharp.Test
{
    public class JsonSerializationTest
    {
        [Fact]
        public void TestJsonObject()
        {
            var jojb = JsonNodeParser.ParseNode("{\"aaa\":\"bbb\"}");
            Dictionary<string, object> keyValues = jojb.ToDictionary();
            Assert.Equal("bbb", keyValues["aaa"].ToString());
        }



        [Fact]
        public void TestDic()
        {
            var sss = new Dictionary<string, object>();
            sss.Add("eee", "fff");
            sss.Add("ggg", "hhh");
            sss.Add("iii", "kkk");
            Assert.NotNull(JsonObjectSerializer.Serialize(sss));
        }

        [Fact]
        public void SerializeToUtf8Bytes_MatchesUnifiedStringSerialization()
        {
            var value = new Dictionary<string, object>
            {
                ["name"] = "PLC01",
                ["value"] = 12.5,
                ["running"] = true,
                ["items"] = new[] { 1, 2, 3 }
            };

            var text = JsonObjectSerializer.Serialize(value);
            var utf8 = JsonObjectSerializer.SerializeToUtf8Bytes(value);

            Assert.Equal(text, Encoding.UTF8.GetString(utf8));
        }

        [Fact]
        public void RuleTelemetryData_PreservesLegacyJsonElementNormalization()
        {
            using var document = JsonDocument.Parse("""{"number":12.5,"flag":true,"text":"abc","array":[1,2],"object":{"a":1},"nil":null}""");
            var timestamp = new DateTime(2026, 9, 15, 1, 2, 3, DateTimeKind.Utc);
            var message = new PlayloadData
            {
                ts = timestamp,
                MsgBody = document.RootElement.EnumerateObject()
                    .ToDictionary(property => property.Name, property => (object)property.Value.Clone())
            };

            var values = message.ToRuleTelemetryData().ToDictionary(item => item.KeyName!);

            Assert.Equal(DataType.Double, values["number"].DataType);
            Assert.Equal(12.5, Assert.IsType<double>(values["number"].Value));
            Assert.Equal(DataType.Boolean, values["flag"].DataType);
            Assert.True(Assert.IsType<bool>(values["flag"].Value));
            Assert.Equal(DataType.String, values["text"].DataType);
            Assert.Equal("abc", values["text"].Value);
            Assert.Equal(DataType.String, values["array"].DataType);
            Assert.Equal("[1,2]", values["array"].Value);
            Assert.Equal(DataType.String, values["object"].DataType);
            Assert.Equal("{\"a\":1}", values["object"].Value);
            Assert.DoesNotContain("nil", values.Keys);
        }

        [Fact]
        public void RuleTelemetryData_PreservesLegacyClrTypeAndTimestampSemantics()
        {
            var timestamp = new DateTime(2026, 9, 15, 4, 5, 6, DateTimeKind.Utc);
            var bytes = new byte[] { 1, 2, 3 };
            var xml = new XmlDocument();
            xml.LoadXml("<root><value>1</value></root>");
            var message = new PlayloadData
            {
                ts = timestamp,
                MsgBody = new Dictionary<string, object>
                {
                    ["integer"] = 12,
                    ["date"] = timestamp.AddHours(-1),
                    ["binary"] = bytes,
                    ["xml"] = xml,
                    ["complex"] = new { a = 1 }
                }
            };

            var values = message.ToRuleTelemetryData().ToDictionary(item => item.KeyName!);

            Assert.Equal(DataType.Long, values["integer"].DataType);
            Assert.Equal(12L, values["integer"].Value);
            Assert.Equal(DataType.DateTime, values["date"].DataType);
            Assert.Equal(timestamp, values["date"].Value);
            Assert.Equal(DataType.Binary, values["binary"].DataType);
            Assert.Same(bytes, values["binary"].Value);
            Assert.Equal(DataType.XML, values["xml"].DataType);
            Assert.Equal(xml.InnerXml, values["xml"].Value);
            Assert.Equal(DataType.Json, values["complex"].DataType);
            Assert.Equal("{\"a\":1}", values["complex"].Value);
        }

        [Fact]
        public void JsonSerializer_ApiResult_InstanceDto()
        {
            var js = new ApiResult<InstanceDto>(ApiCode.Success, "OK", new InstanceDto() { Installed = true, Version = DateTime.Now.ToString() });
            var json = JsonSerializer.Serialize(js);
            var result = JsonSerializer.Deserialize<ApiResult<InstanceDto>>(json, new JsonSerializerOptions() { IncludeFields = true });
            Assert.NotNull(result);
            Assert.NotNull(result.Data);
            Assert.Equal(js.Data.Installed, result.Data.Installed);
            Assert.Equal(js.Data.Version, result.Data.Version);
        }
    }
}
