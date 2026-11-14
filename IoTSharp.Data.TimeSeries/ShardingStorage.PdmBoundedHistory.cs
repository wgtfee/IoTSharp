using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Shardings;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Storage;

public partial class ShardingStorage
{
    /// <summary>
    /// Pushes Take(maxRows+1) into the ShardingCore EF read query.
    /// Verify actual routed SQL fanout against the selected shard layout before enabling PdM.
    /// </summary>
    public async Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
        Guid deviceId, IReadOnlyList<string> keys, DateTime beginUtc, DateTime endUtc,
        int maxRows, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Validate before resolving any DbContext or opening a data connection.
        BoundedTelemetryHistoryQuery.Validate(deviceId, keys, beginUtc, endUtc, maxRows);
        PdmMonthlyShardRouteGuard.EnsureCovers(_appSettings, beginUtc, endUtc);
        using var scope = _scopeFactor.CreateScope();
        await using var db = scope.ServiceProvider.GetRequiredService<ShardingDbContext>();
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

