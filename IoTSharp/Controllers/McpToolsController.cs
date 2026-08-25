using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Dtos;
using IoTSharp.Extensions;
using IoTSharp.Services.Mcp;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// 当前租户/客户 AISettings 下的动态 MCP Tool 管理。
/// </summary>
[ApiController]
[Authorize(Roles = "CustomerAdmin,TenantAdmin,SystemAdmin")]
[Route("api/mcp-tools/{scope}/{scopeId:guid}")]
public sealed class McpToolsController : ControllerBase
{
    private readonly ApplicationDbContext _context;
    private readonly DynamicMcpToolService _toolService;

    public McpToolsController(ApplicationDbContext context, DynamicMcpToolService toolService)
    {
        _context = context;
        _toolService = toolService;
    }

    [HttpGet]
    public async Task<ApiResult<List<McpToolDefinitionDto>>> List(
        string scope,
        Guid scopeId,
        CancellationToken cancellationToken)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return Failure<List<McpToolDefinitionDto>>(resolved.Error, new());
        if (resolved.Settings == null) return new ApiResult<List<McpToolDefinitionDto>>(new());

        var items = await _context.McpToolDefinitions.AsNoTracking()
            .Where(item => item.AISettingsId == resolved.Settings.Id && !item.Deleted)
            .OrderBy(item => item.Name)
            .Select(item => ToDto(item))
            .ToListAsync(cancellationToken);
        return new ApiResult<List<McpToolDefinitionDto>>(items);
    }

    [HttpPost]
    public async Task<ApiResult<McpToolDefinitionDto>> Create(
        string scope,
        Guid scopeId,
        [FromBody] SaveMcpToolDefinitionDto dto,
        CancellationToken cancellationToken)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return Failure<McpToolDefinitionDto>(resolved.Error);
        if (resolved.Settings == null)
            return Failure<McpToolDefinitionDto>("请先在 AI/MCP 页面保存服务设置并生成 API Key，再新增 Tool。");

        var validationError = DynamicMcpToolService.ValidateDefinition(dto);
        if (validationError != null) return Failure<McpToolDefinitionDto>(validationError);
        if (await _context.McpToolDefinitions.AnyAsync(item => item.AISettingsId == resolved.Settings.Id
            && item.Name == dto.Name && !item.Deleted, cancellationToken))
            return new ApiResult<McpToolDefinitionDto>(ApiCode.AlreadyExists, $"Tool {dto.Name} 已存在。", null);

        var userName = ResolveUserName();
        var definition = new McpToolDefinition
        {
            AISettingsId = resolved.Settings.Id,
            Name = dto.Name,
            Title = dto.Title,
            Description = dto.Description,
            HandlerType = DynamicMcpToolService.HandlerTypeHttpApi,
            InputSchemaJson = dto.InputSchemaJson,
            HttpMethod = dto.HttpMethod,
            EndpointTemplate = dto.EndpointTemplate,
            ProtectedHeaders = _toolService.ProtectHeaders(dto.HeadersJson ?? "{}"),
            TimeoutSeconds = dto.TimeoutSeconds,
            Enabled = dto.Enabled,
            ReadOnlyHint = dto.ReadOnlyHint,
            AllowPrivateNetwork = dto.AllowPrivateNetwork,
            CreatedBy = userName,
            UpdatedBy = userName
        };
        _context.McpToolDefinitions.Add(definition);
        await _context.SaveChangesAsync(cancellationToken);
        return new ApiResult<McpToolDefinitionDto>(ToDto(definition));
    }

    [HttpPut("{id:guid}")]
    public async Task<ApiResult<McpToolDefinitionDto>> Update(
        string scope,
        Guid scopeId,
        Guid id,
        [FromBody] SaveMcpToolDefinitionDto dto,
        CancellationToken cancellationToken)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return Failure<McpToolDefinitionDto>(resolved.Error);
        if (resolved.Settings == null) return Failure<McpToolDefinitionDto>("当前作用域尚未配置 AI/MCP 服务。");

        var validationError = DynamicMcpToolService.ValidateDefinition(dto);
        if (validationError != null) return Failure<McpToolDefinitionDto>(validationError);
        var definition = await _context.McpToolDefinitions.SingleOrDefaultAsync(item => item.Id == id
            && item.AISettingsId == resolved.Settings.Id && !item.Deleted, cancellationToken);
        if (definition == null) return Failure<McpToolDefinitionDto>("未找到指定 Tool。", null, ApiCode.CantFindObject);
        if (await _context.McpToolDefinitions.AnyAsync(item => item.Id != id
            && item.AISettingsId == resolved.Settings.Id && item.Name == dto.Name && !item.Deleted, cancellationToken))
            return new ApiResult<McpToolDefinitionDto>(ApiCode.AlreadyExists, $"Tool {dto.Name} 已存在。", null);

        definition.Name = dto.Name;
        definition.Title = dto.Title;
        definition.Description = dto.Description;
        definition.HandlerType = DynamicMcpToolService.HandlerTypeHttpApi;
        definition.InputSchemaJson = dto.InputSchemaJson;
        definition.HttpMethod = dto.HttpMethod;
        definition.EndpointTemplate = dto.EndpointTemplate;
        definition.TimeoutSeconds = dto.TimeoutSeconds;
        definition.Enabled = dto.Enabled;
        definition.ReadOnlyHint = dto.ReadOnlyHint;
        definition.AllowPrivateNetwork = dto.AllowPrivateNetwork;
        definition.UpdatedAt = DateTime.UtcNow;
        definition.UpdatedBy = ResolveUserName();
        if (dto.HeadersJson != null) definition.ProtectedHeaders = _toolService.ProtectHeaders(dto.HeadersJson);
        await _context.SaveChangesAsync(cancellationToken);
        return new ApiResult<McpToolDefinitionDto>(ToDto(definition));
    }

    [HttpDelete("{id:guid}")]
    public async Task<ApiResult> Delete(string scope, Guid scopeId, Guid id, CancellationToken cancellationToken)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return new ApiResult(ApiCode.NotAuthorized, resolved.Error);
        if (resolved.Settings == null) return new ApiResult(ApiCode.CantFindObject, "当前作用域尚未配置 AI/MCP 服务。");
        var definition = await _context.McpToolDefinitions.SingleOrDefaultAsync(item => item.Id == id
            && item.AISettingsId == resolved.Settings.Id && !item.Deleted, cancellationToken);
        if (definition == null) return new ApiResult(ApiCode.CantFindObject, "未找到指定 Tool。");

        definition.Deleted = true;
        definition.Enabled = false;
        definition.UpdatedAt = DateTime.UtcNow;
        definition.UpdatedBy = ResolveUserName();
        await _context.SaveChangesAsync(cancellationToken);
        return new ApiResult(ApiCode.Success, "OK");
    }

    [HttpPost("{id:guid}/test")]
    public async Task<ApiResult<McpToolExecutionResultDto>> Test(
        string scope,
        Guid scopeId,
        Guid id,
        [FromBody] TestMcpToolDto dto,
        CancellationToken cancellationToken)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return Failure<McpToolExecutionResultDto>(resolved.Error);
        if (resolved.Settings == null) return Failure<McpToolExecutionResultDto>("当前作用域尚未配置 AI/MCP 服务。");
        var definition = await _context.McpToolDefinitions.SingleOrDefaultAsync(item => item.Id == id
            && item.AISettingsId == resolved.Settings.Id && !item.Deleted, cancellationToken);
        if (definition == null) return Failure<McpToolExecutionResultDto>("未找到指定 Tool。", null, ApiCode.CantFindObject);

        var result = await _toolService.ExecuteAsync(definition, dto?.Arguments, "AdminTest", cancellationToken);
        return new ApiResult<McpToolExecutionResultDto>(result);
    }

    [HttpGet("{id:guid}/invocations")]
    public async Task<ApiResult<List<McpToolInvocationDto>>> Invocations(
        string scope,
        Guid scopeId,
        Guid id,
        [FromQuery] int take = 50,
        CancellationToken cancellationToken = default)
    {
        var resolved = await ResolveSettingsAsync(scope, scopeId, cancellationToken);
        if (resolved.Error != null) return Failure<List<McpToolInvocationDto>>(resolved.Error, new());
        if (resolved.Settings == null) return new ApiResult<List<McpToolInvocationDto>>(new());
        take = Math.Clamp(take, 1, 200);
        var exists = await _context.McpToolDefinitions.AnyAsync(item => item.Id == id
            && item.AISettingsId == resolved.Settings.Id && !item.Deleted, cancellationToken);
        if (!exists) return Failure<List<McpToolInvocationDto>>("未找到指定 Tool。", new(), ApiCode.CantFindObject);

        var logs = await _context.McpToolInvocationLogs.AsNoTracking()
            .Where(item => item.ToolDefinitionId == id && item.AISettingsId == resolved.Settings.Id)
            .OrderByDescending(item => item.StartedAt)
            .Take(take)
            .Select(item => new McpToolInvocationDto
            {
                Id = item.Id,
                ToolName = item.ToolName,
                InvocationSource = item.InvocationSource,
                ArgumentKeys = item.ArgumentKeys,
                StartedAt = item.StartedAt,
                DurationMs = item.DurationMs,
                Succeeded = item.Succeeded,
                StatusCode = item.StatusCode,
                ResponseSize = item.ResponseSize,
                ErrorMessage = item.ErrorMessage
            }).ToListAsync(cancellationToken);
        return new ApiResult<List<McpToolInvocationDto>>(logs);
    }

    private async Task<(AISettings Settings, string Error)> ResolveSettingsAsync(
        string scope,
        Guid scopeId,
        CancellationToken cancellationToken)
    {
        var profile = this.GetUserProfile();
        var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
        if (scope.Equals("customer", StringComparison.OrdinalIgnoreCase))
        {
            var customer = await _context.Customer.Include(item => item.Tenant).Include(item => item.AISettings)
                .SingleOrDefaultAsync(item => item.Id == scopeId && !item.Deleted, cancellationToken);
            if (customer == null) return (null, "未找到指定客户。");
            var allowed = systemAdmin
                || (User.IsInRole(nameof(UserRole.CustomerAdmin)) && profile.Customer == scopeId && profile.Tenant == customer.Tenant.Id)
                || (User.IsInRole(nameof(UserRole.TenantAdmin)) && profile.Tenant == customer.Tenant.Id);
            return allowed ? (customer.AISettings, null) : (null, "无权管理该客户的 MCP Tool。");
        }

        if (scope.Equals("tenant", StringComparison.OrdinalIgnoreCase))
        {
            var tenant = await _context.Tenant.Include(item => item.AISettings)
                .SingleOrDefaultAsync(item => item.Id == scopeId && !item.Deleted, cancellationToken);
            if (tenant == null) return (null, "未找到指定租户。");
            var allowed = systemAdmin || (User.IsInRole(nameof(UserRole.TenantAdmin)) && profile.Tenant == scopeId);
            return allowed ? (tenant.AISettings, null) : (null, "无权管理该租户的 MCP Tool。");
        }

        return (null, "scope 仅支持 customer 或 tenant。");
    }

    private string ResolveUserName()
    {
        var profile = this.GetUserProfile();
        if (!string.IsNullOrWhiteSpace(profile.Name)) return profile.Name;
        if (!string.IsNullOrWhiteSpace(profile.Email)) return profile.Email;
        return profile.Id.ToString("D");
    }

    private static McpToolDefinitionDto ToDto(McpToolDefinition item) => new()
    {
        Id = item.Id,
        Name = item.Name,
        Title = item.Title,
        Description = item.Description,
        HandlerType = item.HandlerType,
        InputSchemaJson = item.InputSchemaJson,
        HttpMethod = item.HttpMethod,
        EndpointTemplate = item.EndpointTemplate,
        HasProtectedHeaders = !string.IsNullOrWhiteSpace(item.ProtectedHeaders),
        TimeoutSeconds = item.TimeoutSeconds,
        Enabled = item.Enabled,
        ReadOnlyHint = item.ReadOnlyHint,
        AllowPrivateNetwork = item.AllowPrivateNetwork,
        CreatedAt = item.CreatedAt,
        UpdatedAt = item.UpdatedAt
    };

    private static ApiResult<T> Failure<T>(string message, T data = default, ApiCode code = ApiCode.InValidData)
        => new(code, message, data);
}
