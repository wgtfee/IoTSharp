#nullable enable
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// IoTSharp 到自托管 img2threejs Agent Worker 的最小、可替换 HTTP 合同。
/// Worker 接收图片/要求并同步返回经过导出的 GLB 二进制。
/// </summary>
public sealed class Img2ThreeJsGenerationClient
{
    private const long MaxResultBytes = 100L * 1024 * 1024;
    private readonly HttpClient _httpClient;
    private readonly TwinModelGenerationOptions _options;

    public Img2ThreeJsGenerationClient(HttpClient httpClient, IOptions<TwinModelGenerationOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public async Task<string> GenerateGlbAsync(TwinModelGenerationWorkItem item, CancellationToken cancellationToken)
    {
        if (!_options.IsConfigured) throw new InvalidOperationException("img2threejs Worker 尚未配置。");
        using var request = new HttpRequestMessage(HttpMethod.Post, _options.Endpoint);
        request.Headers.UserAgent.ParseAdd("IoTSharp-DigitalTwin/1.0");
        request.Headers.TryAddWithoutValidation("X-IoTSharp-Generation-Job", item.Id.ToString("D"));
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);

        using var form = new MultipartFormDataContent();
        var image = new StreamContent(item.ReferenceImage);
        image.Headers.ContentType = MediaTypeHeaderValue.Parse(item.ReferenceImageContentType);
        form.Add(image, "referenceImage", item.ReferenceImageName);
        form.Add(new StringContent(item.Id.ToString("D")), "jobId");
        form.Add(new StringContent(item.Name), "name");
        form.Add(new StringContent(item.Prompt), "prompt");
        form.Add(new StringContent(item.QualityProfile), "qualityProfile");
        form.Add(new StringContent(item.AnimationReady ? "true" : "false"), "animationReady");
        form.Add(new StringContent("glb"), "outputFormat");
        form.Add(new StringContent("iotsharp-img2threejs-worker/v1"), "contractVersion");
        request.Content = form;

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(Math.Clamp(_options.TimeoutMinutes, 1, 240)));
        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(timeout.Token);
            throw new InvalidOperationException($"img2threejs Worker 返回 {(int)response.StatusCode}：{body[..Math.Min(body.Length, 1000)]}");
        }
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (mediaType is not ("model/gltf-binary" or "application/octet-stream"))
            throw new InvalidOperationException($"img2threejs Worker 必须返回 GLB，当前 Content-Type 为 {mediaType ?? "空"}。");
        if (response.Content.Headers.ContentLength > MaxResultBytes)
            throw new InvalidOperationException("img2threejs 生成结果超过 100 MB 限制。");

        var outputPath = Path.GetTempFileName();
        try
        {
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            await using var output = File.Create(outputPath);
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(), timeout.Token)) > 0)
            {
                total += read;
                if (total > MaxResultBytes) throw new InvalidOperationException("img2threejs 生成结果超过 100 MB 限制。");
                await output.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
            }
            if (total == 0) throw new InvalidOperationException("img2threejs Worker 返回了空模型。");
            return outputPath;
        }
        catch
        {
            TryDelete(outputPath);
            throw;
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>
/// 持续领取数据库任务。应用重启后仍可继续处理排队中的生成请求。
/// </summary>
public sealed class Img2ThreeJsGenerationWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly Img2ThreeJsGenerationClient _client;
    private readonly TwinModelGenerationOptions _options;
    private readonly ILogger<Img2ThreeJsGenerationWorker> _logger;

    public Img2ThreeJsGenerationWorker(
        IServiceScopeFactory scopeFactory,
        Img2ThreeJsGenerationClient client,
        IOptions<TwinModelGenerationOptions> options,
        ILogger<Img2ThreeJsGenerationWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _client = client;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!_options.IsConfigured)
            {
                await DelayAsync(15, stoppingToken);
                continue;
            }

            using var scope = _scopeFactory.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<TwinModelGenerationService>();
            TwinModelGenerationWorkItem? item;
            try
            {
                item = await service.ClaimNextAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                _logger.LogError(exception, "Unable to claim the next img2threejs generation job");
                await DelayAsync(Math.Clamp(_options.PollIntervalSeconds, 2, 60), stoppingToken);
                continue;
            }
            if (item == null)
            {
                await DelayAsync(Math.Clamp(_options.PollIntervalSeconds, 2, 60), stoppingToken);
                continue;
            }

            await using (item.ReferenceImage)
            {
                string? outputPath = null;
                try
                {
                    outputPath = await _client.GenerateGlbAsync(item, stoppingToken);
                    await service.CompleteAsync(item.Id, outputPath, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception exception)
                {
                    _logger.LogError(exception, "img2threejs generation job {JobId} failed", item.Id);
                    await service.FailAsync(item.Id, exception, stoppingToken);
                }
                finally
                {
                    if (outputPath != null) TryDelete(outputPath);
                }
            }
        }
    }

    private static async Task DelayAsync(int seconds, CancellationToken cancellationToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(seconds), cancellationToken); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
