#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Models;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// 数字孪生场景草稿、资源绑定、发布版本和回滚的领域服务。
/// </summary>
public sealed class DigitalTwinSceneService
{
    private static readonly JsonSerializerOptions WebJsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ApplicationDbContext _context;

    public DigitalTwinSceneService(ApplicationDbContext context)
    {
        _context = context;
    }

    /// <summary>
    /// 查询当前租户和客户范围内的场景。
    /// </summary>
    public async Task<List<DigitalTwinSceneDto>> ListAsync(
        UserProfile profile,
        Guid? rootAssetId,
        string? name,
        DigitalTwinSceneStatus? status,
        CancellationToken cancellationToken)
    {
        var query = _context.DigitalTwinScenes
            .AsNoTracking()
            .Include(item => item.RootAsset)
            .Include(item => item.PublishedVersion)
            .Where(item => !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer);

        if (rootAssetId.HasValue) query = query.Where(item => item.RootAssetId == rootAssetId.Value);
        if (status.HasValue) query = query.Where(item => item.Status == status.Value);
        if (!string.IsNullOrWhiteSpace(name)) query = query.Where(item => item.Name.Contains(name.Trim()));

        return (await query.OrderByDescending(item => item.UpdatedAt).ToListAsync(cancellationToken))
            .Select(ToSceneDto)
            .ToList();
    }

