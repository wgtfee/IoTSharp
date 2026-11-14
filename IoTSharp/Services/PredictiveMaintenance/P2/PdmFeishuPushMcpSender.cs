using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Microsoft.Extensions.Options;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// An explicitly configured, approved FeishuPushMCP stdio client.
/// Uses VOL.AI's existing machine-protected credentials through the managed
/// MCP provider. NEVER copies secrets to IoTSharp or falls back to a webhook.
/// Production registration defaults OFF.
/// </summary>
public sealed class PdmWorkOrderFeishuOptions
{
    public const string SectionName = "PredictiveMaintenance:WorkOrders:Feishu";
    public bool Enabled { get; set; }
    public bool RouteApproved { get; set; }
    public bool SingleInstanceAcknowledged { get; set; }
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid ApprovedBy { get; set; }
    public DateTimeOffset ApprovedAtUtc { get; set; }
    public string AccountId { get; set; } = "";
    public string ChatId { get; set; } = "";
    public string ProviderExecutable { get; set; } = "";
    public string ProviderWorkingDirectory { get; set; } = "";
    public int PollSeconds { get; set; } = 60;
    public int MaxPerCycle { get; set; } = 3;
    public int TimeoutSeconds { get; set; } = 20;

    public PdmVolAiFeishuRoute ApprovedRoute() =>
        new(TenantId, CustomerId, AccountId, ChatId,
            ApprovedBy, ApprovedAtUtc, RouteApproved);

    public void Validate()
    {
        if (!Enabled || !RouteApproved || !SingleInstanceAcknowledged ||
            TenantId == Guid.Empty || CustomerId == Guid.Empty ||
            ApprovedBy == Guid.Empty ||
            ApprovedAtUtc.Offset != TimeSpan.Zero ||
            ApprovedAtUtc > DateTimeOffset.UtcNow ||
            DateTimeOffset.UtcNow - ApprovedAtUtc > TimeSpan.FromDays(30) ||
            string.IsNullOrWhiteSpace(AccountId) || AccountId.Length > 120 ||
            string.IsNullOrWhiteSpace(ChatId) ||
            !ChatId.StartsWith("oc_", StringComparison.Ordinal) ||
            ChatId.Length is < 20 or > 180 ||
            !ChatId.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ||
            PollSeconds is < 30 or > 3600 ||
            MaxPerCycle is < 1 or > 5 ||
            TimeoutSeconds is < 5 or > 30 ||
            string.IsNullOrWhiteSpace(ProviderExecutable) ||
            string.IsNullOrWhiteSpace(ProviderWorkingDirectory) ||
            !Path.IsPathFullyQualified(ProviderExecutable) ||
            !Path.IsPathFullyQualified(ProviderWorkingDirectory))
            throw new InvalidOperationException("IoTSharp Feishu route, provider or bounded worker not approved.");

        // The audited provider binary must reside under the explicitly
        // configured workdir. Never accept a user-supplied arbitrary command.
        var expected = Path.GetFullPath(Path.Combine(
            ProviderWorkingDirectory, "_audit_build", "FeishuPushMcp.exe"));
        var actual = Path.GetFullPath(ProviderExecutable);
        if (!OperatingSystem.IsWindows() ||
            !string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase) ||
            !Directory.Exists(ProviderWorkingDirectory) ||
            !File.Exists(actual))
            throw new InvalidOperationException("Only the audited local FeishuPushMCP binary is permitted.");
    }
}

/// <summary>
/// The worker creates one managed MCP client per bounded send. The provider
/// itself claims delivery_key BEFORE its Feishu HTTP request; retries after
/// unknown outcomes are forbidden by both outboxes.
/// </summary>
public sealed class PdmFeishuPushMcpSender(IOptions<PdmWorkOrderFeishuOptions> options)
    : IPdmManagedFeishuMcpSender
{
    private readonly PdmWorkOrderFeishuOptions _options = options.Value;

    private async Task<McpClient> ConnectAsync(CancellationToken ct)
    {
        _options.Validate();
        var transport = new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "iotsharp-pdm-feishu-notification",
            Command = _options.ProviderExecutable,
            Arguments = [],
            WorkingDirectory = _options.ProviderWorkingDirectory
        });
        return await McpClient.CreateAsync(transport, cancellationToken: ct);
    }

    /// <summary>Read-only preflight; cannot publish a message or claim an Outbox row.</summary>
    public async Task<bool> IsProviderReadyAsync(CancellationToken ct = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(_options.TimeoutSeconds));
        await using var client = await ConnectAsync(timeout.Token);
        var result = await client.CallToolAsync("get_feishu_status",
            new Dictionary<string, object>(), cancellationToken: timeout.Token);
        if (result.IsError == true) return false;
        var json = GetResponseJson(result);
        using var document = JsonDocument.Parse(json);
        return document.RootElement.TryGetProperty("ready", out var ready) &&
               ready.ValueKind == JsonValueKind.True;
    }

    public async Task<PdmManagedFeishuSendResult> SendAsync(
        PdmVolAiFeishuMcpHandoff message, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(message);
        _options.Validate();
        if (message.ToolName != "send_feishu_message" ||
            message.DeliveryKey is not { Length: >= 20 and <= 128 } ||
            !message.DeliveryKey.StartsWith("iotsharp-wo:", StringComparison.Ordinal) ||
            message.AccountId != _options.AccountId ||
            message.ChatId != _options.ChatId ||
            !message.Content.StartsWith("【IoTSharp 内部维修工单】",
                StringComparison.Ordinal) ||
            message.Content.Length > 3000)
            throw new InvalidOperationException("Unapproved IoTSharp work-order Feishu payload.");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(_options.TimeoutSeconds));
        await using var client = await ConnectAsync(timeout.Token);
        var arguments = message.ToolArguments()
            .ToDictionary(x => x.Key, x => (object)x.Value, StringComparer.Ordinal);
        var result = await client.CallToolAsync(
            "send_feishu_message", arguments, cancellationToken: timeout.Token);
        if (result.IsError == true)
            throw new InvalidOperationException("Feishu MCP reported an unconfirmed send.");
        var json = GetResponseJson(result);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (!root.TryGetProperty("delivered", out var delivered) ||
            delivered.ValueKind != JsonValueKind.True ||
            !root.TryGetProperty("deliveryState", out var state) ||
            state.GetString() != "confirmed" ||
            !root.TryGetProperty("messageCount", out var count) ||
            count.GetInt32() != 1 ||
            !root.TryGetProperty("externalMessageIds", out var ids) ||
            ids.ValueKind != JsonValueKind.Array ||
            ids.GetArrayLength() != 1 ||
            ids[0].ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(ids[0].GetString()))
            throw new InvalidOperationException("Feishu MCP response is not a confirmed single-message delivery.");
        var rawId = ids[0].GetString()!;
        var sha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawId)))
            .ToLowerInvariant();
        return new PdmManagedFeishuSendResult(true, sha256);
    }

    private static string GetResponseJson(CallToolResult result)
    {
        if (result.Content is not { Count: > 0 })
            throw new InvalidOperationException("Feishu MCP returned no response content.");
        var blocks = result.Content.OfType<TextContentBlock>().ToArray();
        if (blocks.Length != 1 || string.IsNullOrWhiteSpace(blocks[0].Text) ||
            blocks[0].Text.Length > 16_384)
            throw new InvalidOperationException("Feishu MCP response content is malformed.");
        return blocks[0].Text;
    }
}
