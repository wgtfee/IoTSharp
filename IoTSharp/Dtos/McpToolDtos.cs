using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Text.Json;

namespace IoTSharp.Dtos;

public sealed class McpToolDefinitionDto
{
    public Guid Id { get; set; }
    public string Name { get; set; }
    public string Title { get; set; }
    public string Description { get; set; }
    public string HandlerType { get; set; }
    public string InputSchemaJson { get; set; }
    public string HttpMethod { get; set; }
    public string EndpointTemplate { get; set; }
    public bool HasProtectedHeaders { get; set; }
    public int TimeoutSeconds { get; set; }
    public bool Enabled { get; set; }
    public bool ReadOnlyHint { get; set; }
    public bool AllowPrivateNetwork { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public sealed class SaveMcpToolDefinitionDto
{
    [Required, StringLength(64)]
    public string Name { get; set; }

    [Required, StringLength(128)]
    public string Title { get; set; }

    [Required, StringLength(2048)]
    public string Description { get; set; }

    public string HandlerType { get; set; } = "HttpApi";

    [Required]
    public string InputSchemaJson { get; set; } = "{\"type\":\"object\",\"properties\":{}}";

    [Required, StringLength(16)]
    public string HttpMethod { get; set; } = "GET";

    [Required, StringLength(2048)]
    public string EndpointTemplate { get; set; }

    /// <summary>
    /// JSON 对象。新增时为空表示无固定请求头；修改时 null 表示保留现有密钥头，{} 表示清空。
    /// </summary>
    public string HeadersJson { get; set; }

    [Range(1, 60)]
    public int TimeoutSeconds { get; set; } = 15;

    public bool Enabled { get; set; } = true;
    public bool ReadOnlyHint { get; set; } = true;
    public bool AllowPrivateNetwork { get; set; }
}

public sealed class TestMcpToolDto
{
    public Dictionary<string, JsonElement> Arguments { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class McpToolExecutionResultDto
{
    public bool Succeeded { get; set; }
    public int? StatusCode { get; set; }
    public long DurationMs { get; set; }
    public string ContentType { get; set; }
    public string Body { get; set; }
    public string ErrorMessage { get; set; }
}

public sealed class McpToolInvocationDto
{
    public Guid Id { get; set; }
    public string ToolName { get; set; }
    public string InvocationSource { get; set; }
    public string ArgumentKeys { get; set; }
    public DateTime StartedAt { get; set; }
    public long DurationMs { get; set; }
    public bool Succeeded { get; set; }
    public int? StatusCode { get; set; }
    public long ResponseSize { get; set; }
    public string ErrorMessage { get; set; }
}
