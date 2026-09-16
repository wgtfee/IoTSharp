using IoTSharp.Contracts;
using IoTSharp.Data.TimeSeries;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
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

    private static AppSettings CreateSettings(DataBaseType database) => new()
    {
        DataBase = database,
        TelemetryStorage = TelemetryStorage.SingleTable,
        ConnectionStrings = new Dictionary<string, string>
        {
            ["TelemetryStorage"] = "Server=localhost;Database=IoTSharp;User Id=test;Password=test;TrustServerCertificate=True"
        }
    };
}
