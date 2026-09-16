using IoTSharp.Data;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;

namespace IoTSharp.Services.Ingestion;

public sealed class GatewayActivitySignalOptions
{
    public const string SectionName = "GatewayActivitySignal";
    public int MinIntervalSeconds { get; set; } = 1;
    public int MaxIntervalSeconds { get; set; } = 30;
    public int TimeoutDivisor { get; set; } = 3;
}

/// <summary>
/// Coalesces high-frequency gateway batch activity before it reaches the selected EventBus.
/// The interval is derived from device timeout so activity refresh remains safely ahead of inactivity detection.
/// </summary>
public sealed class GatewayActivitySignalGate
{
    private readonly ConcurrentDictionary<Guid, SignalState> _states = new();
    private readonly GatewayActivitySignalOptions _options;

    public GatewayActivitySignalGate(IOptions<GatewayActivitySignalOptions> options)
    {
        _options = Normalize(options.Value);
    }

    public bool ShouldPublish(Device device)
    {
        ArgumentNullException.ThrowIfNull(device);
        return ShouldPublish(device.Id, device.Timeout, DateTime.UtcNow);
    }

    internal bool ShouldPublish(Guid deviceId, int timeoutSeconds, DateTime utcNow)
    {
        var interval = GetInterval(timeoutSeconds, _options);
        var state = _states.GetOrAdd(deviceId, static _ => new SignalState());
        lock (state)
        {
            if (!state.HasPublished || utcNow - state.LastPublishedAtUtc >= interval)
            {
                state.HasPublished = true;
                state.LastPublishedAtUtc = utcNow;
                return true;
            }
            return false;
        }
    }

    internal static TimeSpan GetInterval(int timeoutSeconds, GatewayActivitySignalOptions options)
    {
        var normalized = Normalize(options);
        var timeout = Math.Max(1, timeoutSeconds);
        var seconds = Math.Max(1, timeout / normalized.TimeoutDivisor);
        return TimeSpan.FromSeconds(Math.Clamp(seconds, normalized.MinIntervalSeconds, normalized.MaxIntervalSeconds));
    }

    private static GatewayActivitySignalOptions Normalize(GatewayActivitySignalOptions source)
    {
        source ??= new GatewayActivitySignalOptions();
        var min = Math.Max(1, source.MinIntervalSeconds);
        var max = Math.Max(min, source.MaxIntervalSeconds);
        return new GatewayActivitySignalOptions
        {
            MinIntervalSeconds = min,
            MaxIntervalSeconds = max,
            TimeoutDivisor = Math.Max(2, source.TimeoutDivisor)
        };
    }

    private sealed class SignalState
    {
        public bool HasPublished { get; set; }
        public DateTime LastPublishedAtUtc { get; set; }
    }
}
