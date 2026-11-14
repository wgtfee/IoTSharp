using System;
using IoTSharp.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>Explicit opt-in for IoTSharp internal work orders only.</summary>
public static class PdmInternalWorkOrderRegistration
{
    public const string Prefix = "PredictiveMaintenance:WorkOrders:";

    public static IServiceCollection AddPdmInternalWorkOrders(
        this IServiceCollection services, IConfiguration config)
    {
        if (!config.GetValue<bool>(Prefix + "Enabled"))
            return services;
        if (!config.GetValue<bool>(Prefix + "SchemaReady") ||
            !config.GetValue<bool>("PredictiveMaintenance:Enabled") ||
            !config.GetValue<bool>("PredictiveMaintenance:SchemaReady") ||
            !config.GetValue<bool>("PredictiveMaintenance:SingleInstanceAcknowledged") ||
            !config.GetValue<bool>("PredictiveMaintenance:PointMappingsApproved") ||
            !config.GetValue<bool>("PredictiveMaintenance:HistoryQueryPlanApproved") ||
            !config.GetValue<bool>("PredictiveMaintenance:HistoryUtcContractApproved"))
            throw new InvalidOperationException(
                "PdM internal orders cannot be enabled without approved P1 and separate work-order schema.");

        var connection = config.GetConnectionString("PdmWorkOrders");
        if (string.IsNullOrWhiteSpace(connection))
            throw new InvalidOperationException("Missing independent ConnectionStrings:PdmWorkOrders.");
        var builder = new SqlConnectionStringBuilder(connection);
        if (string.IsNullOrWhiteSpace(builder.InitialCatalog) ||
            builder.InitialCatalog.Equals("IOTSharp", StringComparison.OrdinalIgnoreCase) ||
            builder.InitialCatalog.Equals("master", StringComparison.OrdinalIgnoreCase) ||
            builder.InitialCatalog.Equals("tempdb", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(connection, config.GetConnectionString("TelemetryStorage"),
                StringComparison.OrdinalIgnoreCase) ||
            string.Equals(connection, config.GetConnectionString("IoTSharp"),
                StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("PdM work-order DB must be dedicated and cannot be the main/telemetry database.");

        services.AddDbContext<PdmInternalWorkOrderDbContext>(options => options.UseSqlServer(connection));
        services.AddScoped<PdmInternalWorkOrderService>();
        if (config.GetValue<bool>(Prefix + "AutoCreateEnabled"))
            services.AddScoped<PdmInternalWorkOrderAutoCreator>();
        var feishuSection = config.GetSection(PdmWorkOrderFeishuOptions.SectionName);
        if (feishuSection.GetValue<bool>("Enabled"))
        {
            var feishu = feishuSection.Get<PdmWorkOrderFeishuOptions>()
                ?? throw new InvalidOperationException("Missing IoTSharp PdM Feishu options.");
            feishu.Validate();
            services.Configure<PdmWorkOrderFeishuOptions>(feishuSection);
            services.AddScoped<PdmFeishuPushMcpSender>();
            services.AddScoped<IPdmManagedFeishuMcpSender>(
                provider => provider.GetRequiredService<PdmFeishuPushMcpSender>());
            services.AddScoped<PdmInternalWorkOrderFeishuDispatcher>();
            services.AddHostedService<PdmWorkOrderNotificationWorker>();
        }
        return services;
    }
}

/// <summary>
/// Invoked only after P1 persisted a verified real telemetry window.
/// This is an internal local order; sending a Feishu message is a separate step.
/// </summary>
public sealed class PdmInternalWorkOrderAutoCreator(
    PdmDbContext source,
    PdmInternalWorkOrderService orders)
{
    public async System.Threading.Tasks.Task<PdmInternalWorkOrder?> AfterCommittedWindowAsync(
        Guid profileId, DateTimeOffset windowEndUtc,
        System.Threading.CancellationToken ct = default)
    {
        if (profileId == Guid.Empty || windowEndUtc.Offset != TimeSpan.Zero)
            throw new ArgumentException("Invalid approved profile/window.");
        var profile = await source.DeviceProfiles.AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == profileId && x.Enabled, ct);
        if (profile is null || !profile.PointMappingsVerified || !profile.RunStateVerified)
            return null;
        var latest = await source.HealthSnapshots.AsNoTracking()
            .SingleOrDefaultAsync(x =>
                x.ProfileId == profile.Id && x.ProfileVersion == profile.Version &&
                x.WindowEndUtc == windowEndUtc.UtcDateTime &&
                x.TenantId == profile.TenantId && x.CustomerId == profile.CustomerId &&
                x.DeviceId == profile.DeviceId, ct);
        if (latest is null || latest.DataQuality != "Good" ||
            latest.RiskLevel is not ("Warning" or "Critical"))
            return null;
        var episode = await source.RiskEvents.AsNoTracking().SingleOrDefaultAsync(
            x => x.TenantId == profile.TenantId && x.CustomerId == profile.CustomerId &&
                 x.DeviceId == profile.DeviceId && x.ProfileId == profile.Id &&
                 x.ProfileVersion == profile.Version && x.Status == "Open" &&
                 x.LastEvaluatedWindowEndUtc == windowEndUtc.UtcDateTime &&
                 x.RiskType == PdmRiskEventTransitions.HealthRiskType, ct);
        if (episode is null || episode.OccurrenceCount < 2) return null;
        // SQL Server DateTime Kind is Unspecified on materialization;
        // the PdM metadata migration contract stores only UTC timestamps.
        latest.WindowStartUtc = DateTime.SpecifyKind(latest.WindowStartUtc, DateTimeKind.Utc);
        latest.WindowEndUtc = DateTime.SpecifyKind(latest.WindowEndUtc, DateTimeKind.Utc);
        episode.LastEvaluatedWindowEndUtc =
            DateTime.SpecifyKind(episode.LastEvaluatedWindowEndUtc, DateTimeKind.Utc);
        episode.FirstObservedUtc = DateTime.SpecifyKind(episode.FirstObservedUtc, DateTimeKind.Utc);
        return await orders.OpenFromVerifiedRiskAsync(profile, episode, latest, ct: ct);
    }
}
