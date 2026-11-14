using IoTSharp.Contracts;
using InfluxDB.Client.Core.Flux.Domain;

namespace IoTSharp.Storage;

public partial class InfluxDBStorage
{
    /// <summary>
    /// Flux server-side group+limit returns at most maxRows+1 across selected fields.
    /// Cancellation is forwarded to the Influx QueryApi and pool connection is returned in finally.
    /// </summary>
    public async Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
        Guid deviceId, IReadOnlyList<string> keys, DateTime beginUtc, DateTime endUtc,
        int maxRows, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var flux = PdmBoundedFluxBuilder.Build(
            _bucket ?? string.Empty, deviceId, keys, beginUtc, endUtc, maxRows);
        var client = _taospool.Get();
        try
        {
            var tables = await client.GetQueryApi().QueryAsync(flux, cancellationToken: cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();

            var result = new List<TelemetryDataDto>();
            foreach (var table in tables)
            {
                foreach (var record in table.Records)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (result.Count >= maxRows)
                        throw new TelemetryHistoryLimitExceededException();
                    var timestamp = record.GetTimeInDateTime()
                        ?? throw new InvalidOperationException("Flux timestamp missing");
                    // Flux timestamps represent UTC instants, regardless of DateTime.Kind returned by client SDK.
                    var utcTime = PdmFluxValueParser.RequireUtcInstant(timestamp);
                    var field = record.GetField();
                    if (field is null || !keys.Contains(field, StringComparer.Ordinal) ||
                        utcTime < beginUtc || utcTime >= endUtc)
                        throw new InvalidOperationException("Flux returned a row outside allowed field/window scope");
                    var normalized = PdmFluxValueParser.Parse(record.GetValue());
                    result.Add(new TelemetryDataDto
                    {
                        KeyName = field,
                        DateTime = utcTime,
                        Value = normalized.Value,
                        DataType = normalized.Type
                    });
                }
            }
            return result;
        }
        finally
        {
            _taospool.Return(client);
        }
    }
}

