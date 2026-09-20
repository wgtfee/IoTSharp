using IoTSharp.Contracts;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace IoTSharp.Test;

public sealed class SqlServerTelemetryStorageRegistrationTests
{
    [Fact]
    public void SingleTable_WithSqlServer_UsesSqlServerStorage()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);

        services.AddTelemetryStorage(settings, healthChecks);

        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.Equal(typeof(SqlServerStorage), descriptor.ImplementationType);
    }

    [Fact]
    public void SingleTable_WithNonSqlServer_KeepsEfStorage()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.PostgreSql);

        services.AddTelemetryStorage(settings, healthChecks);

        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.Equal(typeof(EFStorage), descriptor.ImplementationType);
    }

    [Fact]
    public void TelemetryHistoryStorage_OverridesLegacyTelemetryStorage()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryStorage = TelemetryStorage.SingleTable;
        settings.TelemetryHistoryStorage = TelemetryStorage.InfluxDB;
        settings.ConnectionStrings!["TelemetryStorage"] = "http://localhost:8086/?org=iotsharp&bucket=telemetry&token=test";

        services.AddTelemetryStorage(settings, healthChecks);

        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.Equal(typeof(InfluxDBStorage), descriptor.ImplementationType);
    }

    [Fact]
    public void ExternalHistory_WithRelationalLatest_RegistersCompositeStorage()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryHistoryStorage = TelemetryStorage.InfluxDB;
        settings.TelemetryLatestStorage = TelemetryLatestStorageMode.Relational;
        settings.ConnectionStrings!["TelemetryStorage"] = "http://localhost:8086/?org=iotsharp&bucket=telemetry&token=test";

        services.AddTelemetryStorage(settings, healthChecks);

        Assert.Contains(services, x => x.ServiceType == typeof(InfluxDBStorage));
        Assert.Contains(services, x => x.ServiceType == typeof(IRelationalTelemetryLatestStore));
        Assert.Contains(services, x => x.ServiceType == typeof(CompositeTelemetryStorage));
        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.NotNull(descriptor.ImplementationFactory);
        Assert.NotEqual(typeof(EFStorage), descriptor.ImplementationType);
    }

    [Fact]
    public void SameAsHistory_KeepsLegacyProviderRegistration()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryHistoryStorage = TelemetryStorage.InfluxDB;
        settings.TelemetryLatestStorage = TelemetryLatestStorageMode.SameAsHistory;
        settings.ConnectionStrings!["TelemetryStorage"] = "http://localhost:8086/?org=iotsharp&bucket=telemetry&token=test";

        services.AddTelemetryStorage(settings, healthChecks);

        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.Equal(typeof(InfluxDBStorage), descriptor.ImplementationType);
        Assert.DoesNotContain(services, x => x.ServiceType == typeof(CompositeTelemetryStorage));
    }

    [Fact]
    public void SingleTable_WithoutTelemetryStorageConnection_FallsBackToIoTSharp()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.ConnectionStrings!.Remove("TelemetryStorage");

        services.AddTelemetryStorage(settings, healthChecks);

        var descriptor = services.Last(x => x.ServiceType == typeof(IStorage));
        Assert.Equal(typeof(SqlServerStorage), descriptor.ImplementationType);
    }

    [Fact]
    public void ExternalHistory_WithoutTelemetryStorageConnection_ThrowsClearError()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryHistoryStorage = TelemetryStorage.InfluxDB;
        settings.ConnectionStrings!.Remove("TelemetryStorage");

        var ex = Assert.Throws<InvalidOperationException>(() => services.AddTelemetryStorage(settings, healthChecks));

        Assert.Contains("ConnectionStrings:TelemetryStorage", ex.Message);
    }

    [Fact]
    public void ExternalHistory_WithRelationalLatest_WithoutIoTSharpConnection_ThrowsClearError()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryHistoryStorage = TelemetryStorage.InfluxDB;
        settings.TelemetryLatestStorage = TelemetryLatestStorageMode.Relational;
        settings.ConnectionStrings!["TelemetryStorage"] = "http://localhost:8086/?org=iotsharp&bucket=telemetry&token=test";
        settings.ConnectionStrings.Remove("IoTSharp");

        var ex = Assert.Throws<InvalidOperationException>(() => services.AddTelemetryStorage(settings, healthChecks));

        Assert.Contains("ConnectionStrings:IoTSharp", ex.Message);
    }

    [Fact]
    public void TimescaleDb_WithSqlServerBusinessDatabase_ThrowsClearError()
    {
        var services = new ServiceCollection();
        var healthChecks = services.AddHealthChecks();
        var settings = CreateSettings(DataBaseType.SqlServer);
        settings.TelemetryHistoryStorage = TelemetryStorage.TimescaleDB;

        var ex = Assert.Throws<InvalidOperationException>(() => services.AddTelemetryStorage(settings, healthChecks));

        Assert.Contains("requires DataBase=PostgreSql", ex.Message);
    }

    private static AppSettings CreateSettings(DataBaseType database) => new()
    {
        DataBase = database,
        TelemetryStorage = TelemetryStorage.SingleTable,
        ConnectionStrings = new Dictionary<string, string>
        {
            ["IoTSharp"] = "Server=localhost;Database=IoTSharp;User Id=test;Password=test;TrustServerCertificate=True",
            ["TelemetryStorage"] = "Server=localhost;Database=IoTSharp;User Id=test;Password=test;TrustServerCertificate=True"
        }
    };
}
