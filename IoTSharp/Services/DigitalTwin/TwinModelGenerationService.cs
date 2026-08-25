#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Data;
using IoTSharp.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Storage.Net.Blobs;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin;

public sealed class TwinModelGenerationOptions
{
    public bool Enabled { get; set; }
    public string Provider { get; set; } = "Img2ThreeJs";
    public string Endpoint { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public int PollIntervalSeconds { get; set; } = 5;
    public int TimeoutMinutes { get; set; } = 30;

    public bool IsConfigured => Enabled && Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";
}

/// <summary>
/// 管理 img2threejs 生成任务、参考图和最终模型资源之间的数据库边界。
/// </summary>
public sealed class TwinModelGenerationService
{
    private const long MaxReferenceImageBytes = 15L * 1024 * 1024;
    private readonly ApplicationDbContext _context;
    private readonly IBlobStorage _blob;
    private readonly TwinModelResourceService _modelResources;
    private readonly TwinModelGenerationOptions _options;

    public TwinModelGenerationService(
        ApplicationDbContext context,
        IBlobStorage blob,
        TwinModelResourceService modelResources,
        IOptions<TwinModelGenerationOptions> options)
    {
        _context = context;
        _blob = blob;
        _modelResources = modelResources;
        _options = options.Value;
    }

    public TwinModelGenerationCapabilitiesDto GetCapabilities() => new()
    {
        Provider = string.IsNullOrWhiteSpace(_options.Provider) ? "Img2ThreeJs" : _options.Provider,
        Configured = _options.IsConfigured,
        AcceptsReferenceImage = true,
        AcceptsTextOnly = false,
        OutputFormat = "GLB",
        MaxReferenceImageMb = 15,
        Message = _options.IsConfigured
            ? "img2threejs Worker 已连接；任务将异步生成并自动进入模型库。"
            : "生成页面已就绪，但尚未配置 img2threejs Worker；提交的任务会安全保存在数据库中等待 Worker。"
    };

    public async Task<List<TwinModelGenerationJobDto>> ListAsync(UserProfile profile, CancellationToken cancellationToken)
    {
        var jobs = await _context.TwinModelGenerationJobs.AsNoTracking()
            .Include(item => item.ResultModelResource)
            .Where(item => !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
            .OrderByDescending(item => item.CreatedAt)
            .Take(100)
            .ToListAsync(cancellationToken);
        return jobs.Select(ToDto).ToList();
    }

    public async Task<TwinModelGenerationJobDto?> GetAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var job = await _context.TwinModelGenerationJobs.AsNoTracking()
            .Include(item => item.ResultModelResource)
            .FirstOrDefaultAsync(item => item.Id == id && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken);
        return job == null ? null : ToDto(job);
    }

