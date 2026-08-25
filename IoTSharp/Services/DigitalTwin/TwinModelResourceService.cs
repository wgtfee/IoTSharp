#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Data;
using IoTSharp.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Storage.Net.Blobs;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// 数字孪生 GLB 模型资源的安全入库、元数据检查和授权访问服务。
/// </summary>
public sealed class TwinModelResourceService
{
    private const long MaxModelBytes = 100L * 1024 * 1024;
    private const int MaxJsonChunkBytes = 32 * 1024 * 1024;
    private const uint GlbMagic = 0x46546C67;
    private const uint JsonChunkType = 0x4E4F534A;
    private static readonly JsonSerializerOptions WebJsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ApplicationDbContext _context;
    private readonly IBlobStorage _blob;

    public TwinModelResourceService(ApplicationDbContext context, IBlobStorage blob)
    {
        _context = context;
        _blob = blob;
    }

    /// <summary>
    /// 查询当前租户可使用的模型资源。
    /// </summary>
    public async Task<List<TwinModelResourceDto>> ListAsync(UserProfile profile, string? name, TwinModelProcessingStatus? status, CancellationToken cancellationToken)
    {
        var query = _context.TwinModelResources.AsNoTracking()
            .Where(item => !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer);
        if (!string.IsNullOrWhiteSpace(name)) query = query.Where(item => item.Name.Contains(name.Trim()) || item.ResourceKey.Contains(name.Trim()));
        if (status.HasValue) query = query.Where(item => item.ProcessingStatus == status.Value);
        return (await query.OrderByDescending(item => item.UpdatedAt).ToListAsync(cancellationToken)).Select(ToDto).ToList();
    }

