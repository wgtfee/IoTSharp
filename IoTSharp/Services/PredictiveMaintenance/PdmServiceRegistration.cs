using System;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace IoTSharp.Services.PredictiveMaintenance;

/// <summary>
/// 明确配置门禁的 P1-04 依赖注册；关闭时零 DB Context、零 Worker、零后台查询。
/// PdM 独立数据库需由 DBA 按迁移方案创建，不允许自动 EnsureCreated/Migrate。
/// </summary>
public static class PdmServiceRegistration
{
    public static IServiceCollection AddPredictiveMaintenanceP1(
        this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        var section = configuration.GetSection(PdmWorkerOptions.SectionName);
        services.Configure<PdmWorkerOptions>(section);
        if (!section.GetValue<bool>(nameof(PdmWorkerOptions.Enabled), false))
            return services;

        var options = section.Get<PdmWorkerOptions>() ?? new PdmWorkerOptions();
        if (!options.SchemaReady || !options.SingleInstanceAcknowledged ||
            !options.PointMappingsApproved || !options.HistoryQueryPlanApproved ||
            !options.HistoryUtcContractApproved)
            throw new InvalidOperationException(
                "PdM worker activation denied: SchemaReady, SingleInstanceAcknowledged, PointMappingsApproved, HistoryQueryPlanApproved and HistoryUtcContractApproved must be true.");
        if (options.PollSeconds is < 30 or > 3600 ||
            options.MaxProfilesPerCycle is < 1 or > 20 ||
            options.MaxPointsPerDevice is < 1 or > 32 ||
            options.MaxHistoryRowsPerDevice is < 1 or > 100_000 ||
            options.RecoveryConsecutiveWindows is < 1 or > 100 ||
            options.HistoryQueryTimeoutSeconds is < 1 or > 120)
            throw new InvalidOperationException("PdM worker activation denied: resource or recovery configuration invalid.");

        var connection = configuration.GetConnectionString("PdmMetadata");
        if (string.IsNullOrWhiteSpace(connection))
            throw new InvalidOperationException("PdM metadata must use an explicitly configured independent database.");
        if (string.Equals(connection, configuration.GetConnectionString("IoTSharp"), StringComparison.Ordinal) ||
            string.Equals(connection, configuration.GetConnectionString("TelemetryStorage"), StringComparison.Ordinal))
            throw new InvalidOperationException("PdM metadata connection cannot reuse IoTSharp or telemetry history connections.");
        var provider = options.MetadataProvider.Trim();
        if (provider is not ("Sqlite" or "SqlServer" or "PostgreSql"))
            throw new InvalidOperationException("PdM metadata Provider must be Sqlite, SqlServer or PostgreSql.");

        services.AddDbContext<PdmDbContext>(db =>
        {
            switch (provider)
            {
                case "Sqlite": db.UseSqlite(connection); break;
                case "SqlServer": db.UseSqlServer(connection); break;
                case "PostgreSql": db.UseNpgsql(connection); break;
            }
        });
        services.AddScoped<IPdmHistoryReader, PdmTelemetryHistoryReader>();
        services.AddSingleton<PdmHealthEvaluator>();
        services.AddScoped<PdmCycleProcessor>();
        services.AddHostedService<PdmEvaluationWorker>();
        return services;
    }
}