    public async Task<TwinModelGenerationJobDto> CreateAsync(
        TwinModelGenerationCreateRequest request,
        UserProfile profile,
        CancellationToken cancellationToken)
    {
        if (request.ReferenceImage == null || request.ReferenceImage.Length <= 0)
            throw new TwinOperationException(ApiCode.NotFile, "请选择一张清晰的设备参考图片。");
        if (request.ReferenceImage.Length > MaxReferenceImageBytes)
            throw new TwinOperationException(ApiCode.InValidData, "参考图片不能超过 15 MB。");
        if (string.IsNullOrWhiteSpace(request.Name))
            throw new TwinOperationException(ApiCode.InValidData, "请填写模型名称。");
        if (string.IsNullOrWhiteSpace(request.Prompt))
            throw new TwinOperationException(ApiCode.InValidData, "请描述模型比例、可动部件和用途。");
        if (!request.ReferenceRightsConfirmed)
            throw new TwinOperationException(ApiCode.DoNotAllow, "必须确认拥有参考图片和生成模型的使用权。");

        var id = Guid.NewGuid();
        var originalName = Path.GetFileName(request.ReferenceImage.FileName);
        var tempFile = Path.GetTempFileName();
        string contentType;
        string extension;
        try
        {
            await using (var output = File.Create(tempFile))
            {
                await request.ReferenceImage.CopyToAsync(output, cancellationToken);
            }
            (contentType, extension) = InspectReferenceImage(tempFile);
            var path = BuildReferencePath(profile.Tenant, profile.Customer, id, extension);
            await _blob.WriteFileAsync(path, tempFile);

            var now = DateTime.UtcNow;
            var actor = ResolveActor(profile);
            var job = new TwinModelGenerationJob
            {
                Id = id,
                JobKey = $"generate-{id:N}",
                Name = request.Name.Trim()[..Math.Min(request.Name.Trim().Length, 256)],
                Provider = "Img2ThreeJs",
                Prompt = request.Prompt.Trim()[..Math.Min(request.Prompt.Trim().Length, 8000)],
                QualityProfile = NormalizeQuality(request.QualityProfile),
                AnimationReady = request.AnimationReady,
                LicenseType = string.IsNullOrWhiteSpace(request.LicenseType) ? "Proprietary-Generated" : request.LicenseType.Trim()[..Math.Min(request.LicenseType.Trim().Length, 128)],
                CommercialUseAllowed = request.CommercialUseAllowed,
                ReferenceImagePath = path,
                ReferenceImageName = originalName,
                ReferenceImageContentType = contentType,
                ReferenceImageSize = request.ReferenceImage.Length,
                Status = _options.IsConfigured ? TwinModelGenerationStatus.Queued : TwinModelGenerationStatus.WaitingForWorker,
                Progress = 0,
                Stage = _options.IsConfigured ? "已进入生成队列" : "等待配置 img2threejs Worker",
                ProviderMetadata = JsonSerializer.Serialize(new { contract = "iotsharp-img2threejs-worker/v1", output = "glb" }),
                CreatedAt = now,
                UpdatedAt = now,
                CreatedByUserId = profile.Id,
                CreatedBy = actor,
                UpdatedBy = actor,
                TenantId = profile.Tenant,
                CustomerId = profile.Customer
            };
            _context.TwinModelGenerationJobs.Add(job);
            AddAudit(profile, job, "TwinModelGenerationCreate", new { job.Provider, job.QualityProfile, job.AnimationReady, job.ReferenceImageSize }, job.Status.ToString(), now);
            await _context.SaveChangesAsync(cancellationToken);
            return ToDto(job);
        }
        finally
        {
            TryDelete(tempFile);
        }
    }

    public async Task<TwinModelGenerationReference?> OpenReferenceAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var job = await FindAsync(id, profile, cancellationToken);
        if (job == null) return null;
        return new TwinModelGenerationReference(
            await _blob.OpenReadAsync(job.ReferenceImagePath),
            job.ReferenceImageName,
            job.ReferenceImageContentType,
            job.ReferenceImageSize);
    }

