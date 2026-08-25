using System;
using System.Collections.Generic;

namespace IoTSharp.Data;

/// <summary>
/// MCP 动态工具定义。第一阶段只开放受控 HTTP API 执行器。
/// </summary>
public sealed class McpToolDefinition
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid AISettingsId { get; set; }
    public AISettings AISettings { get; set; }
    public string Name { get; set; }
    public string Title { get; set; }
    public string Description { get; set; }
    public string HandlerType { get; set; } = "HttpApi";
    public string InputSchemaJson { get; set; } = "{\"type\":\"object\",\"properties\":{}}";
    public string HttpMethod { get; set; } = "GET";
    public string EndpointTemplate { get; set; }
    public string ProtectedHeaders { get; set; }
    public int TimeoutSeconds { get; set; } = 15;
    public bool Enabled { get; set; } = true;
    public bool ReadOnlyHint { get; set; } = true;
    public bool AllowPrivateNetwork { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; }
    public string UpdatedBy { get; set; }
    public bool Deleted { get; set; }
    public ICollection<McpToolInvocationLog> Invocations { get; set; } = new List<McpToolInvocationLog>();
}

/// <summary>
/// 动态工具执行审计。参数值、请求体和认证头均不落库。
/// </summary>
public sealed class McpToolInvocationLog
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ToolDefinitionId { get; set; }
    public McpToolDefinition ToolDefinition { get; set; }
    public Guid AISettingsId { get; set; }
    public string ToolName { get; set; }
    public string InvocationSource { get; set; } = "McpClient";
    public string ArgumentKeys { get; set; }
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public long DurationMs { get; set; }
    public bool Succeeded { get; set; }
    public int? StatusCode { get; set; }
    public long ResponseSize { get; set; }
    public string ErrorMessage { get; set; }
}
