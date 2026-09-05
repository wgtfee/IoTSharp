#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using IoTSharp.Models;
using IoTSharp.Services.DigitalTwin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Controllers;

/// <summary>
/// 参数化/智能数字孪生组件注册 API。
/// 组件与 GLB 共用 TwinModelResources 表；组件定义保存在 ModelMetadata，
/// 不需要伪造 GLB 文件，也不要求额外数据库迁移。
/// </summary>
[Route("api/digital-twin/model-resources/components")]
[Authorize]
[ApiController]
public sealed class TwinComponentResourcesController : ControllerBase
{
    private const string AdminRoles = "CustomerAdmin,TenantAdmin,SystemAdmin";
    private const string ComponentRuntimeFormat = "application/vnd.iotsharp.twin-component+json";
    private readonly ApplicationDbContext _context;

    public TwinComponentResourcesController(ApplicationDbContext context) => _context = context;

    /// <summary>
    /// 按 resourceKey Upsert 一个参数化/智能组件资源。
    /// </summary>
    [HttpPost("upsert")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<TwinModelResourceDto>> Upsert(
        [FromBody] TwinComponentResourceRegistrationRequest request,
        CancellationToken cancellationToken)
    {
        var profile = this.GetUserProfile();
        var validation = Validate(request);
        if (validation != null)
        {
            return new ApiResult<TwinModelResourceDto>(ApiCode.InValidData, validation, default!);
        }

        var key = NormalizeKey(request.ResourceKey);
        var now = DateTime.UtcNow;
        var metadata = BuildMetadata(request);
        var metadataJson = JsonSerializer.Serialize(metadata, JsonOptions);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(metadataJson)));
        var resource = await _context.TwinModelResources.FirstOrDefaultAsync(item =>
            !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer && item.ResourceKey == key,
            cancellationToken);

        if (resource == null)
        {
            resource = new TwinModelResource
            {
                Id = Guid.NewGuid(),
                ResourceKey = key,
                CreatedAt = now,
                CreatedBy = ResolveActor(profile),
                TenantId = profile.Tenant,
                CustomerId = profile.Customer,
            };
            _context.TwinModelResources.Add(resource);
        }

        resource.Name = request.Name.Trim();
        resource.SourceType = TwinModelSourceType.ModelLibrary;
        resource.RuntimeFormat = ComponentRuntimeFormat;
        resource.OriginalFileName = string.Empty;
        resource.StoragePath = string.Empty;
        resource.FileSize = 0;
        resource.ContentHash = hash;
        resource.NodeIndex = "{}";
        resource.ModelMetadata = metadataJson;
        resource.ProcessingStatus = TwinModelProcessingStatus.Ready;
        resource.LicenseMetadata = JsonSerializer.Serialize(new
        {
            licenseType = "IoTSharp-BuiltIn",
            commercialUseAllowed = true,
            author = "IoTSharp"
        }, JsonOptions);
        resource.PreviewResourcePath = string.Empty;
        resource.UpdatedAt = now;
        resource.UpdatedBy = ResolveActor(profile);
        resource.Deleted = false;