    /// <summary>
    /// 获取模型元数据和处理状态。
    /// </summary>
    public async Task<TwinModelResourceDto?> GetAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var resource = await FindAsync(id, profile, cancellationToken);
        return resource == null ? null : ToDto(resource);
    }

    /// <summary>
    /// 上传并检查单文件 GLB。检查通过后资源直接进入 Ready，生产环境可在此处接入扫描队列。
    /// </summary>
    public async Task<TwinModelResourceDto> UploadAsync(TwinModelResourceUploadRequest request, UserProfile profile, CancellationToken cancellationToken)
    {
        if (request.File == null || request.File.Length <= 0) throw new TwinOperationException(ApiCode.NotFile, "请选择 GLB 模型文件。");
        if (request.File.Length > MaxModelBytes) throw new TwinOperationException(ApiCode.InValidData, "模型文件不能超过 100 MB。");
        var originalFileName = Path.GetFileName(request.File.FileName);
        if (!originalFileName.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
        {
            throw new TwinOperationException(ApiCode.InValidData, "首期模型资源只支持单文件 GLB。");
        }

        var resourceId = Guid.NewGuid();
        var resourceKey = NormalizeKey(request.ResourceKey, resourceId);
        if (await _context.TwinModelResources.AnyAsync(item =>
                !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer && item.ResourceKey == resourceKey,
                cancellationToken))
        {
            throw new TwinOperationException(ApiCode.AlreadyExists, "resourceKey 已存在。");
        }

        if (request.ProductId.HasValue && !await _context.Products.AnyAsync(item =>
                item.Id == request.ProductId && !item.Deleted && item.Tenant.Id == profile.Tenant && item.Customer.Id == profile.Customer,
                cancellationToken))
        {
            throw new TwinOperationException(ApiCode.NotFoundProduct, "关联 Product 不存在或无权访问。");
        }

        var tempFile = Path.GetTempFileName();
        GlbInspection glbInspection;
        string hash;
        try
        {
            hash = await CopyToTempAndHashAsync(request.File, tempFile, cancellationToken);
            glbInspection = InspectGlb(tempFile, request.File.Length);
            var existing = await _context.TwinModelResources.AsNoTracking().FirstOrDefaultAsync(item =>
                !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer && item.ContentHash == hash,
                cancellationToken);
            if (existing != null)
            {
                throw new TwinOperationException(ApiCode.AlreadyExists, $"相同内容的模型已经存在：{existing.Name}。");
            }

            var storagePath = BuildBlobPath(profile.Tenant, profile.Customer, resourceId);
            await _blob.WriteFileAsync(storagePath, tempFile);
            var now = DateTime.UtcNow;
            var actor = ResolveActor(profile);
            var license = new TwinModelLicenseDto
            {
                LicenseType = NormalizeLicenseType(request.LicenseType),
                LicenseTextUrl = NormalizeOptionalUrl(request.LicenseTextUrl),
                SourceUrl = NormalizeOptionalUrl(request.SourceUrl),
                Author = request.Author?.Trim(),
                CommercialUseAllowed = request.CommercialUseAllowed
            };
            var resource = new TwinModelResource
            {
                Id = resourceId,
                ResourceKey = resourceKey,
                Name = string.IsNullOrWhiteSpace(request.Name) ? Path.GetFileNameWithoutExtension(originalFileName) : request.Name.Trim(),
                SourceType = request.SourceType,
                RuntimeFormat = "model/gltf-binary",
                OriginalFileName = originalFileName,
                StoragePath = storagePath,
                FileSize = request.File.Length,
                ContentHash = hash,
                NodeIndex = glbInspection.NodeIndexJson,
                ModelMetadata = glbInspection.MetadataJson,
                ProcessingStatus = TwinModelProcessingStatus.Ready,
                LicenseMetadata = JsonSerializer.Serialize(license, WebJsonOptions),
                ProductId = request.ProductId,
                PreviewResourcePath = string.Empty,
                CreatedAt = now,
                UpdatedAt = now,
                CreatedBy = actor,
                UpdatedBy = actor,
                TenantId = profile.Tenant,
                CustomerId = profile.Customer
            };
            _context.TwinModelResources.Add(resource);
            AddAudit(profile, resource, "TwinModelUpload", new
            {
                resource.ResourceKey,
                resource.OriginalFileName,
                resource.FileSize,
                resource.ContentHash,
                glbInspection.NodeCount,
                glbInspection.MeshCount,
                glbInspection.TriangleCount,
                license.CommercialUseAllowed
            }, "Ready", now);
            await _context.SaveChangesAsync(cancellationToken);
            return ToDto(resource);
        }
        finally
        {
            TryDeleteTempFile(tempFile);
        }
    }

    /// <summary>
    /// 更新模型授权元数据，模型二进制和内容 Hash 保持不变。
    /// </summary>
    public async Task<TwinModelResourceDto> UpdateLicenseAsync(Guid id, TwinModelLicenseUpdateRequest request, UserProfile profile, CancellationToken cancellationToken)
    {
        var resource = await FindAsync(id, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "模型资源不存在。");
        var license = new TwinModelLicenseDto
        {
            LicenseType = NormalizeLicenseType(request.LicenseType),
            LicenseTextUrl = NormalizeOptionalUrl(request.LicenseTextUrl),
            SourceUrl = NormalizeOptionalUrl(request.SourceUrl),
            Author = request.Author?.Trim(),
            CommercialUseAllowed = request.CommercialUseAllowed
        };
        var now = DateTime.UtcNow;
        resource.LicenseMetadata = JsonSerializer.Serialize(license, WebJsonOptions);
        resource.UpdatedAt = now;
        resource.UpdatedBy = ResolveActor(profile);
        AddAudit(profile, resource, "TwinModelApprove", new { license.LicenseType, license.CommercialUseAllowed }, "Updated", now);
        await _context.SaveChangesAsync(cancellationToken);
        return ToDto(resource);
    }

    /// <summary>
    /// 打开经过租户授权的模型内容。调用方负责释放返回流。
    /// </summary>
    public async Task<TwinModelContent?> OpenContentAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var resource = await FindAsync(id, profile, cancellationToken);
        if (resource == null || resource.ProcessingStatus != TwinModelProcessingStatus.Ready) return null;
        var stream = await _blob.OpenReadAsync(resource.StoragePath);
        return new TwinModelContent(stream, resource.OriginalFileName, resource.RuntimeFormat, resource.ContentHash, resource.FileSize);
    }

    /// <summary>
    /// 软删除未被任何发布版本引用的模型资源。
    /// </summary>
    public async Task DeleteAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var resource = await FindAsync(id, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "模型资源不存在。");
        var publishedReferenceExists = await _context.TwinObjectBindings.AnyAsync(item =>
            !item.Deleted && item.ModelResourceId == id && item.SceneVersionId != null &&
            item.TenantId == profile.Tenant && item.CustomerId == profile.Customer,
            cancellationToken);
        if (publishedReferenceExists)
        {
            throw new TwinOperationException(ApiCode.DoNotAllow, "模型已被发布场景引用，不能删除。");
        }
        var now = DateTime.UtcNow;
        resource.Deleted = true;
        resource.UpdatedAt = now;
        resource.UpdatedBy = ResolveActor(profile);
        AddAudit(profile, resource, "TwinModelDelete", new { resource.ResourceKey, resource.ContentHash }, "Deleted", now);
        await _context.SaveChangesAsync(cancellationToken);
    }

    private async Task<TwinModelResource?> FindAsync(Guid id, UserProfile profile, CancellationToken cancellationToken) =>
        await _context.TwinModelResources.FirstOrDefaultAsync(item =>
            item.Id == id && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer,
            cancellationToken);

    private static GlbInspection InspectGlb(string path, long expectedLength)
    {
        using var stream = File.OpenRead(path);
        Span<byte> header = stackalloc byte[12];
        if (stream.Read(header) != header.Length) throw new TwinOperationException(ApiCode.InValidData, "GLB 文件头不完整。");
        var magic = BinaryPrimitives.ReadUInt32LittleEndian(header[..4]);
        var version = BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(4, 4));
        var declaredLength = BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(8, 4));
        if (magic != GlbMagic || version != 2) throw new TwinOperationException(ApiCode.InValidData, "文件不是有效的 glTF 2.0 GLB。");
        if (declaredLength != expectedLength || declaredLength != stream.Length) throw new TwinOperationException(ApiCode.InValidData, "GLB 声明长度与文件长度不一致。");

        Span<byte> chunkHeader = stackalloc byte[8];
        if (stream.Read(chunkHeader) != chunkHeader.Length) throw new TwinOperationException(ApiCode.InValidData, "GLB 缺少 JSON chunk。");
        var jsonLength = BinaryPrimitives.ReadUInt32LittleEndian(chunkHeader[..4]);
        var chunkType = BinaryPrimitives.ReadUInt32LittleEndian(chunkHeader.Slice(4, 4));
        if (chunkType != JsonChunkType || jsonLength <= 0 || jsonLength > MaxJsonChunkBytes || stream.Position + jsonLength > stream.Length)
        {
            throw new TwinOperationException(ApiCode.InValidData, "GLB JSON chunk 无效或过大。");
        }
        var jsonBytes = new byte[jsonLength];
        if (stream.Read(jsonBytes, 0, jsonBytes.Length) != jsonBytes.Length) throw new TwinOperationException(ApiCode.InValidData, "GLB JSON chunk 不完整。");
        var json = Encoding.UTF8.GetString(jsonBytes).TrimEnd('\0', ' ', '\t', '\r', '\n');
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 128 });
        return InspectGltfJson(document.RootElement);
    }

    private static GlbInspection InspectGltfJson(JsonElement root)
    {
        RejectExternalUris(root, "buffers");
        RejectExternalUris(root, "images");
        var nodes = root.TryGetProperty("nodes", out var nodeArray) && nodeArray.ValueKind == JsonValueKind.Array ? nodeArray : default;
        var meshes = root.TryGetProperty("meshes", out var meshArray) && meshArray.ValueKind == JsonValueKind.Array ? meshArray : default;
        var accessors = root.TryGetProperty("accessors", out var accessorArray) && accessorArray.ValueKind == JsonValueKind.Array ? accessorArray : default;
        var nodeIndex = new List<object>();
        if (nodes.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var node in nodes.EnumerateArray())
            {
                nodeIndex.Add(new
                {
                    index,
                    name = node.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String ? name.GetString() : $"Node_{index}",
                    mesh = node.TryGetProperty("mesh", out var mesh) && mesh.TryGetInt32(out var meshIndex) ? meshIndex : (int?)null,
                    children = node.TryGetProperty("children", out var children) && children.ValueKind == JsonValueKind.Array
                        ? children.EnumerateArray().Where(item => item.TryGetInt32(out _)).Select(item => item.GetInt32()).ToArray()
                        : []
                });
                index += 1;
            }
        }

        long triangleCount = 0;
        if (meshes.ValueKind == JsonValueKind.Array)
        {
            foreach (var mesh in meshes.EnumerateArray())
            {
                if (!mesh.TryGetProperty("primitives", out var primitives) || primitives.ValueKind != JsonValueKind.Array) continue;
                foreach (var primitive in primitives.EnumerateArray())
                {
                    var accessorIndex = primitive.TryGetProperty("indices", out var indices) && indices.TryGetInt32(out var indexAccessor)
                        ? indexAccessor
                        : GetPositionAccessor(primitive);
                    var count = GetAccessorCount(accessors, accessorIndex);
                    var mode = primitive.TryGetProperty("mode", out var modeElement) && modeElement.TryGetInt32(out var parsedMode) ? parsedMode : 4;
                    if (mode == 4) triangleCount += count / 3;
                }
            }
        }

        var nodeCount = nodes.ValueKind == JsonValueKind.Array ? nodes.GetArrayLength() : 0;
        var meshCount = meshes.ValueKind == JsonValueKind.Array ? meshes.GetArrayLength() : 0;
        var materialCount = GetArrayLength(root, "materials");
        var textureCount = GetArrayLength(root, "textures");
        var animationCount = GetArrayLength(root, "animations");
        var metadata = new
        {
            gltfVersion = root.TryGetProperty("asset", out var asset) && asset.TryGetProperty("version", out var assetVersion) ? assetVersion.GetString() : "2.0",
            nodeCount,
            meshCount,
            materialCount,
            textureCount,
            animationCount,
            triangleCount,
            unit = "meter",
            upAxis = "Y",
            forwardAxis = "+Z"
        };
        return new GlbInspection(
            JsonSerializer.Serialize(new { nodes = nodeIndex }, WebJsonOptions),
            JsonSerializer.Serialize(metadata, WebJsonOptions),
            nodeCount,
            meshCount,
            triangleCount);
    }

    private static void RejectExternalUris(JsonElement root, string collectionName)
    {
        if (!root.TryGetProperty(collectionName, out var collection) || collection.ValueKind != JsonValueKind.Array) return;
        foreach (var item in collection.EnumerateArray())
        {
            if (item.TryGetProperty("uri", out var uri) && uri.ValueKind == JsonValueKind.String)
            {
                throw new TwinOperationException(ApiCode.InValidData, $"GLB {collectionName} 不能引用外部 URI。");
            }
        }
    }

    private static int GetPositionAccessor(JsonElement primitive)
    {
        if (!primitive.TryGetProperty("attributes", out var attributes) || attributes.ValueKind != JsonValueKind.Object ||
            !attributes.TryGetProperty("POSITION", out var position) || !position.TryGetInt32(out var index)) return -1;
        return index;
    }

    private static long GetAccessorCount(JsonElement accessors, int index)
    {
        if (index < 0 || accessors.ValueKind != JsonValueKind.Array || index >= accessors.GetArrayLength()) return 0;
        var accessor = accessors[index];
        return accessor.TryGetProperty("count", out var count) && count.TryGetInt64(out var value) ? value : 0;
    }

    private static int GetArrayLength(JsonElement root, string propertyName) =>
        root.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() : 0;

    private static async Task<string> CopyToTempAndHashAsync(IFormFile file, string tempFile, CancellationToken cancellationToken)
    {
        await using var input = file.OpenReadStream();
        await using var output = File.Create(tempFile);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
        {
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            hash.AppendData(buffer, 0, read);
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    internal static TwinModelResourceDto ToDto(TwinModelResource resource) => new()
    {
        Id = resource.Id,
        ResourceKey = resource.ResourceKey,
        Name = resource.Name,
        SourceType = resource.SourceType,
        RuntimeFormat = resource.RuntimeFormat,
        OriginalFileName = resource.OriginalFileName,
        FileSize = resource.FileSize,
        ContentHash = resource.ContentHash,
        NodeIndex = ParseJson(resource.NodeIndex),
        ModelMetadata = ParseJson(resource.ModelMetadata),
        ProcessingStatus = resource.ProcessingStatus,
        License = ParseLicense(resource.LicenseMetadata),
        ProductId = resource.ProductId,
        CreatedAt = resource.CreatedAt,
        UpdatedAt = resource.UpdatedAt,
        CreatedBy = resource.CreatedBy ?? string.Empty
    };

    private static JsonElement ParseJson(string? json)
    {
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        return document.RootElement.Clone();
    }

    private static TwinModelLicenseDto ParseLicense(string? json)
    {
        try { return JsonSerializer.Deserialize<TwinModelLicenseDto>(json ?? "{}", WebJsonOptions) ?? new(); }
        catch (JsonException) { return new(); }
    }

    private void AddAudit(UserProfile profile, TwinModelResource resource, string action, object data, string result, DateTime now)
    {
        _context.AuditLog.Add(new AuditLog
        {
            TenantId = profile.Tenant,
            CustomerId = profile.Customer,
            UserId = profile.Id.ToString("D"),
            UserName = ResolveActor(profile),
            ObjectID = resource.Id,
            ObjectName = resource.Name,
            ObjectType = ObjectType.TwinModelResource,
            ActionName = action,
            ActionData = JsonSerializer.Serialize(data, WebJsonOptions),
            ActionResult = result,
            ActiveDateTime = now
        });
    }

    private static string NormalizeKey(string? requested, Guid id)
    {
        if (string.IsNullOrWhiteSpace(requested)) return $"model-{id:N}";
        var chars = requested.Trim().ToLowerInvariant().Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' ? character : '-').ToArray();
        var normalized = new string(chars).Trim('-');
        return string.IsNullOrWhiteSpace(normalized) ? $"model-{id:N}" : normalized[..Math.Min(normalized.Length, 128)];
    }

    private static string NormalizeLicenseType(string? value) => string.IsNullOrWhiteSpace(value) ? "Proprietary" : value.Trim()[..Math.Min(value.Trim().Length, 128)];

    private static string? NormalizeOptionalUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            throw new TwinOperationException(ApiCode.InValidData, "授权或来源地址必须是 http/https URL。");
        }
        return uri.ToString();
    }

    private static string ResolveActor(UserProfile profile) =>
        !string.IsNullOrWhiteSpace(profile.Name) ? profile.Name : !string.IsNullOrWhiteSpace(profile.Email) ? profile.Email : profile.Id.ToString("D");

    private static string BuildBlobPath(Guid tenantId, Guid customerId, Guid resourceId) =>
        $"digital-twin/{tenantId:N}/{customerId:N}/models/{resourceId:N}/runtime/model.glb";

    private static void TryDeleteTempFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

public sealed record TwinModelContent(Stream Stream, string FileName, string ContentType, string Hash, long Length);

internal sealed record GlbInspection(string NodeIndexJson, string MetadataJson, int NodeCount, int MeshCount, long TriangleCount);
