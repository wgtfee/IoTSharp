using System;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

/// <summary>Protect existing auto-migrate deployments until provider migrations are reviewed.</summary>
public sealed class PdmRuntimeIsolationTests
{
    [Fact]
    public void MainDbContext_DoesNotExposeUnmigratedPdmTables()
    {
        var services = new ServiceCollection();
        services.AddEntityFrameworkInMemoryDatabase();
        services.AddSingleton<IDataBaseModelBuilderOptions, TestModelBuilderOptions>();
        services.AddDbContext<ApplicationDbContext>((provider, options) =>
        {
            options.UseInMemoryDatabase(Guid.NewGuid().ToString("N"));
            options.UseInternalServiceProvider(provider);
        });
        using var provider = services.BuildServiceProvider(validateScopes: true);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        Assert.Null(db.Model.FindEntityType(typeof(PdmDeviceProfile)));
        Assert.Null(db.Model.FindEntityType(typeof(PdmPointPolicy)));
        Assert.Null(db.Model.FindEntityType(typeof(PdmHealthSnapshot)));
        Assert.Null(db.Model.FindEntityType(typeof(PdmRiskEvent)));
    }

    private sealed class TestModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}

