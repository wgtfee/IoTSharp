using IoTSharp.Contracts;
using IoTSharp.Data;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Storage
{
    public interface IStorage
    {
        Task<bool> CheckTelemetryStorage();
        Task<(bool result, List<TelemetryData> telemetries)> StoreTelemetryAsync(PlayloadData msg);
        async Task<TelemetryBatchStoreResult> StoreTelemetryBatchAsync(IReadOnlyCollection<PlayloadData> messages)
        {
            var telemetries = new List<TelemetryData>();
            var ok = true;
            foreach (var message in messages)
            {
                var result = await StoreTelemetryAsync(message);
                ok &= result.result;
                telemetries.AddRange(result.telemetries);
            }

            return new TelemetryBatchStoreResult(ok, telemetries, messages.Count);
        }

        Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId);
        Task<List<TelemetryDataDto>> GetTelemetryLatest(Guid deviceId, string keys);

        Task<List<TelemetryDataDto>> LoadTelemetryAsync(Guid deviceId, string keys, DateTime begin, DateTime end, TimeSpan every, Aggregate aggregate);

    }

    /// <summary>
    /// Optional capability for History providers that can replay already-materialized telemetry rows.
    /// Durable History spool uses this contract so provider-specific writers can opt in without
    /// leaking provider assumptions into the EventBus layer.
    /// </summary>
    public interface ITelemetryHistoryRowStorage
    {
        bool SupportsTelemetryHistoryRowReplay { get; }
        Task<TelemetryBatchStoreResult> StoreTelemetryHistoryRowsAsync(IReadOnlyCollection<TelemetryData> rows, int messageCount);
    }

    /// <summary>
    /// Optional capability for providers that can persist Latest and History independently.
    /// </summary>
    public interface ISplitTelemetryBatchStorage : ITelemetryHistoryRowStorage
    {
        Task<TelemetryBatchStoreResult> StoreTelemetryLatestBatchAsync(IReadOnlyCollection<PlayloadData> messages);
        Task<TelemetryBatchStoreResult> StoreTelemetryHistoryBatchAsync(IReadOnlyCollection<PlayloadData> messages);
    }

    public sealed record TelemetryBatchStoreResult(bool Result, List<TelemetryData> Telemetries, int MessageCount);
}
