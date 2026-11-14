using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// 实际外部 .NET/IoTSharp 进程的 CPU/内存连续采样，不发送遥测、PLC、MES、工单。
// 不采集目标进程 EventPipe GC/Spool/吞吐；不能自动证明百万点 1h/4h 验收。
if (args.Length != 6 || args[0] != "--pid" || args[2] != "--seconds" ||
    args[4] != "--output" || !int.TryParse(args[1], out var pid) || pid <= 0 ||
    !int.TryParse(args[3], out var seconds) || seconds is < 2 or > 14400)
{
    Console.Error.WriteLine("Usage: --pid <existing-process-id> --seconds <2..14400> --output <new.ndjson>");
    return 2;
}
var path = Path.GetFullPath(args[5]);
if (!Directory.Exists(Path.GetDirectoryName(path)) ||
    !string.Equals(Path.GetExtension(path), ".ndjson", StringComparison.OrdinalIgnoreCase))
{
    Console.Error.WriteLine("Evidence must be a new .ndjson file inside an existing directory");
    return 2;
}
using var process = Process.GetProcessById(pid);
process.Refresh();
if (process.HasExited) return 3;
var startTime = process.StartTime.ToUniversalTime();
var cpuBefore = process.TotalProcessorTime;
var timer = Stopwatch.StartNew();
var createdUtc = DateTimeOffset.UtcNow;
using var cancel = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
var previous = new string('0', 64);
var samples = 0;
try
{
    await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write,
        FileShare.None, 8192, FileOptions.Asynchronous | FileOptions.WriteThrough);
    await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
    while (timer.Elapsed < TimeSpan.FromSeconds(seconds))
    {
        cancel.Token.ThrowIfCancellationRequested();
        process.Refresh();
        if (process.HasExited || process.StartTime.ToUniversalTime() != startTime)
            throw new InvalidOperationException("PID reused or target process exited");
        var data = new {
            kind = "external-process-sample", seq = samples,
            atUtc = DateTimeOffset.UtcNow, pid = process.Id,
            startTimeUtc = startTime, cpuMs = process.TotalProcessorTime.TotalMilliseconds,
            workingSetBytes = process.WorkingSet64,
            privateBytes = process.PrivateMemorySize64,
            threadCount = process.Threads.Count, previousSha256 = previous,
            gcAndEventPipeCaptured = false, spoolAndThroughputCaptured = false
        };
        var body = JsonSerializer.Serialize(data);
        var digest = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { data, sha256 = digest }));
        await writer.FlushAsync(cancel.Token);
        previous = digest;
        samples++;
        var remaining = TimeSpan.FromSeconds(seconds) - timer.Elapsed;
        if (remaining > TimeSpan.Zero)
            await Task.Delay(remaining < TimeSpan.FromSeconds(1) ?
                remaining : TimeSpan.FromSeconds(1), cancel.Token);
    }
    process.Refresh();
    if (process.HasExited || process.StartTime.ToUniversalTime() != startTime)
        throw new InvalidOperationException("Target did not survive the collection interval");
    var finish = new {
        kind = "collection-complete", atUtc = DateTimeOffset.UtcNow,
        createdUtc, pid, durationSeconds = timer.Elapsed.TotalSeconds,
        samples, cpuDeltaMs = (process.TotalProcessorTime - cpuBefore).TotalMilliseconds,
        previousSha256 = previous,
        oneHourMillionPointApproved = false, fourHourMillionPointApproved = false,
        gcEventPipeAndSpoolVerified = false,
        message = "Real external CPU/memory samples only; ingest throughput/GC/Spool not measured"
    };
    var finalBody = JsonSerializer.Serialize(finish);
    await writer.WriteLineAsync(JsonSerializer.Serialize(new {
        data = finish,
        sha256 = Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(finalBody))).ToLowerInvariant()
    }));
    await writer.FlushAsync();
    Console.WriteLine(JsonSerializer.Serialize(new { result = "PASS",
        pid, samples, finished = true, realExternalProcess = true,
        millionPointLongSoakApproved = false }));
    return 0;
}
catch (OperationCanceledException)
{
    Console.Error.WriteLine("Canceled: partial evidence has no completion record");
    return 4;
}
catch (Exception ex)
{
    Console.Error.WriteLine("Incomplete evidence: " + ex.GetType().Name);
    return 1;
}
