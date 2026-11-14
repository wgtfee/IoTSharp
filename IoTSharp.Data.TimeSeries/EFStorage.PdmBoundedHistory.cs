using IoTSharp.Contracts;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Storage;

public partial class EFStorage
{
    /// <summary>Server-side TOP/LIMIT via EF Core, cancellation included; no shared hot-path changes.</summary>
    public virtual async Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
        Guid deviceId, IReadOnlyList<string> keys, DateTime beginUtc, DateTime endUtc,
        int maxRows, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var scope = _scopeFactor.CreateScope();
        await using var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var query = BoundedTelemetryHistoryQuery.Build(
            db.Set<TelemetryData>().AsNoTracking(),
            deviceId, keys, beginUtc, endUtc, maxRows);
        var rows = await query.ToListAsync(cancellationToken);
        if (rows.Count > maxRows)
            throw new TelemetryHistoryLimitExceededException();
        return rows.Select(x => new TelemetryDataDto
        {
            DateTime = x.DateTime, KeyName = x.KeyName, DataType = x.Type,
            Value = x.ToObject()
        }).ToList();
    }
}

