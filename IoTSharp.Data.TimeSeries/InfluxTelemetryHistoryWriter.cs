using System.Globalization;
using System.Text;
using System.Web;
using InfluxDB.Client;
using InfluxDB.Client.Api.Domain;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.ObjectPool;
using Microsoft.Extensions.Options;

namespace IoTSharp.Storage;

/// <summary>
/// High-throughput InfluxDB History writer using batched Line Protocol records.
/// DeviceId remains the only telemetry tag; telemetry keys remain fields to preserve
/// the existing series-cardinality model.
/// </summary>
public sealed class InfluxTelemetryHistoryWriter
{
    private const string Measurement = nameof(TelemetryData);
    private readonly ObjectPool<InfluxDBClient> _pool;
    private readonly ILogger<InfluxTelemetryHistoryWriter> _logger;
    private readonly string? _bucket;
    private readonly string? _org;
    private readonly int _batchValues;
    private readonly bool _gzipEnabled;

    public InfluxTelemetryHistoryWriter(
        ObjectPool<InfluxDBClient> pool,
        IOptions<AppSettings> options,
        ILogger<InfluxTelemetryHistoryWriter> logger)
    {
        _pool = pool;
        _logger = logger;

        var settings = options.Value;
        _batchValues = Math.Clamp(settings.TelemetryInfluxBatchValues, 1_000, 100_000);
        _gzipEnabled = settings.TelemetryInfluxGzipEnabled;

        if (settings.ConnectionStrings?.TryGetValue("TelemetryStorage", out var connectionString) != true
            || string.IsNullOrWhiteSpace(connectionString))
            return;

        var uri = new Uri(connectionString);
        var query = HttpUtility.ParseQueryString(uri.Query);
        _org = query.Get("org");
        _bucket = query.Get("bucket");
    }

    public bool IsConfigured
        => !string.IsNullOrWhiteSpace(_bucket) && !string.IsNullOrWhiteSpace(_org);

    public int BatchValues => _batchValues;

    public async Task<TelemetryBatchStoreResult> WriteMessagesAsync(IReadOnlyCollection<PlayloadData> messages)
    {
        if (messages.Count == 0)
            return new TelemetryBatchStoreResult(true, [], 0);

        var rows = new List<TelemetryData>();
        var records = new List<string>();
        var pendingValues = 0;
        var totalValues = 0;
        InfluxDBClient? client = null;

        try
        {
            EnsureConfigured();
            client = _pool.Get();
            if (_gzipEnabled && !client.IsGzipEnabled())
                client.EnableGzip();
            var writeApi = client.GetWriteApiAsync();

            foreach (var message in messages)
            {
                var record = BuildMessageRecord(message, rows, out var valueCount);
                if (record is null)
                    continue;

                records.Add(record);
                pendingValues += valueCount;
                totalValues += valueCount;

                if (pendingValues >= _batchValues)
                {
                    await writeApi.WriteRecordsAsync(records, WritePrecision.Ns, _bucket, _org);
                    records.Clear();
                    pendingValues = 0;
                }
            }

            if (records.Count > 0)
                await writeApi.WriteRecordsAsync(records, WritePrecision.Ns, _bucket, _org);

            _logger.LogInformation(
                "InfluxDB telemetry batch write completed. Messages={Messages}, Values={Values}, BatchValues={BatchValues}",
                messages.Count,
                totalValues,
                _batchValues);
            return new TelemetryBatchStoreResult(true, rows, messages.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "InfluxDB telemetry batch write failed. Messages={Messages}, ValuesPrepared={Values}, BatchValues={BatchValues}",
                messages.Count,
                rows.Count,
                _batchValues);
            return new TelemetryBatchStoreResult(false, rows, messages.Count);
        }
        finally
        {
            if (client is not null)
                _pool.Return(client);
        }
    }

    public async Task<TelemetryBatchStoreResult> WriteRowsAsync(
        IReadOnlyCollection<TelemetryData> rows,
        int messageCount)
    {
        if (rows.Count == 0)
            return new TelemetryBatchStoreResult(true, [], messageCount);

        var records = new List<string>(Math.Min(rows.Count, _batchValues));
        InfluxDBClient? client = null;

        try
        {
            EnsureConfigured();
            client = _pool.Get();
            if (_gzipEnabled && !client.IsGzipEnabled())
                client.EnableGzip();
            var writeApi = client.GetWriteApiAsync();

            foreach (var row in rows)
            {
                var record = BuildRowRecord(row);
                if (record is null)
                    continue;

                records.Add(record);
                if (records.Count >= _batchValues)
                {
                    await writeApi.WriteRecordsAsync(records, WritePrecision.Ns, _bucket, _org);
                    records.Clear();
                }
            }

            if (records.Count > 0)
                await writeApi.WriteRecordsAsync(records, WritePrecision.Ns, _bucket, _org);

            _logger.LogInformation(
                "InfluxDB materialized History replay completed. Messages={Messages}, Rows={Rows}, BatchValues={BatchValues}",
                messageCount,
                rows.Count,
                _batchValues);
            return new TelemetryBatchStoreResult(true, AsList(rows), messageCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "InfluxDB materialized History replay failed. Messages={Messages}, Rows={Rows}, BatchValues={BatchValues}",
                messageCount,
                rows.Count,
                _batchValues);
            return new TelemetryBatchStoreResult(false, AsList(rows), messageCount);
        }
        finally
        {
            if (client is not null)
                _pool.Return(client);
        }
    }