    /// <summary>
    /// 获取场景草稿、草稿绑定和路线。
    /// </summary>
    public async Task<DigitalTwinSceneDetailDto?> GetAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken);
        return scene == null ? null : ToSceneDetailDto(scene);
    }

    /// <summary>
    /// 创建一个归属于根 Asset 的场景，并把初始对象资源绑定和路线写入数据库。
    /// </summary>
    public async Task<DigitalTwinSceneDetailDto> CreateAsync(
        DigitalTwinSceneCreateDto request,
        UserProfile profile,
        CancellationToken cancellationToken)
    {
        var asset = await FindAssetAsync(request.RootAssetId, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "Root Asset 不存在或不在当前租户范围内。");
        var name = request.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new TwinOperationException(ApiCode.InValidData, "场景名称不能为空。");

        var sceneId = Guid.NewGuid();
        var sceneKey = NormalizeKey(request.SceneKey, sceneId);
        if (await _context.DigitalTwinScenes.AnyAsync(item =>
                !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer && item.SceneKey == sceneKey,
                cancellationToken))
        {
            throw new TwinOperationException(ApiCode.AlreadyExists, "同一租户下的 sceneKey 已存在。");
        }

        var payload = request.DraftPayload is { } supplied && supplied.ValueKind == JsonValueKind.Object
            ? supplied
            : CreateDefaultManifest(sceneId, request.RootAssetId, name, request.Description);
        var inspection = TwinManifestInspector.Inspect(payload, sceneId, request.RootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, false, cancellationToken);
        ThrowIfInvalid(inspection);

        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        var scene = new DigitalTwinScene
        {
            Id = sceneId,
            SceneKey = sceneKey,
            Name = name,
            Description = request.Description?.Trim() ?? string.Empty,
            RootAssetId = asset.Id,
            Status = DigitalTwinSceneStatus.Draft,
            DraftPayload = inspection.NormalizedPayload,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = actor,
            UpdatedBy = actor,
            TenantId = profile.Tenant,
            CustomerId = profile.Customer
        };

        _context.DigitalTwinScenes.Add(scene);
        ReplaceDraftBindings(scene, inspection.Bindings, profile, actor, now);
        ReplaceDraftRoutes(scene, inspection.Routes, profile, actor, now);
        AddAudit(profile, scene.Id, scene.Name, "TwinSceneCreate", new { scene.SceneKey, scene.RootAssetId, scene.Revision }, "Created", now);
        await _context.SaveChangesAsync(cancellationToken);

        scene.RootAsset = asset;
        return ToSceneDetailDto(scene);
    }

    /// <summary>
    /// 修改场景元数据。根 Asset 变化时会同步规范化草稿和对象默认绑定。
    /// </summary>
    public async Task<DigitalTwinSceneDetailDto> UpdateAsync(
        Guid id,
        DigitalTwinSceneUpdateDto request,
        UserProfile profile,
        CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var asset = await FindAssetAsync(request.RootAssetId, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "Root Asset 不存在或不在当前租户范围内。");
        if (string.IsNullOrWhiteSpace(request.Name)) throw new TwinOperationException(ApiCode.InValidData, "场景名称不能为空。");

        var payload = JsonNode.Parse(scene.DraftPayload)?.AsObject()
            ?? throw new TwinOperationException(ApiCode.InValidData, "场景草稿不是有效的 JSON 对象。");
        payload["name"] = request.Name.Trim();
        payload["description"] = request.Description?.Trim() ?? string.Empty;
        using var document = JsonDocument.Parse(payload.ToJsonString(WebJsonOptions));
        var inspection = TwinManifestInspector.Inspect(document.RootElement, scene.Id, request.RootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, false, cancellationToken);
        ThrowIfInvalid(inspection);

        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        scene.Name = request.Name.Trim();
        scene.Description = request.Description?.Trim() ?? string.Empty;
        scene.RootAssetId = asset.Id;
        scene.DraftPayload = inspection.NormalizedPayload;
        scene.Revision += 1;
        scene.UpdatedAt = now;
        scene.UpdatedBy = actor;
        ReplaceDraftBindings(scene, inspection.Bindings, profile, actor, now);
        ReplaceDraftRoutes(scene, inspection.Routes, profile, actor, now);
        AddAudit(profile, scene.Id, scene.Name, "TwinSceneMetadataUpdate", new { scene.RootAssetId, scene.Revision }, "Updated", now);
        await _context.SaveChangesAsync(cancellationToken);
        scene.RootAsset = asset;
        return ToSceneDetailDto(scene);
    }

    /// <summary>
    /// 使用 revision 乐观并发保存草稿，并同步更新数据库中的资源、设备绑定和路线。
    /// </summary>
    public async Task<DigitalTwinSceneDetailDto> SaveDraftAsync(
        Guid id,
        DigitalTwinDraftSaveDto request,
        UserProfile profile,
        CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var name = request.Name?.Trim() ?? scene.Name;
        if (string.IsNullOrWhiteSpace(name)) throw new TwinOperationException(ApiCode.InValidData, "场景名称不能为空。");
        var rootAssetId = request.RootAssetId ?? scene.RootAssetId;
        var asset = await FindAssetAsync(rootAssetId, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "Root Asset 不存在或不在当前租户范围内。");
        var payload = JsonNode.Parse(request.Payload.GetRawText())?.AsObject()
            ?? throw new TwinOperationException(ApiCode.InValidData, "场景草稿不是有效的 JSON 对象。");
        payload["name"] = name;
        payload["description"] = request.Description?.Trim() ?? scene.Description ?? string.Empty;
        payload["rootAssetId"] = rootAssetId.ToString("D");
        using var document = JsonDocument.Parse(payload.ToJsonString(WebJsonOptions));
        var inspection = TwinManifestInspector.Inspect(document.RootElement, scene.Id, rootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, false, cancellationToken);
        ThrowIfInvalid(inspection);

        if (scene.Revision != request.Revision)
        {
            // HTTP 响应中断时，数据库可能已经完整提交，而浏览器仍持有旧 revision。
            // 相同 Manifest 的重试属于幂等提交，直接返回服务器当前草稿，避免页面
            // 永久陷入“实际已保存、随后每次都版本冲突”的状态。
            var sameCommittedDraft = string.Equals(scene.Name, name, StringComparison.Ordinal)
                && string.Equals(scene.Description ?? string.Empty, request.Description?.Trim() ?? scene.Description ?? string.Empty, StringComparison.Ordinal)
                && scene.RootAssetId == rootAssetId
                && string.Equals(ComputeSha256(scene.DraftPayload), ComputeSha256(inspection.NormalizedPayload), StringComparison.Ordinal);
            if (sameCommittedDraft) return ToSceneDetailDto(scene);

            throw new TwinOperationException(ApiCode.InValidData, $"草稿版本冲突，服务器 revision={scene.Revision}，请重新加载后再保存。");
        }

        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        scene.Name = name;
        scene.Description = request.Description?.Trim() ?? scene.Description ?? string.Empty;
        scene.RootAssetId = rootAssetId;
        scene.RootAsset = asset;
        scene.DraftPayload = inspection.NormalizedPayload;
        scene.Revision += 1;
        scene.UpdatedAt = now;
        scene.UpdatedBy = actor;
        ReplaceDraftBindings(scene, inspection.Bindings, profile, actor, now);
        ReplaceDraftRoutes(scene, inspection.Routes, profile, actor, now);
        AddAudit(profile, scene.Id, scene.Name, "TwinSceneDraftCommit", new
        {
            scene.Revision,
            scene.RootAssetId,
            bindingCount = inspection.Bindings.Count,
            routeCount = inspection.Routes.Count,
            manifestHash = ComputeSha256(inspection.NormalizedPayload)
        }, "Saved", now);
        try
        {
            await _context.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException exception)
        {
            var conflicts = string.Join(", ", exception.Entries.Select(entry =>
            {
                var key = string.Join("/", entry.Properties
                    .Where(property => property.Metadata.IsPrimaryKey())
                    .Select(property => property.CurrentValue?.ToString() ?? "null"));
                var tokens = string.Join("/", entry.Properties
                    .Where(property => property.Metadata.IsConcurrencyToken)
                    .Select(property => $"{property.Metadata.Name}:{property.OriginalValue}->{property.CurrentValue}"));
                return $"{entry.Metadata.ClrType.Name}[{key}]({tokens})";
            }));
            throw new TwinOperationException(ApiCode.InValidData, $"草稿关联数据发生并发冲突：{conflicts}。请重新加载场景后重试。", exception);
        }
        return ToSceneDetailDto(scene);
    }

    /// <summary>
    /// 校验草稿结构、模型授权和所有 Asset/Device 数据库引用。
    /// </summary>
    public async Task<TwinValidationResultDto> ValidateAsync(Guid id, UserProfile profile, bool forPublish, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, false, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        using var document = JsonDocument.Parse(scene.DraftPayload);
        var inspection = TwinManifestInspector.Inspect(document.RootElement, scene.Id, scene.RootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, forPublish, cancellationToken);
        return new TwinValidationResultDto { Diagnostics = inspection.Diagnostics };
    }

    /// <summary>
    /// 发布不可变版本，并把该版本的资源与 Device 绑定、路线快照同时入库。
    /// </summary>
    public async Task<DigitalTwinSceneVersionDto> PublishAsync(
        Guid id,
        DigitalTwinPublishDto request,
        UserProfile profile,
        CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        if (scene.Revision != request.Revision)
        {
            throw new TwinOperationException(ApiCode.InValidData, $"发布版本冲突，服务器 revision={scene.Revision}。");
        }

        using var document = JsonDocument.Parse(scene.DraftPayload);
        var inspection = TwinManifestInspector.Inspect(document.RootElement, scene.Id, scene.RootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, true, cancellationToken);
        ThrowIfInvalid(inspection);

        // 发布同一个草稿 revision 是幂等操作。这样即使首次发布已经提交、响应在
        // 返回途中中断，重试也只会返回现有线上版本，不会制造重复版本。
        if (scene.PublishedVersion is not null
            && scene.PublishedVersion.SourceRevision == scene.Revision
            && string.Equals(scene.PublishedVersion.ManifestHash, ComputeSha256(inspection.NormalizedPayload), StringComparison.Ordinal))
        {
            return ToVersionDto(scene.PublishedVersion, true);
        }

        var versionNumber = (await _context.DigitalTwinSceneVersions
            .Where(item => item.SceneId == scene.Id)
            .MaxAsync(item => (int?)item.Version, cancellationToken) ?? 0) + 1;
        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        var validationReport = JsonSerializer.Serialize(new TwinValidationResultDto { Diagnostics = inspection.Diagnostics }, WebJsonOptions);
        var version = new DigitalTwinSceneVersion
        {
            Id = Guid.NewGuid(),
            SceneId = scene.Id,
            Version = versionNumber,
            SourceRevision = scene.Revision,
            SchemaVersion = DigitalTwinContractVersions.SceneV1,
            Manifest = inspection.NormalizedPayload,
            ManifestHash = ComputeSha256(inspection.NormalizedPayload),
            ValidationReport = validationReport,
            ChangeSummary = request.ChangeSummary?.Trim() ?? string.Empty,
            CreatedAt = now,
            CreatedBy = actor,
            TenantId = profile.Tenant,
            CustomerId = profile.Customer
        };
        _context.DigitalTwinSceneVersions.Add(version);
        CopyPublishedBindings(scene, version, profile, actor, now);
        CopyPublishedRoutes(scene, version, profile, actor, now);
        scene.PublishedVersionId = version.Id;
        scene.PublishedVersion = version;
        scene.Status = DigitalTwinSceneStatus.Published;
        scene.UpdatedAt = now;
        scene.UpdatedBy = actor;
        AddAudit(profile, scene.Id, scene.Name, "TwinScenePublish", new
        {
            version.Id,
            version.Version,
            version.ManifestHash,
            bindingCount = scene.Bindings.Count(item => !item.Deleted && item.SceneVersionId == null),
            routeCount = scene.Routes.Count(item => !item.Deleted && item.SceneVersionId == null)
        }, "Published", now);
        await _context.SaveChangesAsync(cancellationToken);
        return ToVersionDto(version, true);
    }

    /// <summary>
    /// 查询场景不可变版本历史。
    /// </summary>
    public async Task<List<DigitalTwinSceneVersionDto>> ListVersionsAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, false, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var versions = await _context.DigitalTwinSceneVersions.AsNoTracking()
            .Where(item => item.SceneId == scene.Id && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
            .OrderByDescending(item => item.Version)
            .ToListAsync(cancellationToken);
        return versions.Select(item => ToVersionDto(item, item.Id == scene.PublishedVersionId)).ToList();
    }

    public async Task<DigitalTwinSceneVersionDto> GetVersionAsync(Guid id, int versionNumber, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, false, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var version = await _context.DigitalTwinSceneVersions.AsNoTracking().FirstOrDefaultAsync(item =>
            item.SceneId == scene.Id && item.Version == versionNumber && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer,
            cancellationToken) ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景版本不存在。");
        return ToVersionDto(version, version.Id == scene.PublishedVersionId, true);
    }

    /// <summary>
    /// 从不可变历史版本创建一个新草稿；当前发布指针和历史版本均不修改。
    /// </summary>
    public async Task<DigitalTwinSceneDetailDto> RollbackAsync(Guid id, int versionNumber, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var version = await _context.DigitalTwinSceneVersions.FirstOrDefaultAsync(item =>
            item.SceneId == scene.Id && item.Version == versionNumber && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer,
            cancellationToken) ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景版本不存在。");
        using var document = JsonDocument.Parse(version.Manifest);
        var inspection = TwinManifestInspector.Inspect(document.RootElement, scene.Id, scene.RootAssetId);
        await AppendReferenceDiagnosticsAsync(inspection, profile, false, cancellationToken);
        ThrowIfInvalid(inspection);
        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        scene.DraftPayload = inspection.NormalizedPayload;
        scene.Revision += 1;
        scene.UpdatedAt = now;
        scene.UpdatedBy = actor;
        ReplaceDraftBindings(scene, inspection.Bindings, profile, actor, now);
        ReplaceDraftRoutes(scene, inspection.Routes, profile, actor, now);
        AddAudit(profile, scene.Id, scene.Name, "TwinSceneRollbackDraft", new { version.Id, version.Version, version.ManifestHash, scene.Revision }, "DraftCreated", now);
        await _context.SaveChangesAsync(cancellationToken);
        return ToSceneDetailDto(scene);
    }

    /// <summary>
    /// 获取当前发布运行清单、Hash 和版本号。
    /// </summary>
    public async Task<TwinRuntimeManifest?> GetRuntimeManifestAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await _context.DigitalTwinScenes.AsNoTracking()
            .Where(item => item.Id == id && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
            .FirstOrDefaultAsync(cancellationToken);
        if (scene?.PublishedVersionId == null) return null;
        var version = await _context.DigitalTwinSceneVersions.AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == scene.PublishedVersionId && item.SceneId == scene.Id, cancellationToken);
        return version == null ? null : new TwinRuntimeManifest(version.Manifest, version.ManifestHash, version.Version, version.Id);
    }

    /// <summary>
    /// 软删除场景并立即下线运行清单；已发布的不可变版本和版本绑定仍保留审计。
    /// </summary>
    public async Task DeleteAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await FindSceneAsync(id, profile, true, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        var now = DateTime.UtcNow;
        scene.Deleted = true;
        scene.UpdatedAt = now;
        scene.UpdatedBy = ResolveActor(profile);
        foreach (var binding in scene.Bindings.Where(item => item.SceneVersionId == null)) binding.Deleted = true;
        foreach (var route in scene.Routes.Where(item => item.SceneVersionId == null)) route.Deleted = true;
        AddAudit(profile, scene.Id, scene.Name, "TwinSceneDelete", new { scene.SceneKey, scene.PublishedVersionId }, "Deleted", now);
        await _context.SaveChangesAsync(cancellationToken);
    }

    private async Task<DigitalTwinScene?> FindSceneAsync(Guid id, UserProfile profile, bool includeDraftRelations, CancellationToken cancellationToken)
    {
        IQueryable<DigitalTwinScene> query = _context.DigitalTwinScenes
            .Include(item => item.RootAsset)
            .Include(item => item.PublishedVersion)
            .Where(item => item.Id == id && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer);
        if (includeDraftRelations)
        {
            query = query.Include(item => item.Bindings).Include(item => item.Routes);
        }
        return await query.FirstOrDefaultAsync(cancellationToken);
    }

    private async Task<Asset?> FindAssetAsync(Guid id, UserProfile profile, CancellationToken cancellationToken) =>
        await _context.Assets.Include(item => item.Tenant).Include(item => item.Customer)
            .FirstOrDefaultAsync(item => item.Id == id && !item.Deleted && item.Tenant.Id == profile.Tenant && item.Customer.Id == profile.Customer, cancellationToken);

    private async Task AppendReferenceDiagnosticsAsync(
        TwinManifestInspection inspection,
        UserProfile profile,
        bool forPublish,
        CancellationToken cancellationToken)
    {
        if (inspection.ResourceIds.Count > 0)
        {
            var resources = await _context.TwinModelResources.AsNoTracking()
                .Where(item => inspection.ResourceIds.Contains(item.Id) && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
                .ToListAsync(cancellationToken);
            foreach (var resourceId in inspection.ResourceIds.Except(resources.Select(item => item.Id)))
            {
                inspection.Diagnostics.Add(Error("twin.resource.not-found", $"模型资源 {resourceId:D} 不存在或无权访问。", "resources"));
            }
            if (forPublish)
            {
                foreach (var resource in resources)
                {
                    if (resource.ProcessingStatus != TwinModelProcessingStatus.Ready)
                    {
                        inspection.Diagnostics.Add(Error("twin.resource.not-ready", $"模型资源 {resource.Name} 尚未 Ready。", "resources"));
                    }
                    if (!CommercialUseAllowed(resource.LicenseMetadata))
                    {
                        inspection.Diagnostics.Add(Error("twin.resource.license", $"模型资源 {resource.Name} 尚未确认商业使用授权。", "resources"));
                    }
                }
            }
        }

        var assetIds = inspection.Bindings.Where(item => item.AssetId.HasValue).Select(item => item.AssetId!.Value).Distinct().ToList();
        if (assetIds.Count > 0)
        {
            var availableAssetIds = await _context.Assets.AsNoTracking()
                .Where(item => assetIds.Contains(item.Id) && !item.Deleted && item.Tenant.Id == profile.Tenant && item.Customer.Id == profile.Customer)
                .Select(item => item.Id)
                .ToListAsync(cancellationToken);
            foreach (var assetId in assetIds.Except(availableAssetIds))
            {
                inspection.Diagnostics.Add(Error("twin.binding.asset.not-found", $"绑定 Asset {assetId:D} 不存在或无权访问。", "bindings"));
            }
        }

        var deviceIds = inspection.Bindings.Where(item => item.DeviceId.HasValue).Select(item => item.DeviceId!.Value).Distinct().ToList();
        if (deviceIds.Count > 0)
        {
            var availableDeviceIds = await _context.Device.AsNoTracking()
                .Where(item => deviceIds.Contains(item.Id) && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
                .Select(item => item.Id)
                .ToListAsync(cancellationToken);
            foreach (var deviceId in deviceIds.Except(availableDeviceIds))
            {
                inspection.Diagnostics.Add(Error("twin.binding.device.not-found", $"绑定 Device {deviceId:D} 不存在或无权访问。", "bindings"));
            }
        }
    }

    private void ReplaceDraftBindings(DigitalTwinScene scene, List<TwinBindingDraft> drafts, UserProfile profile, string actor, DateTime now)
    {
        var existing = scene.Bindings.Where(item => item.SceneVersionId == null).ToDictionary(item => item.BindingKey, StringComparer.Ordinal);
        foreach (var draft in drafts)
        {
            if (!existing.Remove(draft.BindingKey, out var entity))
            {
                entity = new TwinObjectBinding
                {
                    Id = Guid.NewGuid(),
                    SceneId = scene.Id,
                    Scene = scene,
                    SceneVersionId = null,
                    BindingKey = draft.BindingKey,
                    CreatedAt = now,
                    CreatedBy = actor,
                    TenantId = profile.Tenant,
                    CustomerId = profile.Customer
                };
                scene.Bindings.Add(entity);
            }
            ApplyBinding(entity, draft, actor, now);
        }
        foreach (var removed in existing.Values)
        {
            removed.Deleted = true;
            removed.UpdatedAt = now;
            removed.UpdatedBy = actor;
        }
    }

    private void ReplaceDraftRoutes(DigitalTwinScene scene, List<TwinRouteDraft> drafts, UserProfile profile, string actor, DateTime now)
    {
        var existing = scene.Routes.Where(item => item.SceneVersionId == null).ToDictionary(item => item.RouteKey, StringComparer.Ordinal);
        foreach (var draft in drafts)
        {
            if (!existing.Remove(draft.RouteKey, out var entity))
            {
                entity = new TwinRoute
                {
                    Id = Guid.NewGuid(),
                    SceneId = scene.Id,
                    Scene = scene,
                    SceneVersionId = null,
                    RouteKey = draft.RouteKey,
                    Revision = 1,
                    CreatedAt = now,
                    CreatedBy = actor,
                    TenantId = profile.Tenant,
                    CustomerId = profile.Customer
                };
                scene.Routes.Add(entity);
            }
            else
            {
                entity.Revision += 1;
            }
            entity.Name = draft.Name;
            entity.RouteType = draft.RouteType;
            entity.GraphPayload = draft.GraphPayload;
            entity.Enabled = draft.Enabled;
            entity.Deleted = false;
            entity.UpdatedAt = now;
            entity.UpdatedBy = actor;
        }
        foreach (var removed in existing.Values)
        {
            removed.Deleted = true;
            removed.UpdatedAt = now;
            removed.UpdatedBy = actor;
        }
    }

    private static void ApplyBinding(TwinObjectBinding entity, TwinBindingDraft draft, string actor, DateTime now)
    {
        entity.ObjectId = draft.ObjectId;
        entity.NodePath = draft.NodePath;
        entity.ModelResourceId = draft.ModelResourceId;
        entity.AssetId = draft.AssetId;
        entity.DeviceId = draft.DeviceId;
        entity.SemanticId = draft.SemanticId;
        entity.SourceKind = draft.SourceKind;
        entity.SourceKey = draft.SourceKey;
        entity.TargetKind = draft.TargetKind;
        entity.TargetPath = draft.TargetPath;
        entity.TransformKind = draft.TransformKind;
        entity.TransformConfig = draft.TransformConfig;
        entity.Priority = draft.Priority;
        entity.StaleAfterMs = draft.StaleAfterMs;
        entity.Enabled = draft.Enabled;
        entity.Deleted = false;
        entity.UpdatedAt = now;
        entity.UpdatedBy = actor;
    }

    private static void CopyPublishedBindings(DigitalTwinScene scene, DigitalTwinSceneVersion version, UserProfile profile, string actor, DateTime now)
    {
        // Adding a tracked version binding also fixes up scene.Bindings. Materialize the
        // draft source first so EF cannot mutate the collection currently being enumerated.
        foreach (var source in scene.Bindings.Where(item => item.SceneVersionId == null && !item.Deleted).ToList())
        {
            version.Bindings.Add(new TwinObjectBinding
            {
                Id = Guid.NewGuid(), SceneId = scene.Id, Scene = scene, SceneVersionId = version.Id, SceneVersion = version,
                BindingKey = source.BindingKey, ObjectId = source.ObjectId, NodePath = source.NodePath,
                ModelResourceId = source.ModelResourceId, AssetId = source.AssetId, DeviceId = source.DeviceId,
                SemanticId = source.SemanticId, SourceKind = source.SourceKind, SourceKey = source.SourceKey,
                TargetKind = source.TargetKind, TargetPath = source.TargetPath, TransformKind = source.TransformKind,
                TransformConfig = source.TransformConfig, Priority = source.Priority, StaleAfterMs = source.StaleAfterMs,
                Enabled = source.Enabled, CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor,
                TenantId = profile.Tenant, CustomerId = profile.Customer
            });
        }
    }

    private static void CopyPublishedRoutes(DigitalTwinScene scene, DigitalTwinSceneVersion version, UserProfile profile, string actor, DateTime now)
    {
        // See CopyPublishedBindings: relationship fix-up appends snapshots to scene.Routes.
        foreach (var source in scene.Routes.Where(item => item.SceneVersionId == null && !item.Deleted).ToList())
        {
            version.Routes.Add(new TwinRoute
            {
                Id = Guid.NewGuid(), SceneId = scene.Id, Scene = scene, SceneVersionId = version.Id, SceneVersion = version,
                RouteKey = source.RouteKey, Name = source.Name, RouteType = source.RouteType,
                GraphPayload = source.GraphPayload, Revision = source.Revision, Enabled = source.Enabled,
                CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor,
                TenantId = profile.Tenant, CustomerId = profile.Customer
            });
        }
    }

    private void AddAudit(UserProfile profile, Guid objectId, string objectName, string action, object data, string result, DateTime now)
    {
        _context.AuditLog.Add(new AuditLog
        {
            TenantId = profile.Tenant,
            CustomerId = profile.Customer,
            UserId = profile.Id.ToString("D"),
            UserName = ResolveActor(profile),
            ObjectID = objectId,
            ObjectName = objectName,
            ObjectType = ObjectType.DigitalTwinScene,
            ActionName = action,
            ActionData = JsonSerializer.Serialize(data, WebJsonOptions),
            ActionResult = result,
            ActiveDateTime = now
        });
    }

    private static JsonElement CreateDefaultManifest(Guid sceneId, Guid rootAssetId, string name, string? description)
    {
        var root = new JsonObject
        {
            ["schemaVersion"] = DigitalTwinContractVersions.SceneV1,
            ["sceneId"] = sceneId.ToString("D"),
            ["name"] = name,
            ["description"] = description ?? string.Empty,
            ["rootAssetId"] = rootAssetId.ToString("D"),
            ["world"] = new JsonObject { ["unit"] = "meter", ["upAxis"] = "Y", ["background"] = "#07111f" },
            ["resources"] = new JsonArray(),
            ["objects"] = new JsonArray
            {
                new JsonObject
                {
                    ["objectId"] = "baseline-conveyor",
                    ["name"] = "程序化输送线",
                    ["kind"] = "procedural",
                    ["assetId"] = rootAssetId.ToString("D"),
                    ["transform"] = DefaultTransform()
                },
                new JsonObject
                {
                    ["objectId"] = "moving-package",
                    ["name"] = "路线测试物料",
                    ["kind"] = "procedural",
                    ["assetId"] = rootAssetId.ToString("D"),
                    ["transform"] = DefaultTransform()
                }
            },
            ["bindings"] = new JsonArray(),
            ["routes"] = new JsonArray
            {
                new JsonObject
                {
                    ["routeId"] = "conveyor-main",
                    ["name"] = "包装多路线输送",
                    ["type"] = "conveyor",
                    ["curveKind"] = "catmullRom",
                    ["defaultSpeed"] = 1.2,
                    ["loop"] = true,
                    ["orientToPath"] = true,
                    ["startPointId"] = "entry",
                    ["points"] = new JsonArray
                    {
                        RoutePoint("entry", "入口", -6, 0.72, -2, "station"),
                        RoutePoint("turn-in", "转弯前", -1.5, 0.72, -2),
                        RoutePoint("turn-out", "包装分流器", 2.5, 0.72, 1.8, "diverter"),
                        RoutePoint("exit", "主线出口", 6, 0.72, 1.8, "station"),
                        RoutePoint("branch-exit", "支线出口", 4.5, 0.72, 5, "station"),
                        RoutePoint("merge", "包装汇流器", -4, 0.72, 4, "merger")
                    },
                    ["edges"] = new JsonArray
                    {
                        RouteEdge("entry-segment", "entry", "turn-in", "入口段", capacity: 4),
                        RouteEdge("junction-in", "turn-in", "turn-out", "进分流器", capacity: 2),
                        RouteEdge("main-out", "turn-out", "exit", "主包装线", priority: 10, capacity: 3),
                        RouteEdge("branch-out", "turn-out", "branch-exit", "支包装线", capacity: 3),
                        RouteEdge("main-merge", "exit", "merge", "主线汇流", capacity: 2),
                        RouteEdge("branch-merge", "branch-exit", "merge", "支线汇流", capacity: 2),
                        RouteEdge("return-entry", "merge", "entry", "回流入口", capacity: 4)
                    },
                    ["junctionDecisions"] = new JsonObject { ["turn-out"] = "main-out" },
                    ["routingMode"] = "automatic",
                    ["decisionRules"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["ruleId"] = "route-rule-sku-b",
                            ["name"] = "SKU-B 进入支包装线",
                            ["junctionPointId"] = "turn-out",
                            ["edgeId"] = "branch-out",
                            ["source"] = "payload",
                            ["payloadKey"] = "sku",
                            ["operator"] = "equals",
                            ["matchValue"] = "B",
                            ["priority"] = 100,
                            ["enabled"] = true
                        }
                    }
                }
            },
            ["runtime"] = new JsonObject { ["dataMode"] = "simulation", ["maxPixelRatio"] = 2, ["showGrid"] = true },
			["editorExtension"] = new JsonObject { ["source"] = "threejs-editor", ["payloadVersion"] = 2 }
        };
        using var document = JsonDocument.Parse(root.ToJsonString(WebJsonOptions));
        return document.RootElement.Clone();
    }

    private static JsonObject DefaultTransform() => new()
    {
        ["position"] = new JsonArray(0, 0, 0),
        ["rotation"] = new JsonArray(0, 0, 0),
        ["scale"] = new JsonArray(1, 1, 1)
    };

    private static JsonObject RoutePoint(string id, string name, double x, double y, double z, string kind = "waypoint") => new()
    {
        ["pointId"] = id,
        ["name"] = name,
        ["position"] = new JsonArray(x, y, z),
        ["kind"] = kind
    };

    private static JsonObject RouteEdge(string id, string fromPointId, string toPointId, string name, int priority = 0, int capacity = 1) => new()
    {
        ["edgeId"] = id,
        ["fromPointId"] = fromPointId,
        ["toPointId"] = toPointId,
        ["name"] = name,
        ["bidirectional"] = false,
        ["enabled"] = true,
        ["priority"] = priority,
        ["capacity"] = capacity
    };

    private static DigitalTwinSceneDto ToSceneDto(DigitalTwinScene scene) => new()
    {
        Id = scene.Id,
        SceneKey = scene.SceneKey,
        Name = scene.Name,
        Description = scene.Description ?? string.Empty,
        RootAssetId = scene.RootAssetId,
        RootAssetName = scene.RootAsset?.Name ?? string.Empty,
        Status = scene.Status,
        PublishedVersionId = scene.PublishedVersionId,
        PublishedVersion = scene.PublishedVersion?.Version,
        PublishedSourceRevision = scene.PublishedVersion?.SourceRevision,
        Revision = scene.Revision,
        CreatedAt = scene.CreatedAt,
        UpdatedAt = scene.UpdatedAt,
        CreatedBy = scene.CreatedBy ?? string.Empty,
        UpdatedBy = scene.UpdatedBy ?? string.Empty
    };

    private static DigitalTwinSceneDetailDto ToSceneDetailDto(DigitalTwinScene scene)
    {
        var summary = ToSceneDto(scene);
        return new DigitalTwinSceneDetailDto
        {
            Id = summary.Id,
            SceneKey = summary.SceneKey,
            Name = summary.Name,
            Description = summary.Description,
            RootAssetId = summary.RootAssetId,
            RootAssetName = summary.RootAssetName,
            Status = summary.Status,
            PublishedVersionId = summary.PublishedVersionId,
            PublishedVersion = summary.PublishedVersion,
            PublishedSourceRevision = summary.PublishedSourceRevision,
            Revision = summary.Revision,
            CreatedAt = summary.CreatedAt,
            UpdatedAt = summary.UpdatedAt,
            CreatedBy = summary.CreatedBy,
            UpdatedBy = summary.UpdatedBy,
            DraftPayload = ParseJson(scene.DraftPayload),
            Bindings = scene.Bindings.Where(item => item.SceneVersionId == null && !item.Deleted).OrderBy(item => item.Priority).Select(ToBindingDto).ToList(),
            Routes = scene.Routes.Where(item => item.SceneVersionId == null && !item.Deleted).Select(ToRouteDto).ToList()
        };
    }

    private static TwinObjectBindingDto ToBindingDto(TwinObjectBinding item) => new()
    {
        Id = item.Id,
        SceneId = item.SceneId,
        SceneVersionId = item.SceneVersionId,
        BindingKey = item.BindingKey,
        ObjectId = item.ObjectId,
        NodePath = item.NodePath,
        ModelResourceId = item.ModelResourceId,
        AssetId = item.AssetId,
        DeviceId = item.DeviceId,
        SemanticId = item.SemanticId,
        SourceKind = item.SourceKind,
        SourceKey = item.SourceKey,
        TargetKind = item.TargetKind,
        TargetPath = item.TargetPath,
        TransformKind = item.TransformKind,
        TransformConfig = ParseJson(item.TransformConfig),
        Priority = item.Priority,
        StaleAfterMs = item.StaleAfterMs,
        Enabled = item.Enabled
    };

    private static TwinRouteDto ToRouteDto(TwinRoute item) => new()
    {
        Id = item.Id,
        SceneId = item.SceneId,
        SceneVersionId = item.SceneVersionId,
        RouteKey = item.RouteKey,
        Name = item.Name,
        RouteType = item.RouteType,
        GraphPayload = ParseJson(item.GraphPayload),
        Revision = item.Revision,
        Enabled = item.Enabled
    };

    private static DigitalTwinSceneVersionDto ToVersionDto(DigitalTwinSceneVersion version, bool current, bool includeManifest = false) => new()
    {
        Id = version.Id,
        SceneId = version.SceneId,
        Version = version.Version,
        SourceDraftRevision = version.SourceRevision,
        SchemaVersion = version.SchemaVersion,
        ManifestHash = version.ManifestHash,
        ChangeSummary = version.ChangeSummary ?? string.Empty,
        ValidationReport = ParseJson(version.ValidationReport),
        Manifest = includeManifest ? ParseJson(version.Manifest) : null,
        CreatedAt = version.CreatedAt,
        CreatedBy = version.CreatedBy ?? string.Empty,
        IsCurrent = current
    };

    private static JsonElement ParseJson(string? json)
    {
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        return document.RootElement.Clone();
    }

    private static string NormalizeKey(string? requested, Guid id)
    {
        if (string.IsNullOrWhiteSpace(requested)) return $"scene-{id:N}";
        var chars = requested.Trim().ToLowerInvariant().Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' ? character : '-').ToArray();
        var normalized = new string(chars).Trim('-');
        return string.IsNullOrWhiteSpace(normalized) ? $"scene-{id:N}" : normalized[..Math.Min(normalized.Length, 128)];
    }

    private static string ResolveActor(UserProfile profile) =>
        !string.IsNullOrWhiteSpace(profile.Name) ? profile.Name : !string.IsNullOrWhiteSpace(profile.Email) ? profile.Email : profile.Id.ToString("D");

    private static string ComputeSha256(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool CommercialUseAllowed(string? metadata)
    {
        try
        {
            return JsonSerializer.Deserialize<TwinModelLicenseDto>(metadata ?? "{}", WebJsonOptions)?.CommercialUseAllowed == true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static TwinValidationDiagnosticDto Error(string code, string message, string? path = null) => new()
    {
        Severity = "error", Code = code, Message = message, Path = path
    };

    private static void ThrowIfInvalid(TwinManifestInspection inspection)
    {
        if (inspection.Valid) return;
        throw new TwinValidationException(new TwinValidationResultDto { Diagnostics = inspection.Diagnostics });
    }
}

/// <summary>
/// 数字孪生服务可预期业务错误。
/// </summary>
public sealed class TwinOperationException : Exception
{
    public TwinOperationException(ApiCode code, string message) : base(message) => Code = code;
    public TwinOperationException(ApiCode code, string message, Exception innerException) : base(message, innerException) => Code = code;
    public ApiCode Code { get; }
}

/// <summary>
/// 包含完整诊断的场景清单校验异常。
/// </summary>
public sealed class TwinValidationException : Exception
{
    public TwinValidationException(TwinValidationResultDto validation)
        : base(validation.Diagnostics.FirstOrDefault()?.Message ?? "场景清单校验失败。") => Validation = validation;
    public TwinValidationResultDto Validation { get; }
}

public sealed record TwinRuntimeManifest(string Payload, string Hash, int Version, Guid VersionId);
