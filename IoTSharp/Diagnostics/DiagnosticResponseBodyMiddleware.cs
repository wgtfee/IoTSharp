using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System.IO.Pipelines;

namespace IoTSharp.Diagnostics;

/// <summary>为旧诊断组件的响应流提供兼容当前 JSON 格式化器的 PipeWriter，保留原有响应采集。</summary>
public sealed class DiagnosticResponseBodyMiddleware(RequestDelegate next)
{
    /// <summary>仅适配不支持未刷新字节统计的响应写入器，完成写入后恢复原有响应特性。</summary>
    public async Task InvokeAsync(HttpContext context)
    {
        var original = context.Features.Get<IHttpResponseBodyFeature>();
        if (original is null || original.Writer.CanGetUnflushedBytes)
        {
            await next(context);
            return;
        }

        context.Features.Set<IHttpResponseBodyFeature>(new CompatibleBodyFeature(original));
        try { await next(context); }
        finally { context.Features.Set(original); }
    }

    // 保留诊断组件原有流和写入器，只补齐当前格式化器要求的字节统计。
    private sealed class CompatibleBodyFeature(IHttpResponseBodyFeature original) : IHttpResponseBodyFeature
    {
        public Stream Stream => original.Stream;
        public PipeWriter Writer { get; } = new TrackedPipeWriter(original.Writer);
        public void DisableBuffering() => original.DisableBuffering();
        public Task StartAsync(CancellationToken cancellationToken = default) => original.StartAsync(cancellationToken);
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default) => original.SendFileAsync(path, offset, count, cancellationToken);
        public Task CompleteAsync() => original.CompleteAsync();
    }

    private sealed class TrackedPipeWriter(PipeWriter original) : PipeWriter
    {
        private long unflushed;
        public override bool CanGetUnflushedBytes => true;
        public override long UnflushedBytes => Volatile.Read(ref unflushed);
        public override void Advance(int bytes) { original.Advance(bytes); Interlocked.Add(ref unflushed, bytes); }
        public override Memory<byte> GetMemory(int sizeHint = 0) => original.GetMemory(sizeHint);
        public override Span<byte> GetSpan(int sizeHint = 0) => original.GetSpan(sizeHint);
        public override void CancelPendingFlush() => original.CancelPendingFlush();
        public override void Complete(Exception? exception = null) => original.Complete(exception);
        public override ValueTask CompleteAsync(Exception? exception = null) => original.CompleteAsync(exception);
        public override async ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            var count = UnflushedBytes;
            var result = await original.FlushAsync(cancellationToken);
            if (!result.IsCanceled) Interlocked.Add(ref unflushed, -count);
            return result;
        }
    }
}
