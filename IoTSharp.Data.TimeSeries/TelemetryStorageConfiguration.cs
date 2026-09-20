using IoTSharp.Contracts;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System.Collections.Specialized;
using System.Web;

namespace IoTSharp.Data.TimeSeries;

public sealed record TelemetryStorageRuntimeConfiguration(
    TelemetryPersistenceMode RequestedMode,
    TelemetryPersistenceMode EffectiveMode,
    TelemetryStorage HistoryStorage,
    TelemetryLatestStorageMode LatestStorage,
    string HistoryConnectionString,
    bool UsesIndependentHistoryProvider,
    bool DurableSpoolEnabled,
    bool DurableReplaySupported,
    IReadOnlyList<string> Warnings);

internal static class TelemetryStorageConfigurationResolver
{
    internal static TelemetryStorageRuntimeConfiguration Resolve(AppSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var historyStorage = settings.EffectiveTelemetryHistoryStorage;
        var externalHistory = IsIndependentHistoryStorage(historyStorage);
        var effectiveMode = ResolveMode(settings.TelemetryMode, externalHistory, settings.TelemetryLatestStorage);
        ValidateExplicitMode(settings.TelemetryMode, externalHistory, settings.TelemetryLatestStorage, historyStorage);

        var historyConnectionString = ResolveHistoryConnectionString(settings, historyStorage, externalHistory);
        ValidateProviderConnection(historyStorage, historyConnectionString);

        if (settings.TelemetryLatestStorage == TelemetryLatestStorageMode.Relational
            && externalHistory
            && !TryGetConnectionString(settings, "IoTSharp", out _))
        {
            throw new InvalidOperationException(
                "ConnectionStrings:IoTSharp is required when TelemetryLatestStorage=Relational and telemetry History uses an independent time-series provider.");
        }

        if (historyStorage == TelemetryStorage.TimescaleDB && settings.DataBase != DataBaseType.PostgreSql)
        {
            throw new InvalidOperationException(
                "TelemetryHistoryStorage=TimescaleDB currently requires DataBase=PostgreSql because TimescaleDBStorage reuses ApplicationDbContext. " +
                "An independent TimescaleDB history database cannot yet be combined with a different business database.");
        }

        var replaySupported = SupportsConfiguredDurableReplay(settings, historyStorage, historyConnectionString);
        var spoolEnabled = settings.TelemetryHistorySpool?.Enabled == true;
        if (spoolEnabled && !replaySupported)
        {
            throw new InvalidOperationException(
                $"TelemetryHistorySpool is enabled, but the configured History path cannot safely replay materialized rows. " +
                $"History={historyStorage}, Database={settings.DataBase}, Sharding={settings.ShardingByDateMode}. " +
                "Use PostgreSQL/SQL Server monthly sharding, InfluxDB, or IoTDB; otherwise disable TelemetryHistorySpool.");
        }

        var warnings = BuildWarnings(settings, historyStorage);
        return new TelemetryStorageRuntimeConfiguration(
            settings.TelemetryMode,
            effectiveMode,
            historyStorage,
            settings.TelemetryLatestStorage,
            historyConnectionString,
            externalHistory,
            spoolEnabled,
            replaySupported,
            warnings);
    }

    internal static bool IsIndependentHistoryStorage(TelemetryStorage storage)
        => storage is TelemetryStorage.Taos
            or TelemetryStorage.InfluxDB
            or TelemetryStorage.IoTDB
            or TelemetryStorage.SonnetDB;

    internal static bool SupportsConfiguredDurableReplay(
        AppSettings settings,
        TelemetryStorage historyStorage,
        string historyConnectionString)
    {
        if (string.IsNullOrWhiteSpace(historyConnectionString))
            return false;

        return historyStorage switch
        {
            TelemetryStorage.Sharding => settings.ShardingByDateMode == ShardingByDateMode.PerMonth
                && settings.DataBase is DataBaseType.SqlServer or DataBaseType.PostgreSql,
            TelemetryStorage.InfluxDB => IsInfluxConfigured(historyConnectionString),
            TelemetryStorage.IoTDB => true,
            _ => false
        };
    }

    private static TelemetryPersistenceMode ResolveMode(
        TelemetryPersistenceMode requestedMode,
        bool externalHistory,
        TelemetryLatestStorageMode latestStorage)
    {
        if (requestedMode != TelemetryPersistenceMode.Auto)
            return requestedMode;

        if (!externalHistory)
            return TelemetryPersistenceMode.RelationalOnly;

        return latestStorage == TelemetryLatestStorageMode.Relational
            ? TelemetryPersistenceMode.RelationalWithTimeSeries
            : TelemetryPersistenceMode.Auto;
    }

    private static void ValidateExplicitMode(
        TelemetryPersistenceMode requestedMode,
        bool externalHistory,
        TelemetryLatestStorageMode latestStorage,
        TelemetryStorage historyStorage)
    {
        if (requestedMode == TelemetryPersistenceMode.RelationalOnly && externalHistory)
        {
            throw new InvalidOperationException(
                $"TelemetryMode=RelationalOnly cannot use TelemetryHistoryStorage={historyStorage}. " +
                "Choose SingleTable/Sharding/TimescaleDB or set TelemetryMode=RelationalWithTimeSeries.");
        }

        if (requestedMode == TelemetryPersistenceMode.RelationalWithTimeSeries)
        {
            if (!externalHistory)
            {
                throw new InvalidOperationException(
                    $"TelemetryMode=RelationalWithTimeSeries requires an independent time-series History provider; current History={historyStorage}.");
            }

            if (latestStorage != TelemetryLatestStorageMode.Relational)
            {
                throw new InvalidOperationException(
                    "TelemetryMode=RelationalWithTimeSeries requires TelemetryLatestStorage=Relational so Latest values stay in the business database.");
            }
        }
    }