        await _context.SaveChangesAsync(cancellationToken);
        return new ApiResult<TwinModelResourceDto>(ApiCode.Success, "OK", TwinModelResourceService.ToDto(resource));
    }

    /// <summary>
    /// 批量注册内置组件模板。重复 resourceKey 自动更新，不重复插入。
    /// </summary>
    [HttpPost("batch")]
    [Authorize(Roles = AdminRoles)]
    public async Task<ApiResult<List<TwinModelResourceDto>>> Batch(
        [FromBody] List<TwinComponentResourceRegistrationRequest> requests,
        CancellationToken cancellationToken)
    {
        if (requests == null || requests.Count == 0)
        {
            return new ApiResult<List<TwinModelResourceDto>>(ApiCode.InValidData, "组件注册清单不能为空。", []);
        }
        if (requests.Count > 100)
        {
            return new ApiResult<List<TwinModelResourceDto>>(ApiCode.InValidData, "一次最多注册 100 个组件。", []);
        }

        foreach (var request in requests)
        {
            var validation = Validate(request);
            if (validation != null)
            {
                return new ApiResult<List<TwinModelResourceDto>>(ApiCode.InValidData, $"{request?.ResourceKey}: {validation}", []);
            }
        }

        var profile = this.GetUserProfile();
        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        var keys = requests.Select(item => NormalizeKey(item.ResourceKey)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (keys.Length != requests.Count)
        {
            return new ApiResult<List<TwinModelResourceDto>>(ApiCode.InValidData, "注册清单中存在重复 resourceKey。", []);
        }

        var existingRows = await _context.TwinModelResources
            .Where(item => !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer && keys.Contains(item.ResourceKey))
            .ToListAsync(cancellationToken);
        var existing = existingRows.ToDictionary(item => item.ResourceKey, StringComparer.OrdinalIgnoreCase);
        var result = new List<TwinModelResourceDto>(requests.Count);

        foreach (var request in requests)
        {
            var key = NormalizeKey(request.ResourceKey);
            if (!existing.TryGetValue(key, out var resource))
            {
                resource = new TwinModelResource
                {
                    Id = Guid.NewGuid(),
                    ResourceKey = key,
                    CreatedAt = now,
                    CreatedBy = actor,
                    TenantId = profile.Tenant,
                    CustomerId = profile.Customer,
                };
                _context.TwinModelResources.Add(resource);
                existing[key] = resource;
            }

            var metadataJson = JsonSerializer.Serialize(BuildMetadata(request), JsonOptions);
            resource.Name = request.Name.Trim();
            resource.SourceType = TwinModelSourceType.ModelLibrary;
            resource.RuntimeFormat = ComponentRuntimeFormat;
            resource.OriginalFileName = string.Empty;
            resource.StoragePath = string.Empty;
            resource.FileSize = 0;
            resource.ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(metadataJson)));
            resource.NodeIndex = "{}";
            resource.ModelMetadata = metadataJson;
            resource.ProcessingStatus = TwinModelProcessingStatus.Ready;
            resource.LicenseMetadata = JsonSerializer.Serialize(new
            {
                licenseType = "IoTSharp-BuiltIn",
                commercialUseAllowed = true,
                author = "IoTSharp"
            }, JsonOptions);
            resource.PreviewResourcePath = string.Empty;
            resource.UpdatedAt = now;
            resource.UpdatedBy = actor;
            resource.Deleted = false;
        }

        await _context.SaveChangesAsync(cancellationToken);
        foreach (var key in keys)
        {
            if (existing.TryGetValue(key, out var resource)) result.Add(TwinModelResourceService.ToDto(resource));
        }
        return new ApiResult<List<TwinModelResourceDto>>(ApiCode.Success, "OK", result);
    }

    private static object BuildMetadata(TwinComponentResourceRegistrationRequest request) => new
    {
        resourceKey = NormalizeKey(request.ResourceKey),
        resourceType = request.ResourceType,
        componentType = request.ComponentType,
        generator = request.Generator,
        generatorVersion = request.GeneratorVersion,
        category = request.Category,
        tags = request.Tags ?? [],
        capabilities = request.Capabilities ?? [],
        defaultProperties = request.DefaultProperties,
        componentSchema = request.ComponentSchema,
        ports = request.Ports,
        bindingSlots = request.BindingSlots.ValueKind == JsonValueKind.Array ? request.BindingSlots : JsonSerializer.SerializeToElement(Array.Empty<object>(), JsonOptions),
        builtIn = true,
        metadataVersion = 1
    };

    private static string? Validate(TwinComponentResourceRegistrationRequest? request)
    {
        if (request == null) return "请求不能为空。";
        if (string.IsNullOrWhiteSpace(request.ResourceKey)) return "resourceKey 不能为空。";
        if (string.IsNullOrWhiteSpace(request.Name)) return "name 不能为空。";
        if (request.ResourceType is not ("procedural-component" or "smart-model")) return "resourceType 仅支持 procedural-component / smart-model。";
        if (string.IsNullOrWhiteSpace(request.ComponentType)) return "componentType 不能为空。";
        if (string.IsNullOrWhiteSpace(request.Generator)) return "generator 不能为空。";
        if (request.GeneratorVersion <= 0) return "generatorVersion 必须大于 0。";
        if (request.DefaultProperties.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return "defaultProperties 不能为空。";
        if (request.ComponentSchema.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return "componentSchema 不能为空。";
        if (request.Ports.ValueKind != JsonValueKind.Array) return "ports 必须是数组。";
        if (request.Capabilities?.Contains("material-flow", StringComparer.OrdinalIgnoreCase) == true
            && request.Ports.GetArrayLength() == 0)
        {
            return "具有 material-flow 能力的组件必须至少定义一个物料端口。";
        }
        if (request.BindingSlots.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Array)) return "bindingSlots 必须是数组。";
        return null;
    }

    private static string NormalizeKey(string value)
    {
        var chars = value.Trim().ToLowerInvariant().Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' ? character : '-').ToArray();
        var normalized = new string(chars).Trim('-');
        if (string.IsNullOrWhiteSpace(normalized)) throw new ArgumentException("resourceKey 无效。", nameof(value));
        return normalized[..Math.Min(normalized.Length, 128)];
    }

    private static string ResolveActor(UserProfile profile) =>
        !string.IsNullOrWhiteSpace(profile.Name) ? profile.Name : !string.IsNullOrWhiteSpace(profile.Email) ? profile.Email : profile.Id.ToString("D");

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };
}

public sealed class TwinComponentResourceRegistrationRequest
{
    public string ResourceKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ResourceType { get; set; } = "procedural-component";
    public string ComponentType { get; set; } = string.Empty;
    public string Generator { get; set; } = string.Empty;
    public int GeneratorVersion { get; set; } = 1;
    public string Category { get; set; } = "conveyor";
    public List<string>? Tags { get; set; }
    public List<string>? Capabilities { get; set; }
    public JsonElement DefaultProperties { get; set; }
    public JsonElement ComponentSchema { get; set; }
    public JsonElement Ports { get; set; }
    public JsonElement BindingSlots { get; set; }
}
