using IoTSharp.Data;
using IoTSharp.Dtos;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using System;
using System.Buffers;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.Mcp;

/// <summary>
/// 将数据库中的动态工具投影到 MCP tools/list，并执行受控 HTTP Tool。
/// </summary>
public sealed class DynamicMcpToolService
{
    public const string HandlerTypeHttpApi = "HttpApi";
    public const int MaxResponseBytes = 64 * 1024;
    private const string ApiKeyCapability = "API_KEY";
    private static readonly Regex PlaceholderPattern = new("\\{(?<name>[A-Za-z][A-Za-z0-9_.-]{0,63})\\}", RegexOptions.Compiled);
    private static readonly HashSet<string> ReservedToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "echo", "DevicesList", "get_device_status", "GetDeviceStatus", "get_device_attributes",
        "GetDeviceAttributes", "get_device_attribute", "GetDeviceAttribute"
    };
    private static readonly HashSet<string> AllowedMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        "GET", "POST", "PUT", "PATCH", "DELETE"
    };
    private static readonly HashSet<string> ForbiddenHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Host", "Content-Length", "Connection", "Transfer-Encoding", "Upgrade", "Proxy-Authorization"
    };

    private readonly ApplicationDbContext _context;
    private readonly IDataProtector _protector;

    public DynamicMcpToolService(ApplicationDbContext context, IDataProtectionProvider protectionProvider)
    {
        _context = context;
        _protector = protectionProvider.CreateProtector("IoTSharp.McpTool.Headers.v1");
    }

    public static string GetApiKey(McpServer server)
    {
        if (server?.ServerOptions?.Capabilities?.Experimental == null
            || !server.ServerOptions.Capabilities.Experimental.TryGetValue(ApiKeyCapability, out var value)
            || string.IsNullOrWhiteSpace(value?.ToString()))
        {
            throw new UnauthorizedAccessException("MCP API Key is missing.");
        }

        return value.ToString();
    }

    public async Task<ListToolsResult> ListToolsAsync(string apiKey, CancellationToken cancellationToken)
    {
        var settings = await GetEnabledSettingsAsync(apiKey, cancellationToken);
        var definitions = await _context.McpToolDefinitions.AsNoTracking()
            .Where(item => item.AISettingsId == settings.Id && item.Enabled && !item.Deleted)
            .OrderBy(item => item.Name)
            .ToListAsync(cancellationToken);

        var tools = definitions.Select(item => new Tool
        {
            Name = item.Name,
            Title = item.Title,
            Description = item.Description,
            InputSchema = ParseSchemaElement(item.InputSchemaJson),
            Annotations = new ToolAnnotations
            {
                Title = item.Title,
                ReadOnlyHint = item.ReadOnlyHint,
                OpenWorldHint = true
            }
        }).ToList();

        return new ListToolsResult { Tools = tools };
    }

    public async Task<CallToolResult> CallToolAsync(
        string apiKey,
        string toolName,
        IReadOnlyDictionary<string, JsonElement> arguments,
        CancellationToken cancellationToken)
    {
        var settings = await GetEnabledSettingsAsync(apiKey, cancellationToken);
        var definition = await _context.McpToolDefinitions
            .SingleOrDefaultAsync(item => item.AISettingsId == settings.Id
                && item.Name == toolName && item.Enabled && !item.Deleted, cancellationToken);

        if (definition == null)
        {
            return ErrorResult($"Dynamic MCP tool '{toolName}' was not found or is disabled.");
        }

        var result = await ExecuteAsync(definition, arguments, "McpClient", cancellationToken);
        return new CallToolResult
        {
            IsError = !result.Succeeded,
            Content = new List<ContentBlock>
            {
                new TextContentBlock { Text = result.Succeeded ? result.Body ?? string.Empty : result.ErrorMessage ?? "Tool execution failed." }
            }
        };
    }

    public async Task<McpToolExecutionResultDto> ExecuteAsync(
        McpToolDefinition definition,
        IReadOnlyDictionary<string, JsonElement> arguments,
        string source,
        CancellationToken cancellationToken)
    {
        arguments ??= new Dictionary<string, JsonElement>();
        var startedAt = DateTime.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        var result = new McpToolExecutionResultDto();
        var log = new McpToolInvocationLog
        {
            ToolDefinitionId = definition.Id,
            AISettingsId = definition.AISettingsId,
            ToolName = definition.Name,
            InvocationSource = source,
            ArgumentKeys = string.Join(",", arguments.Keys.OrderBy(item => item, StringComparer.OrdinalIgnoreCase)),
            StartedAt = startedAt
        };

        try
        {
            ValidateArguments(definition.InputSchemaJson, arguments);
            if (!string.Equals(definition.HandlerType, HandlerTypeHttpApi, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Unsupported MCP handler type: {definition.HandlerType}");
            }

            var request = BuildHttpRequest(definition, arguments);
            using var client = CreateHttpClient(definition.AllowPrivateNetwork);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(definition.TimeoutSeconds, 1, 60)));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var responseBody = await ReadLimitedBodyAsync(response.Content, timeout.Token);

            result.StatusCode = (int)response.StatusCode;
            result.ContentType = response.Content.Headers.ContentType?.ToString();
            result.Body = responseBody.Text;
            result.Succeeded = response.IsSuccessStatusCode;
            result.ErrorMessage = response.IsSuccessStatusCode
                ? null
                : $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}: {responseBody.Text}";
            log.StatusCode = result.StatusCode;
            log.ResponseSize = responseBody.ByteCount;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            result.ErrorMessage = $"Tool request timed out after {Math.Clamp(definition.TimeoutSeconds, 1, 60)} seconds.";
        }
        catch (Exception exception)
        {
            result.ErrorMessage = exception.Message;
        }
        finally
        {
            stopwatch.Stop();
            result.DurationMs = stopwatch.ElapsedMilliseconds;
            log.DurationMs = result.DurationMs;
            log.Succeeded = result.Succeeded;
            log.ErrorMessage = Truncate(result.ErrorMessage, 4000);
            _context.McpToolInvocationLogs.Add(log);
            await _context.SaveChangesAsync(CancellationToken.None);
        }

        return result;
    }

    public string ProtectHeaders(string headersJson)
    {
        var normalized = NormalizeHeadersJson(headersJson);
        return normalized == "{}" ? null : _protector.Protect(normalized);
    }

    public Dictionary<string, string> UnprotectHeaders(string protectedHeaders)
    {
        if (string.IsNullOrWhiteSpace(protectedHeaders)) return new(StringComparer.OrdinalIgnoreCase);
        var json = _protector.Unprotect(protectedHeaders);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(json)
            ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    public static string ValidateDefinition(SaveMcpToolDefinitionDto dto)
    {
        if (dto == null) return "Tool definition is required.";
        dto.Name = dto.Name?.Trim();
        dto.Title = dto.Title?.Trim();
        dto.Description = dto.Description?.Trim();
        dto.HandlerType = dto.HandlerType?.Trim();
        dto.HttpMethod = dto.HttpMethod?.Trim().ToUpperInvariant();
        dto.EndpointTemplate = dto.EndpointTemplate?.Trim();

        if (string.IsNullOrWhiteSpace(dto.Name) || !Regex.IsMatch(dto.Name, "^[A-Za-z][A-Za-z0-9_.-]{0,63}$"))
            return "Tool 名称只能包含字母、数字、点、下划线或短横线，并且必须以字母开头。";
        if (ReservedToolNames.Contains(dto.Name)) return $"Tool 名称 {dto.Name} 与内置工具冲突。";
        if (!string.Equals(dto.HandlerType, HandlerTypeHttpApi, StringComparison.OrdinalIgnoreCase)) return "当前仅支持 HttpApi 执行器。";
        if (!AllowedMethods.Contains(dto.HttpMethod ?? string.Empty)) return "HTTP Method 仅支持 GET、POST、PUT、PATCH、DELETE。";
        if (string.IsNullOrWhiteSpace(dto.EndpointTemplate)) return "Endpoint Template 不能为空。";

        JsonElement schema;
        try { schema = ParseSchemaElement(dto.InputSchemaJson); }
        catch (Exception exception) { return $"输入 Schema 无效：{exception.Message}"; }

        var sampleEndpoint = PlaceholderPattern.Replace(dto.EndpointTemplate, "sample");
        if (!Uri.TryCreate(sampleEndpoint, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.UserInfo))
            return "Endpoint Template 必须是无用户信息的绝对 HTTP/HTTPS 地址。";

        var properties = schema.TryGetProperty("properties", out var schemaProperties)
            && schemaProperties.ValueKind == JsonValueKind.Object
            ? schemaProperties.EnumerateObject().Select(item => item.Name).ToHashSet(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unknownPlaceholder = PlaceholderPattern.Matches(dto.EndpointTemplate)
            .Select(match => match.Groups["name"].Value)
            .FirstOrDefault(name => !properties.Contains(name));
        if (unknownPlaceholder != null) return $"Endpoint 参数 {{{unknownPlaceholder}}} 未在输入 Schema properties 中定义。";

        if (dto.HeadersJson != null)
        {
            try { NormalizeHeadersJson(dto.HeadersJson); }
            catch (Exception exception) { return $"固定请求头无效：{exception.Message}"; }
        }

        return null;
    }

    private async Task<AISettings> GetEnabledSettingsAsync(string apiKey, CancellationToken cancellationToken)
    {
        var settings = await _context.AISettings.AsNoTracking()
            .SingleOrDefaultAsync(item => item.MCP_API_KEY == apiKey, cancellationToken);
        if (settings == null || !settings.Enable) throw new UnauthorizedAccessException("MCP API Key is invalid or disabled.");
        return settings;
    }

    private HttpRequestMessage BuildHttpRequest(McpToolDefinition definition, IReadOnlyDictionary<string, JsonElement> arguments)
    {
        var consumed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var endpoint = PlaceholderPattern.Replace(definition.EndpointTemplate, match =>
        {
            var name = match.Groups["name"].Value;
            if (!TryGetArgument(arguments, name, out var value)) throw new ArgumentException($"Missing endpoint parameter: {name}");
            consumed.Add(name);
            return Uri.EscapeDataString(ToScalarString(value));
        });

        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Resolved endpoint is not a valid HTTP/HTTPS URL.");

        var method = new HttpMethod(definition.HttpMethod.ToUpperInvariant());
        var remaining = arguments.Where(item => !consumed.Contains(item.Key)).ToList();
        if (method == HttpMethod.Get || method == HttpMethod.Delete)
        {
            var query = string.Join("&", remaining.Select(item => $"{Uri.EscapeDataString(item.Key)}={Uri.EscapeDataString(ToQueryString(item.Value))}"));
            if (query.Length > 0)
            {
                var builder = new UriBuilder(uri);
                builder.Query = string.IsNullOrWhiteSpace(builder.Query)
                    ? query
                    : builder.Query.TrimStart('?') + "&" + query;
                uri = builder.Uri;
            }
        }

        var request = new HttpRequestMessage(method, uri);
        if (method != HttpMethod.Get && method != HttpMethod.Delete)
        {
            var body = "{" + string.Join(",", remaining.Select(item => $"{JsonSerializer.Serialize(item.Key)}:{item.Value.GetRawText()}")) + "}";
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }

        foreach (var header in UnprotectHeaders(definition.ProtectedHeaders))
        {
            if (ForbiddenHeaders.Contains(header.Key)) throw new InvalidOperationException($"Header '{header.Key}' is not allowed.");
            if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value))
            {
                if (request.Content == null) throw new InvalidOperationException($"Header '{header.Key}' cannot be used with this request.");
                request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }

        return request;
    }

    private static HttpClient CreateHttpClient(bool allowPrivateNetwork)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            ConnectCallback = async (context, cancellationToken) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken);
                var candidates = addresses.Where(address => allowPrivateNetwork || IsPublicAddress(address)).ToList();
                if (candidates.Count == 0)
                    throw new InvalidOperationException("Endpoint resolves to a private, loopback, link-local, or otherwise non-public address. Enable private-network access explicitly if this is an authorized industrial intranet API.");

                Exception lastError = null;
                foreach (var address in candidates)
                {
                    var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                    try
                    {
                        await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), cancellationToken);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch (Exception exception)
                    {
                        lastError = exception;
                        socket.Dispose();
                    }
                }

                throw lastError ?? new SocketException((int)SocketError.HostUnreachable);
            }
        };
        return new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static bool IsPublicAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var bytes = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            return !(bytes[0] == 0 || bytes[0] == 10 || bytes[0] == 127
                || (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
                || (bytes[0] == 169 && bytes[1] == 254)
                || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
                || (bytes[0] == 192 && bytes[1] == 168)
                || bytes[0] >= 224);
        }

        return !(address.IsIPv6LinkLocal || address.IsIPv6Multicast || address.IsIPv6SiteLocal
            || (bytes[0] & 0xfe) == 0xfc);
    }

    private static async Task<(string Text, long ByteCount)> ReadLimitedBodyAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var memory = new MemoryStream();
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        var total = 0;
        var truncated = false;
        try
        {
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
                if (read == 0) break;
                total += read;
                var writable = Math.Min(read, MaxResponseBytes - (int)memory.Length);
                if (writable > 0) memory.Write(buffer, 0, writable);
                if (total > MaxResponseBytes) { truncated = true; break; }
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }

        var text = Encoding.UTF8.GetString(memory.ToArray());
        if (truncated) text += $"\n[response truncated at {MaxResponseBytes} bytes]";
        return (text, total);
    }

    private static void ValidateArguments(string schemaJson, IReadOnlyDictionary<string, JsonElement> arguments)
    {
        var schema = ParseSchemaElement(schemaJson);
        if (schema.TryGetProperty("required", out var required) && required.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in required.EnumerateArray())
            {
                var name = item.GetString();
                if (!string.IsNullOrWhiteSpace(name) && !arguments.Keys.Any(key => string.Equals(key, name, StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException($"Missing required argument: {name}");
            }
        }

        if (!schema.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object) return;
        foreach (var argument in arguments)
        {
            if (!properties.TryGetProperty(argument.Key, out var propertySchema)
                || !propertySchema.TryGetProperty("type", out var typeElement)) continue;
            var expected = typeElement.GetString();
            var valid = expected switch
            {
                "string" => argument.Value.ValueKind == JsonValueKind.String,
                "number" => argument.Value.ValueKind == JsonValueKind.Number,
                "integer" => argument.Value.ValueKind == JsonValueKind.Number && argument.Value.TryGetInt64(out _),
                "boolean" => argument.Value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                "object" => argument.Value.ValueKind == JsonValueKind.Object,
                "array" => argument.Value.ValueKind == JsonValueKind.Array,
                "null" => argument.Value.ValueKind == JsonValueKind.Null,
                _ => true
            };
            if (!valid) throw new ArgumentException($"Argument '{argument.Key}' must be of type {expected}.");
        }
    }

    private static JsonElement ParseSchemaElement(string schemaJson)
    {
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(schemaJson) ? "{}" : schemaJson);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("type", out var type)
            || !string.Equals(type.GetString(), "object", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Schema root must be a JSON object with type=object.");
        return root.Clone();
    }

    private static string NormalizeHeadersJson(string headersJson)
    {
        if (string.IsNullOrWhiteSpace(headersJson)) return "{}";
        using var document = JsonDocument.Parse(headersJson);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ArgumentException("Headers must be a JSON object.");
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (ForbiddenHeaders.Contains(property.Name)) throw new ArgumentException($"Header '{property.Name}' is not allowed.");
            if (property.Value.ValueKind != JsonValueKind.String) throw new ArgumentException($"Header '{property.Name}' must have a string value.");
            if (property.Value.GetString()?.ContainsAny('\r', '\n') == true) throw new ArgumentException($"Header '{property.Name}' contains invalid line breaks.");
            values[property.Name] = property.Value.GetString() ?? string.Empty;
        }
        return JsonSerializer.Serialize(values);
    }

    private static bool TryGetArgument(IReadOnlyDictionary<string, JsonElement> arguments, string name, out JsonElement value)
    {
        foreach (var item in arguments)
        {
            if (string.Equals(item.Key, name, StringComparison.OrdinalIgnoreCase))
            {
                value = item.Value;
                return true;
            }
        }
        value = default;
        return false;
    }

    private static string ToScalarString(JsonElement value)
        => value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.GetRawText();

    private static string ToQueryString(JsonElement value)
        => value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.GetRawText();

    private static CallToolResult ErrorResult(string message) => new()
    {
        IsError = true,
        Content = new List<ContentBlock> { new TextContentBlock { Text = message } }
    };

    private static string Truncate(string value, int maximum)
        => string.IsNullOrEmpty(value) || value.Length <= maximum ? value : value[..maximum];
}

internal static class StringInspectionExtensions
{
    public static bool ContainsAny(this string value, params char[] characters)
        => characters.Any(value.Contains);
}