    private static string ResolveHistoryConnectionString(
        AppSettings settings,
        TelemetryStorage historyStorage,
        bool externalHistory)
    {
        if (TryGetConnectionString(settings, "TelemetryStorage", out var telemetryConnectionString))
            return telemetryConnectionString;

        if (!externalHistory && TryGetConnectionString(settings, "IoTSharp", out var businessConnectionString))
            return businessConnectionString;

        throw new InvalidOperationException(
            $"ConnectionStrings:TelemetryStorage is required for TelemetryHistoryStorage={historyStorage}.");
    }

    private static void ValidateProviderConnection(TelemetryStorage historyStorage, string connectionString)
    {
        if (historyStorage != TelemetryStorage.InfluxDB)
            return;

        if (!Uri.TryCreate(connectionString, UriKind.Absolute, out var uri))
            throw new InvalidOperationException("InfluxDB TelemetryStorage connection string must be an absolute URI.");

        NameValueCollection query = HttpUtility.ParseQueryString(uri.Query);
        if (string.IsNullOrWhiteSpace(query.Get("org")) || string.IsNullOrWhiteSpace(query.Get("bucket")))
        {
            throw new InvalidOperationException(
                "InfluxDB TelemetryStorage connection string requires both org and bucket query parameters.");
        }
    }

    private static bool IsInfluxConfigured(string connectionString)
    {
        if (!Uri.TryCreate(connectionString, UriKind.Absolute, out var uri))
            return false;
        NameValueCollection query = HttpUtility.ParseQueryString(uri.Query);
        return !string.IsNullOrWhiteSpace(query.Get("org"))
            && !string.IsNullOrWhiteSpace(query.Get("bucket"));
    }

    private static bool TryGetConnectionString(AppSettings settings, string name, out string connectionString)
    {
        connectionString = string.Empty;
        if (settings.ConnectionStrings == null
            || !settings.ConnectionStrings.TryGetValue(name, out var value)
            || string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        connectionString = value;
        return true;
    }

    private static IReadOnlyList<string> BuildWarnings(AppSettings settings, TelemetryStorage historyStorage)
    {
        var warnings = new List<string>();
        if (settings.TelemetryMode == TelemetryPersistenceMode.Auto
            && IsIndependentHistoryStorage(historyStorage)
            && settings.TelemetryLatestStorage == TelemetryLatestStorageMode.SameAsHistory)
        {
            warnings.Add(
                "Legacy external-History topology is active under TelemetryMode=Auto. " +
                "For new deployments prefer TelemetryMode=RelationalWithTimeSeries and TelemetryLatestStorage=Relational.");
        }

        if (settings.TelemetryPostgreSqlCopyRows is < 1_000 or > 250_000)
            warnings.Add("TelemetryPostgreSqlCopyRows will be clamped to 1,000..250,000.");
        if (settings.TelemetryInfluxBatchValues is < 1_000 or > 100_000)
            warnings.Add("TelemetryInfluxBatchValues will be clamped to 1,000..100,000.");
        if (settings.TelemetryIoTDBTabletRows is < 1_000 or > 100_000)
            warnings.Add("TelemetryIoTDBTabletRows will be clamped to 1,000..100,000.");
        if (settings.TelemetryHistorySpool?.RetryDelayMilliseconds is < 50 or > 60_000)
            warnings.Add("TelemetryHistorySpool.RetryDelayMilliseconds will be clamped to 50..60,000.");
        return warnings;
    }
}

public sealed class TelemetryStorageConfigurationHealthCheck : IHealthCheck
{
    private readonly TelemetryStorageRuntimeConfiguration _configuration;

    public TelemetryStorageConfigurationHealthCheck(TelemetryStorageRuntimeConfiguration configuration)
        => _configuration = configuration;

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        var data = new Dictionary<string, object>
        {
            ["telemetry.mode.requested"] = _configuration.RequestedMode.ToString(),
            ["telemetry.mode.effective"] = _configuration.EffectiveMode.ToString(),
            ["telemetry.history.provider"] = _configuration.HistoryStorage.ToString(),
            ["telemetry.latest.provider"] = _configuration.LatestStorage.ToString(),
            ["telemetry.history.independent"] = _configuration.UsesIndependentHistoryProvider,
            ["telemetry.spool.enabled"] = _configuration.DurableSpoolEnabled,
            ["telemetry.spool.replaySupported"] = _configuration.DurableReplaySupported,
            ["telemetry.configuration.warningCount"] = _configuration.Warnings.Count
        };

        var description = _configuration.Warnings.Count == 0
            ? "Telemetry storage configuration is valid."
            : $"Telemetry storage configuration is valid with {_configuration.Warnings.Count} warning(s): {string.Join(" | ", _configuration.Warnings)}";

        return Task.FromResult(HealthCheckResult.Healthy(description, data));
    }
}
