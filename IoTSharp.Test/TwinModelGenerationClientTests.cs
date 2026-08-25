#nullable enable
using IoTSharp.Services.DigitalTwin;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class TwinModelGenerationClientTests
{
    [Fact]
    public async Task GenerateGlbAsync_SendsVersionedWorkerContract_AndStoresGlb()
    {
        var handler = new RecordingHandler();
        using var httpClient = new HttpClient(handler);
        var options = Options.Create(new TwinModelGenerationOptions
        {
            Enabled = true,
            Endpoint = "https://worker.example/v1/generate/glb",
            ApiKey = "worker-secret",
            TimeoutMinutes = 1
        });
        var client = new Img2ThreeJsGenerationClient(httpClient, options);
        await using var reference = new MemoryStream([0x89, 0x50, 0x4E, 0x47]);
        var jobId = Guid.NewGuid();
        var outputPath = await client.GenerateGlbAsync(new TwinModelGenerationWorkItem(
            jobId,
            "AGV",
            "保留车轮和举升平台为独立可动画节点",
            "Production",
            true,
            "agv.png",
            "image/png",
            reference), CancellationToken.None);
        try
        {
            Assert.Equal(HttpMethod.Post, handler.Method);
            Assert.Equal("Bearer worker-secret", handler.Authorization);
            Assert.Equal(jobId.ToString("D"), handler.JobHeader);
            Assert.Contains("iotsharp-img2threejs-worker/v1", handler.MultipartBody, StringComparison.Ordinal);
            Assert.Contains("outputFormat", handler.MultipartBody, StringComparison.Ordinal);
            Assert.Contains("保留车轮和举升平台", handler.MultipartBody, StringComparison.Ordinal);
            Assert.Equal(Encoding.ASCII.GetBytes("glTF-test"), await File.ReadAllBytesAsync(outputPath));
        }
        finally
        {
            File.Delete(outputPath);
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public HttpMethod? Method { get; private set; }
        public string Authorization { get; private set; } = string.Empty;
        public string JobHeader { get; private set; } = string.Empty;
        public string MultipartBody { get; private set; } = string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Authorization = request.Headers.Authorization?.ToString() ?? string.Empty;
            JobHeader = request.Headers.GetValues("X-IoTSharp-Generation-Job").Single();
            MultipartBody = Encoding.UTF8.GetString(await request.Content!.ReadAsByteArrayAsync(cancellationToken));
            var content = new ByteArrayContent(Encoding.ASCII.GetBytes("glTF-test"));
            content.Headers.ContentType = new MediaTypeHeaderValue("model/gltf-binary");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        }
    }
}
