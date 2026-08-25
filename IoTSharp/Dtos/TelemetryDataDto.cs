using IoTSharp.Contracts;
using IoTSharp.Data;
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace IoTSharp.Dtos
{

    /// <summary>
    /// 查询历史遥测数据请求结构体
    /// </summary>
    public class TelemetryDataQueryDto
    {
        /// <summary>
        /// 要获取的键值， 如果为空， 则为全部
        /// </summary>
        public string keys { get; set; } = string.Empty;
        /// <summary>
        /// 开始时间
        /// </summary>
        public DateTime begin { get; set; }
        /// <summary>
        /// 截止时间， 默认为现在。 
        /// </summary>
        public DateTime end { get; set; } = DateTime.UtcNow;
        /// <summary>
        /// 数据截面聚合间隔
        /// </summary>
        /// <example>1.03:14:56:166</example>
        /// <remarks>d.hh:mm:ss:FFF</remarks>
        [System.Text.Json.Serialization.JsonConverter(typeof(TimeSpanConverter))]
        public TimeSpan every { get; set; } = TimeSpan.Zero;
        /// <summary>
        /// 数据截面计算方式， 
        /// </summary>
        public Aggregate aggregate { get; set; } = Aggregate.None;
    }

    /// <summary>
    /// 管理端手工上报一组设备遥测数据。
    /// </summary>
    public class TelemetryCreateDto
    {
        /// <summary>
        /// 设备侧采集时间；为空时使用服务器当前时间。
        /// </summary>
        public DateTimeOffset? Timestamp { get; set; }

        /// <summary>
        /// 本次上报的遥测键值，最多 100 项。
        /// </summary>
        [Required, MinLength(1), MaxLength(100)]
        public List<TelemetryValueCreateDto> Values { get; set; } = new();
    }

    /// <summary>
    /// 单个手工遥测键值。
    /// </summary>
    public class TelemetryValueCreateDto
    {
        [Required, StringLength(128, MinimumLength = 1)]
        public string KeyName { get; set; } = string.Empty;

        public IoTSharp.Contracts.DataType DataType { get; set; } = IoTSharp.Contracts.DataType.String;

        public JsonElement Value { get; set; }
    }
}