    public async Task<TwinModelGenerationJobDto> CancelAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var job = await FindAsync(id, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "生成任务不存在。");
        if (job.Status is TwinModelGenerationStatus.Succeeded or TwinModelGenerationStatus.Cancelled)
            throw new TwinOperationException(ApiCode.DoNotAllow, "当前任务状态不能取消。");
        var now = DateTime.UtcNow;
        job.Status = TwinModelGenerationStatus.Cancelled;
        job.Stage = "已取消";
        job.CompletedAt = now;
        job.UpdatedAt = now;
        job.UpdatedBy = ResolveActor(profile);
        AddAudit(profile, job, "TwinModelGenerationCancel", new { job.AttemptCount }, "Cancelled", now);
        await _context.SaveChangesAsync(cancellationToken);
        return ToDto(job);
    }

    public async Task<TwinModelGenerationJobDto> RetryAsync(Guid id, UserProfile profile, CancellationToken cancellationToken)
    {
        var job = await FindAsync(id, profile, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "生成任务不存在。");
        if (job.Status is not (TwinModelGenerationStatus.Failed or TwinModelGenerationStatus.WaitingForWorker or TwinModelGenerationStatus.Cancelled))
            throw new TwinOperationException(ApiCode.DoNotAllow, "只有失败、等待 Worker 或已取消的任务可以重新排队。");
        job.Status = _options.IsConfigured ? TwinModelGenerationStatus.Queued : TwinModelGenerationStatus.WaitingForWorker;
        job.Progress = 0;
        job.Stage = _options.IsConfigured ? "已重新进入生成队列" : "等待配置 img2threejs Worker";
        job.ErrorMessage = string.Empty;
        job.StartedAt = null;
        job.CompletedAt = null;
        job.UpdatedAt = DateTime.UtcNow;
        job.UpdatedBy = ResolveActor(profile);
        await _context.SaveChangesAsync(cancellationToken);
        return ToDto(job);
    }

    internal async Task<TwinModelGenerationWorkItem?> ClaimNextAsync(CancellationToken cancellationToken)
    {
        if (!_options.IsConfigured) return null;
        var staleBefore = DateTime.UtcNow.AddMinutes(-Math.Clamp(_options.TimeoutMinutes + 5, 6, 245));
        var interrupted = await _context.TwinModelGenerationJobs
            .Where(item => !item.Deleted && item.Status == TwinModelGenerationStatus.Running && item.UpdatedAt < staleBefore)
            .ToListAsync(cancellationToken);
        foreach (var stale in interrupted)
        {
            stale.Status = TwinModelGenerationStatus.Queued;
            stale.Progress = 0;
            stale.Stage = "检测到 Worker 中断，已自动重新排队";
            stale.ErrorMessage = string.Empty;
            stale.StartedAt = null;
            stale.UpdatedAt = DateTime.UtcNow;
        }
        if (interrupted.Count > 0) await _context.SaveChangesAsync(cancellationToken);

        var job = await _context.TwinModelGenerationJobs
            .Where(item => !item.Deleted && (item.Status == TwinModelGenerationStatus.Queued || item.Status == TwinModelGenerationStatus.WaitingForWorker))
            .OrderBy(item => item.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken);
        if (job == null) return null;
        var now = DateTime.UtcNow;
        job.Status = TwinModelGenerationStatus.Running;
        job.Progress = 10;
        job.Stage = "正在提交 img2threejs 分阶段生成";
        job.StartedAt = now;
        job.UpdatedAt = now;
        job.AttemptCount += 1;
        await _context.SaveChangesAsync(cancellationToken);
        return new TwinModelGenerationWorkItem(
            job.Id,
            job.Name,
            job.Prompt,
            job.QualityProfile,
            job.AnimationReady,
            job.ReferenceImageName,
            job.ReferenceImageContentType,
            await _blob.OpenReadAsync(job.ReferenceImagePath));
    }

    internal async Task CompleteAsync(Guid id, string glbPath, CancellationToken cancellationToken)
    {
        var job = await _context.TwinModelGenerationJobs.FirstAsync(item => item.Id == id, cancellationToken);
        await _context.Entry(job).ReloadAsync(cancellationToken);
        if (job.Status == TwinModelGenerationStatus.Cancelled) return;
        job.Progress = 90;
        job.Stage = "正在校验 GLB 并写入模型库";
        job.UpdatedAt = DateTime.UtcNow;
        await _context.SaveChangesAsync(cancellationToken);

        var profile = new UserProfile
        {
            Id = job.CreatedByUserId,
            Name = job.CreatedBy,
            Email = string.Empty,
            Roles = [],
            Tenant = job.TenantId ?? Guid.Empty,
            Customer = job.CustomerId ?? Guid.Empty
        };
        await using var stream = File.OpenRead(glbPath);
        var formFile = new FormFile(stream, 0, stream.Length, "file", $"{SafeFileName(job.Name)}.glb");
        var model = await _modelResources.UploadAsync(new TwinModelResourceUploadRequest
        {
            File = formFile,
            ResourceKey = $"img2threejs-{job.Id:N}",
            Name = job.Name,
            SourceType = TwinModelSourceType.Img2ThreeJs,
            LicenseType = job.LicenseType,
            SourceUrl = "https://github.com/img2threejs/img2threejs",
            Author = $"img2threejs / {job.CreatedBy}",
            CommercialUseAllowed = job.CommercialUseAllowed
        }, profile, cancellationToken);

        await _context.Entry(job).ReloadAsync(cancellationToken);
        if (job.Status == TwinModelGenerationStatus.Cancelled) return;
        var completedAt = DateTime.UtcNow;
        job.ResultModelResourceId = model.Id;
        job.Status = TwinModelGenerationStatus.Succeeded;
        job.Progress = 100;
        job.Stage = "生成完成，已进入模型库";
        job.ErrorMessage = string.Empty;
        job.CompletedAt = completedAt;
        job.UpdatedAt = completedAt;
        await _context.SaveChangesAsync(cancellationToken);
    }

    internal async Task FailAsync(Guid id, Exception exception, CancellationToken cancellationToken)
    {
        var job = await _context.TwinModelGenerationJobs.FirstOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (job == null) return;
        await _context.Entry(job).ReloadAsync(cancellationToken);
        if (job.Status == TwinModelGenerationStatus.Cancelled) return;
        var now = DateTime.UtcNow;
        job.Status = TwinModelGenerationStatus.Failed;
        job.Stage = "生成失败";
        job.ErrorMessage = exception.Message[..Math.Min(exception.Message.Length, 4000)];
        job.CompletedAt = now;
        job.UpdatedAt = now;
        await _context.SaveChangesAsync(cancellationToken);
    }

    private async Task<TwinModelGenerationJob?> FindAsync(Guid id, UserProfile profile, CancellationToken cancellationToken) =>
        await _context.TwinModelGenerationJobs.FirstOrDefaultAsync(item =>
            item.Id == id && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken);

    private static TwinModelGenerationJobDto ToDto(TwinModelGenerationJob job) => new()
    {
        Id = job.Id,
        JobKey = job.JobKey,
        Name = job.Name,
        Provider = job.Provider,
        Prompt = job.Prompt,
        QualityProfile = job.QualityProfile,
        AnimationReady = job.AnimationReady,
        ReferenceImageName = job.ReferenceImageName,
        ReferenceImageSize = job.ReferenceImageSize,
        Status = job.Status,
        Progress = job.Progress,
        Stage = job.Stage ?? string.Empty,
        ErrorMessage = job.ErrorMessage ?? string.Empty,
        AttemptCount = job.AttemptCount,
        ResultModelResourceId = job.ResultModelResourceId,
        ResultModelResource = job.ResultModelResource == null ? null : TwinModelResourceService.ToDto(job.ResultModelResource),
        StartedAt = job.StartedAt,
        CompletedAt = job.CompletedAt,
        CreatedAt = job.CreatedAt,
        UpdatedAt = job.UpdatedAt,
        CreatedBy = job.CreatedBy ?? string.Empty
    };

    private void AddAudit(UserProfile profile, TwinModelGenerationJob job, string action, object data, string result, DateTime now)
    {
        _context.AuditLog.Add(new AuditLog
        {
            TenantId = profile.Tenant,
            CustomerId = profile.Customer,
            UserId = profile.Id.ToString("D"),
            UserName = ResolveActor(profile),
            ObjectID = job.Id,
            ObjectName = job.Name,
            ObjectType = ObjectType.TwinModelGenerationJob,
            ActionName = action,
            ActionData = JsonSerializer.Serialize(data),
            ActionResult = result,
            ActiveDateTime = now
        });
    }

    private static (string ContentType, string Extension) InspectReferenceImage(string path)
    {
        using var stream = File.OpenRead(path);
        Span<byte> header = stackalloc byte[12];
        var read = stream.Read(header);
        if (read >= 8 && header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47) return ("image/png", ".png");
        if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF) return ("image/jpeg", ".jpg");
        if (read >= 12 && header[0] == (byte)'R' && header[1] == (byte)'I' && header[2] == (byte)'F' && header[3] == (byte)'F' &&
            header[8] == (byte)'W' && header[9] == (byte)'E' && header[10] == (byte)'B' && header[11] == (byte)'P') return ("image/webp", ".webp");
        throw new TwinOperationException(ApiCode.InValidData, "参考图片只支持真实的 PNG、JPEG 或 WebP 文件。");
    }

    private static string NormalizeQuality(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "draft" => "Draft",
        "preview" => "Preview",
        _ => "Production"
    };

    private static string SafeFileName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var name = new string(value.Where(character => !invalid.Contains(character)).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(name) ? "generated-model" : name;
    }

    private static string ResolveActor(UserProfile profile) =>
        !string.IsNullOrWhiteSpace(profile.Name) ? profile.Name : !string.IsNullOrWhiteSpace(profile.Email) ? profile.Email : profile.Id.ToString("D");

    private static string BuildReferencePath(Guid tenantId, Guid customerId, Guid jobId, string extension) =>
        $"digital-twin/{tenantId:N}/{customerId:N}/generation/{jobId:N}/reference{extension}";

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

public sealed record TwinModelGenerationReference(Stream Stream, string FileName, string ContentType, long Length);

public sealed record TwinModelGenerationWorkItem(
    Guid Id,
    string Name,
    string Prompt,
    string QualityProfile,
    bool AnimationReady,
    string ReferenceImageName,
    string ReferenceImageContentType,
    Stream ReferenceImage);
