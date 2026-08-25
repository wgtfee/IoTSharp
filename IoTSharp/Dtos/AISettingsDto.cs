using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Data
{
    public class AISettingsSetDto
    {
        /// <summary>
        /// AI/MCP 配置名称。
        /// </summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// 是否允许 MCP 客户端使用当前配置。
        /// </summary>
        public bool Enable { get; set; } = true;

        /// <summary>
        /// 是否轮换 MCP API Key；普通保存不会再让已有客户端失效。
        /// </summary>
        public bool RegenerateApiKey { get; set; }
    }
    public class AISettingsDto
    {

        public string Name { get; set; } = string.Empty;
        public string MCP_API_KEY { get; set; } = string.Empty;

        public bool Enable { get; set; } = true;
    }
}
