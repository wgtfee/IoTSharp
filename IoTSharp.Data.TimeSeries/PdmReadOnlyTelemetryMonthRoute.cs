using IoTSharp.Data.Shardings.Routes;
using ShardingCore.Core.ServiceProviders;

namespace IoTSharp.Storage;

/// <summary>
/// PdM-only historical route for a completely separate read-only ShardingCore runtime.
/// Never register this route in the main IoTSharp telemetry writer container.
/// The ordinary TelemetryDataMonthRoute stays unchanged for normal ingestion.
/// </summary>
public sealed class PdmReadOnlyTelemetryMonthRoute(IShardingProvider provider)
    : TelemetryDataMonthRoute(provider)
{
    // Defense in depth: even if a future caller accidentally invokes the
    // ShardingCore compensation/bootstrap method, this route must not request
    // automatic creation of historical monthly tables.
    public override bool AutoCreateTableByTime() => false;
}

