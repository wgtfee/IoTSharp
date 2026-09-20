using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.Extensions.Logging;
using System.Security.Cryptography;

namespace IoTSharp.EventBus;

public sealed record TelemetryHistorySpoolEnqueueResult(string PendingPath, bool Deduplicated, int RowCount);
internal sealed record TelemetryHistorySpoolBatch(int MessageCount, DateTime OldestServerIngestedAtUtc, List<TelemetryData> Rows);

public sealed class TelemetryHistorySpool : IDurableTelemetryHistoryQueue
{
    private const int FileMagic = 0x49544853;
    private const int FileVersion = 1;
    private const int MaxRowsPerFile = 10_000_000;
    private readonly TelemetryPersistenceMonitor _persistence;
    private readonly ILogger<TelemetryHistorySpool> _logger;
    private readonly string _directory;
    private readonly SemaphoreSlim _enqueueGate = new(1, 1);
    private readonly SemaphoreSlim _signal = new(0);

    public TelemetryHistorySpool(EventBusOption eventBusOption, ILogger<TelemetryHistorySpool> logger)
    {
        _persistence = eventBusOption.TelemetryPersistence;
        _logger = logger;
        var settings = eventBusOption.AppSettings.TelemetryHistorySpool ?? new TelemetryHistorySpoolSetting();
        var configuredDirectory = string.IsNullOrWhiteSpace(settings.Directory)
            ? "runtime-data/telemetry-history-spool"
            : settings.Directory.Trim();
        _directory = Path.IsPathRooted(configuredDirectory)
            ? Path.GetFullPath(configuredDirectory)
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, configuredDirectory));
    }

    public async Task<TelemetryHistorySpoolEnqueueResult> EnqueueAsync(IReadOnlyCollection<PlayloadData> messages, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(messages);
        if (messages.Count == 0)
            return new TelemetryHistorySpoolEnqueueResult(string.Empty, true, 0);

        var batch = Materialize(messages);
        if (batch.Rows.Count == 0)
            return new TelemetryHistorySpoolEnqueueResult(string.Empty, true, 0);

        Directory.CreateDirectory(_directory);
        await _enqueueGate.WaitAsync(cancellationToken);
        string? tempPath = null;
        try
        {
            tempPath = Path.Combine(_directory, $".{Guid.NewGuid():N}.tmp");
            WriteBatch(tempPath, batch);
            string hash;
            await using (var input = new FileStream(tempPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan))
                hash = Convert.ToHexString(await SHA256.HashDataAsync(input, cancellationToken)).ToLowerInvariant();

            var pendingPath = Path.Combine(_directory, hash + ".pending");
            var deduplicated = File.Exists(pendingPath);
            if (deduplicated)
            {
                File.Delete(tempPath);
                tempPath = null;
            }
            else
            {
                File.Move(tempPath, pendingPath);
                tempPath = null;
                _signal.Release();
            }
            _persistence.RecordSpoolEnqueue(batch.Rows.Count, deduplicated);
            RefreshBacklog();
            _logger.LogDebug("Telemetry History batch spooled. Messages={MessageCount}, Rows={Rows}, Deduplicated={Deduplicated}, File={File}", batch.MessageCount, batch.Rows.Count, deduplicated, Path.GetFileName(pendingPath));
            return new TelemetryHistorySpoolEnqueueResult(pendingPath, deduplicated, batch.Rows.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Failed to durably spool telemetry History batch. Messages={MessageCount}", messages.Count);
            throw;
        }
        finally
        {
            if (tempPath != null)
            {
                try { File.Delete(tempPath); } catch { }
            }
            _enqueueGate.Release();
        }
    }

    public Task<DurableTelemetryHistoryQueueItem?> PeekOldestAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_directory);
        var pending = GetPendingFilesOrdered();
        if (pending.Count == 0)
            return Task.FromResult<DurableTelemetryHistoryQueueItem?>(null);

        var current = pending[0];
        var batch = ReadBatch(current.Path);
        return Task.FromResult<DurableTelemetryHistoryQueueItem?>(new DurableTelemetryHistoryQueueItem(
            Path.GetFileName(current.Path),
            batch.MessageCount,
            batch.OldestServerIngestedAtUtc,
            batch.Rows));
    }

    public Task AckAsync(DurableTelemetryHistoryQueueItem item, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        cancellationToken.ThrowIfCancellationRequested();
        var path = ResolvePendingPath(item.Token);
        if (File.Exists(path))
            File.Delete(path);
        RefreshBacklog();
        return Task.CompletedTask;
    }

    public Task NackAsync(DurableTelemetryHistoryQueueItem item, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        cancellationToken.ThrowIfCancellationRequested();
        RefreshBacklog();
        return Task.CompletedTask;
    }

    public DurableTelemetryHistoryBacklogSnapshot GetBacklogSnapshot()
        => RefreshBacklog();

    public Task RecoverAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_directory);
        CleanupTemporaryFiles();
        var snapshot = RefreshBacklog();
        if (snapshot.PendingBatches > 0)
        {
            try { _signal.Release(); } catch (SemaphoreFullException) { }
        }
        return Task.CompletedTask;
    }

    public async Task WaitForDataAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        await _signal.WaitAsync(timeout, cancellationToken);
    }

    private static TelemetryHistorySpoolBatch Materialize(IReadOnlyCollection<PlayloadData> messages)
    {
        var rows = new List<TelemetryData>(messages.Sum(message => message.MsgBody?.Count ?? 0));
        DateTime? oldest = null;
        foreach (var message in messages)
        {
            var serverTime = NormalizeStableIngestedAt(message);
            if (!oldest.HasValue || serverTime < oldest.Value) oldest = serverTime;
            if (message.MsgBody == null) continue;
            foreach (var pair in message.MsgBody)
            {
                if (pair.Key == null || pair.Value == null) continue;
                var history = new TelemetryData { DeviceId = message.DeviceId, KeyName = pair.Key, DateTime = message.ts, DataSide = message.DataSide };
                history.FillKVToMe(pair);
                rows.Add(history);
            }
        }
        return new TelemetryHistorySpoolBatch(messages.Count, oldest ?? DateTime.UnixEpoch, rows);
    }

    private static DateTime NormalizeStableIngestedAt(PlayloadData message)
    {
        var value = message.ServerIngestedAtUtc;
        if (value == default || value == DateTime.MinValue) value = message.ts == default ? DateTime.UnixEpoch : message.ts;
        return value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
    }

    private static void WriteBatch(string path, TelemetryHistorySpoolBatch batch)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.SequentialScan);
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write(FileMagic); writer.Write(FileVersion); writer.Write(batch.MessageCount); writer.Write(batch.OldestServerIngestedAtUtc.ToBinary()); writer.Write(batch.Rows.Count);
        foreach (var row in batch.Rows) WriteRow(writer, row);
        writer.Flush(); stream.Flush(flushToDisk: true);
    }

    private static void WriteRow(BinaryWriter writer, TelemetryData row)
    {
        writer.Write(row.DeviceId.ToByteArray()); writer.Write(row.KeyName ?? string.Empty); writer.Write(row.DateTime.ToBinary()); writer.Write((int)row.DataSide); writer.Write((int)row.Type);
        switch (row.Type)
        {
            case DataType.Boolean: writer.Write(row.Value_Boolean.GetValueOrDefault()); break;
            case DataType.String: writer.Write(row.Value_String ?? string.Empty); break;
            case DataType.Long: writer.Write(row.Value_Long.GetValueOrDefault()); break;
            case DataType.Double: writer.Write(row.Value_Double.GetValueOrDefault()); break;
            case DataType.Json: writer.Write(row.Value_Json ?? string.Empty); break;
            case DataType.XML: writer.Write(row.Value_XML ?? string.Empty); break;
            case DataType.Binary:
                var bytes = row.Value_Binary ?? []; writer.Write(bytes.Length); writer.Write(bytes); break;
            case DataType.DateTime: writer.Write((row.Value_DateTime ?? DateTime.MinValue).ToBinary()); break;
            default: throw new InvalidDataException($"Unsupported telemetry data type {row.Type}.");
        }
    }

    internal static TelemetryHistorySpoolBatch ReadBatch(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan);
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: false);
        var magic = reader.ReadInt32(); var version = reader.ReadInt32();
        if (magic != FileMagic || version != FileVersion) throw new InvalidDataException($"Unsupported telemetry History spool file: magic={magic:X8}, version={version}.");
        var messageCount = reader.ReadInt32(); var oldest = DateTime.FromBinary(reader.ReadInt64()); var rowCount = reader.ReadInt32();
        if (messageCount < 0 || rowCount < 0 || rowCount > MaxRowsPerFile) throw new InvalidDataException($"Invalid telemetry History spool counts: messages={messageCount}, rows={rowCount}.");
        var rows = new List<TelemetryData>(rowCount);
        for (var index = 0; index < rowCount; index++) rows.Add(ReadRow(reader));
        return new TelemetryHistorySpoolBatch(messageCount, oldest, rows);
    }

    private static TelemetryData ReadRow(BinaryReader reader)
    {
        var guidBytes = reader.ReadBytes(16); if (guidBytes.Length != 16) throw new EndOfStreamException("Telemetry History spool DeviceId is truncated.");
        var row = new TelemetryData { DeviceId = new Guid(guidBytes), KeyName = reader.ReadString(), DateTime = DateTime.FromBinary(reader.ReadInt64()), DataSide = (DataSide)reader.ReadInt32(), Type = (DataType)reader.ReadInt32() };
        switch (row.Type)
        {
            case DataType.Boolean: row.Value_Boolean = reader.ReadBoolean(); break;
            case DataType.String: row.Value_String = reader.ReadString(); break;
            case DataType.Long: row.Value_Long = reader.ReadInt64(); break;
            case DataType.Double: row.Value_Double = reader.ReadDouble(); break;
            case DataType.Json: row.Value_Json = reader.ReadString(); break;
            case DataType.XML: row.Value_XML = reader.ReadString(); break;
            case DataType.Binary:
                var length = reader.ReadInt32(); if (length < 0 || length > 256 * 1024 * 1024) throw new InvalidDataException($"Invalid telemetry binary length {length}.");
                row.Value_Binary = reader.ReadBytes(length); if (row.Value_Binary.Length != length) throw new EndOfStreamException("Telemetry History spool binary payload is truncated."); break;
            case DataType.DateTime: row.Value_DateTime = DateTime.FromBinary(reader.ReadInt64()); break;
            default: throw new InvalidDataException($"Unsupported telemetry data type {row.Type}.");
        }
        return row;
    }

    private void CleanupTemporaryFiles()
    {
        foreach (var temp in Directory.EnumerateFiles(_directory, "*.tmp", SearchOption.TopDirectoryOnly))
        {
            try { File.Delete(temp); } catch (Exception ex) { _logger.LogWarning(ex, "Failed to remove orphan telemetry History spool temp file {File}.", temp); }
        }
    }

    private List<(string Path, DateTime OldestUtc, int RowCount)> GetPendingFilesOrdered()
    {
        var files = new List<(string Path, DateTime OldestUtc, int RowCount)>();
        foreach (var path in Directory.EnumerateFiles(_directory, "*.pending", SearchOption.TopDirectoryOnly))
        {
            var metadata = ReadMetadata(path);
            files.Add((path, metadata.OldestUtc, metadata.RowCount));
        }
        files.Sort(static (left, right) => { var time = left.OldestUtc.CompareTo(right.OldestUtc); return time != 0 ? time : StringComparer.Ordinal.Compare(left.Path, right.Path); });
        return files;
    }

    private static (DateTime OldestUtc, int RowCount) ReadMetadata(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096, FileOptions.SequentialScan);
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: false);
        var magic = reader.ReadInt32(); var version = reader.ReadInt32();
        if (magic != FileMagic || version != FileVersion) throw new InvalidDataException($"Unsupported telemetry History spool file {path}.");
        _ = reader.ReadInt32();
        var oldest = DateTime.FromBinary(reader.ReadInt64()).ToUniversalTime();
        var rowCount = reader.ReadInt32();
        if (rowCount < 0 || rowCount > MaxRowsPerFile)
            throw new InvalidDataException($"Invalid telemetry History spool row count {rowCount} in {path}.");
        return (oldest, rowCount);
    }

    private string ResolvePendingPath(string token)
    {
        if (string.IsNullOrWhiteSpace(token)
            || !string.Equals(token, Path.GetFileName(token), StringComparison.Ordinal)
            || !token.EndsWith(".pending", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException($"Invalid telemetry History queue token '{token}'.");
        }

        return Path.Combine(_directory, token);
    }

    private DurableTelemetryHistoryBacklogSnapshot RefreshBacklog()
    {
        try
        {
            var pending = GetPendingFilesOrdered();
            DateTime? oldest = pending.Count == 0 ? null : pending[0].OldestUtc;
            long pendingRows = 0;
            foreach (var item in pending)
                pendingRows += item.RowCount;
            _persistence.UpdateDurableBacklog(pending.Count, pendingRows, oldest);
            return new DurableTelemetryHistoryBacklogSnapshot(pending.Count, pendingRows, oldest);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh telemetry History spool backlog metrics.");
            _persistence.UpdateDurableBacklog(0, 0, null);
            return new DurableTelemetryHistoryBacklogSnapshot(0, 0, null);
        }
    }
}
