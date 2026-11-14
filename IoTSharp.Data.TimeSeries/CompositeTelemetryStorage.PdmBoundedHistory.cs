using IoTSharp.Contracts;

namespace IoTSharp.Storage;

public sealed partial class CompositeTelemetryStorage
{
    /// <summary>
    /// Delegate only to the configured History provider, never to relational Latest.
    /// A provider missing the bounded contract fails closed; no unlimited fallback.
    /// </summary>
    public Task<List<TelemetryDataDto>> LoadTelemetryBoundedAsync(
        Guid deviceId, IReadOnlyList<string> keys, DateTime beginUtc, DateTime endUtc,
        int maxRows, CancellationToken cancellationToken)
    {
        if (_historyStorage is not IBoundedTelemetryHistoryStorage history)
            throw new NotSupportedException(
                $"PdM bounded history not implemented for {_historyStorage.GetType().Name}.");
        return history.LoadTelemetryBoundedAsync(
            deviceId, keys, beginUtc, endUtc, maxRows, cancellationToken);
    }
}

