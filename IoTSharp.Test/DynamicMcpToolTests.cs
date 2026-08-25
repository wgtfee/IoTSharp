#nullable enable

using IoTSharp.Data;
using IoTSharp.Dtos;
using IoTSharp.Services.Mcp;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class DynamicMcpToolTests
{
    [Fact]
    public void DefinitionValidationRejectsBuiltInNamesAndUnknownTemplateParameters()
    {
        var builtIn = ValidDefinition();
        builtIn.Name = "GetDeviceStatus";
        Assert.Contains("内置工具冲突", DynamicMcpToolService.ValidateDefinition(builtIn));

        var unknownParameter = ValidDefinition();
        unknownParameter.EndpointTemplate = "https://example.com/devices/{missing}";
        Assert.Contains("未在输入 Schema", DynamicMcpToolService.ValidateDefinition(unknownParameter));
    }

    [Fact]
    public async Task DatabaseToolsAreListedOnlyForTheirEnabledApiKeyScope()
    {
        await using var services = BuildServices();
        using var scope = services.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var service = scope.ServiceProvider.GetRequiredService<DynamicMcpToolService>();
        var settings = new AISettings { MCP_API_KEY = "scope-a", Enable = true };
        context.AISettings.Add(settings);
        context.McpToolDefinitions.AddRange(
            CreateTool(settings.Id, "query_order", enabled: true),
            CreateTool(settings.Id, "disabled_tool", enabled: false));
        await context.SaveChangesAsync();

        var result = await service.ListToolsAsync("scope-a", CancellationToken.None);

        Assert.Single(result.Tools);
        Assert.Equal("query_order", result.Tools.Single().Name);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => service.ListToolsAsync("another-scope", CancellationToken.None));
    }

    [Fact]
    public async Task PrivateNetworkIsBlockedByDefaultAndFailureIsAuditedWithoutArgumentValues()
    {
        await using var services = BuildServices();
        using var scope = services.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var service = scope.ServiceProvider.GetRequiredService<DynamicMcpToolService>();
        var settings = new AISettings { MCP_API_KEY = "scope-b", Enable = true };
        var tool = CreateTool(settings.Id, "private_api", enabled: true);
        tool.EndpointTemplate = "http://127.0.0.1:65530/devices/{deviceId}";
        context.AISettings.Add(settings);
        context.McpToolDefinitions.Add(tool);
        await context.SaveChangesAsync();
        using var argumentDocument = JsonDocument.Parse("\"secret-device-value\"");

        var result = await service.ExecuteAsync(tool, new Dictionary<string, JsonElement>
        {
            ["deviceId"] = argumentDocument.RootElement.Clone()
        }, "UnitTest", CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Contains("private", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        var audit = await context.McpToolInvocationLogs.SingleAsync();
        Assert.Equal("deviceId", audit.ArgumentKeys);
        Assert.DoesNotContain("secret-device-value", audit.ErrorMessage ?? string.Empty);
    }

    [Fact]
    public void ProtectedHeadersRoundTripWithoutPlaintextStorage()
    {
        var provider = new EphemeralDataProtectionProvider();
        var service = new DynamicMcpToolService(null!, provider);
        const string json = "{\"Authorization\":\"Bearer test-secret\"}";

        var protectedValue = service.ProtectHeaders(json);
        var headers = service.UnprotectHeaders(protectedValue);

        Assert.DoesNotContain("test-secret", protectedValue);
        Assert.Equal("Bearer test-secret", headers["Authorization"]);
    }

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDataProtection();
        services.AddEntityFrameworkInMemoryDatabase();
        services.AddSingleton<IDataBaseModelBuilderOptions, TestModelBuilderOptions>();
        services.AddDbContext<ApplicationDbContext>((provider, options) =>
        {
            options.UseInMemoryDatabase(Guid.NewGuid().ToString("N"));
            options.UseInternalServiceProvider(provider);
        });
        services.AddScoped<DynamicMcpToolService>();
        return services.BuildServiceProvider(validateScopes: true);
    }

    private static SaveMcpToolDefinitionDto ValidDefinition() => new()
    {
        Name = "query_order",
        Title = "Query order",
        Description = "Queries one production order.",
        InputSchemaJson = "{\"type\":\"object\",\"properties\":{\"deviceId\":{\"type\":\"string\"}},\"required\":[\"deviceId\"]}",
        HttpMethod = "GET",
        EndpointTemplate = "https://example.com/devices/{deviceId}"
    };

    private static McpToolDefinition CreateTool(Guid settingsId, string name, bool enabled) => new()
    {
        AISettingsId = settingsId,
        Name = name,
        Title = name,
        Description = "test tool",
        InputSchemaJson = ValidDefinition().InputSchemaJson,
        HttpMethod = "GET",
        EndpointTemplate = "https://example.com/devices/{deviceId}",
        Enabled = enabled
    };

    private sealed class TestModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}