    internal static string? BuildMessageRecord(
        PlayloadData message,
        List<TelemetryData> materialized,
        out int valueCount)
    {
        valueCount = 0;
        var fields = new StringBuilder();

        foreach (var item in message.MsgBody)
        {
            if (item.Value is null)
                continue;

            var row = new TelemetryData
            {
                DateTime = message.ts,
                DeviceId = message.DeviceId,
                KeyName = item.Key,
                DataSide = message.DataSide,
                Value_DateTime = DateTime.UnixEpoch
            };
            row.FillKVToMe(item);

            if (!TryAppendField(fields, row))
                continue;

            materialized.Add(row);
            valueCount++;
        }

        return valueCount == 0 ? null : BuildRecord(message.DeviceId, fields, message.ts);
    }

    internal static string? BuildRowRecord(TelemetryData row)
    {
        var fields = new StringBuilder();
        return TryAppendField(fields, row) ? BuildRecord(row.DeviceId, fields, row.DateTime) : null;
    }

    private static string BuildRecord(Guid deviceId, StringBuilder fields, DateTime timestamp)
        => $"{Measurement},DeviceId={deviceId:D} {fields} {ToUnixNanoseconds(timestamp)}";

    private static bool TryAppendField(StringBuilder builder, TelemetryData row)
    {
        var originalLength = builder.Length;
        if (builder.Length > 0)
            builder.Append(',');
        AppendEscapedKey(builder, row.KeyName);
        builder.Append('=');

        switch (row.Type)
        {
            case DataType.Boolean when row.Value_Boolean.HasValue:
                builder.Append(row.Value_Boolean.Value ? "true" : "false");
                return true;
            case DataType.String when row.Value_String is not null:
                AppendQuotedString(builder, row.Value_String);
                return true;
            case DataType.Long when row.Value_Long.HasValue:
                builder.Append(row.Value_Long.Value.ToString(CultureInfo.InvariantCulture)).Append('i');
                return true;
            case DataType.Double when row.Value_Double.HasValue && double.IsFinite(row.Value_Double.Value):
                builder.Append(row.Value_Double.Value.ToString("R", CultureInfo.InvariantCulture));
                return true;
            case DataType.Json when row.Value_Json is not null:
                AppendQuotedString(builder, row.Value_Json);
                return true;
            case DataType.XML when row.Value_XML is not null:
                AppendQuotedString(builder, row.Value_XML);
                return true;
            case DataType.Binary when row.Value_Binary is not null:
                AppendQuotedString(builder, Hex.BytesToHex(row.Value_Binary));
                return true;
            case DataType.DateTime when row.Value_DateTime.HasValue:
                builder.Append(
                    row.Value_DateTime.Value.ToUniversalTime()
                        .Subtract(DateTime.UnixEpoch)
                        .TotalMilliseconds
                        .ToString("R", CultureInfo.InvariantCulture));
                return true;
            default:
                builder.Length = originalLength;
                return false;
        }
    }

    private static void AppendEscapedKey(StringBuilder builder, string value)
    {
        foreach (var ch in value)
        {
            if (ch is ' ' or ',' or '=' or '\\')
                builder.Append('\\');
            builder.Append(ch);
        }
    }

    private static void AppendQuotedString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (var ch in value)
        {
            if (ch is '"' or '\\')
                builder.Append('\\');
            builder.Append(ch);
        }
        builder.Append('"');
    }

    private static long ToUnixNanoseconds(DateTime value)
    {
        var utc = value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
        return checked((utc.Ticks - DateTime.UnixEpoch.Ticks) * 100L);
    }

    private void EnsureConfigured()
    {
        if (!IsConfigured)
            throw new InvalidOperationException(
                "InfluxDB telemetry History writer requires org and bucket in ConnectionStrings:TelemetryStorage.");
    }

    private static List<TelemetryData> AsList(IReadOnlyCollection<TelemetryData> rows)
        => rows as List<TelemetryData> ?? rows.ToList();
}
