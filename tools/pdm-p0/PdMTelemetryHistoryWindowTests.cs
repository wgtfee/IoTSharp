using System;
using System.Linq;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using TelemetryValueType = IoTSharp.Contracts.DataType;

namespace IoTSharp.Test;

// Verifies the actual EFStorage history reader against an isolated EF Core InMemory store.
public sealed class PdMTelemetryHistoryWindowTests
{
    [Fact]
    public async Task EfStorage_LoadTelemetryAsync_UsesUtcHalfOpenWindowAndFiltersDeviceAndKey()
    {
        using var provider = BuildServices();
        await using var scope = provider.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var ownDevice = Guid.NewGuid();
        var foreignDevice = Guid.NewGuid();
        var begin = new DateTime(2026, 3, 8, 9, 55, 0, DateTimeKind.Utc);
        var end = begin.AddMinutes(15);

        void Add(Guid deviceId, string key, DateTime date, double value) =>
            context.TelemetryData.Add(new TelemetryData {
                DeviceId = deviceId,
                KeyName = key,
                DateTime = date,
                Type = TelemetryValueType.Double,
                Value_Double = value
            });

        Add(ownDevice, "bearing_temperature", begin.AddMilliseconds(-1), 10);
        Add(ownDevice, "bearing_temperature", begin, 20);
        Add(ownDevice, "bearing_temperature", begin.AddMinutes(7), 30);
        Add(ownDevice, "bearing_temperature", end.AddMilliseconds(-1), 40);
        Add(ownDevice, "bearing_temperature", end, 50);
        Add(ownDevice, "bearing_temperature", end.AddMilliseconds(1), 60);
        Add(ownDevice, "other_point", begin, 70);
        Add(foreignDevice, "bearing_temperature", begin, 80);
        await context.SaveChangesAsync();

        var storage = new EFStorage(
            NullLogger<EFStorage>.Instance,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new AppSettings()));

        var result = await storage.LoadTelemetryAsync(
            ownDevice, "bearing_temperature", begin, end,
            TimeSpan.Zero, Aggregate.None);
        Assert.Equal(3, result.Count);
        Assert.Equal(new[] { 20d, 30d, 40d }, result.Select(x => (double)x.Value!).OrderBy(x => x).ToArray());
        Assert.Equal(begin, result.Min(x => x.DateTime));
        Assert.Equal(end.AddMilliseconds(-1), result.Max(x => x.DateTime));
    }

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddEntityFrameworkInMemoryDatabase();
        var databaseName = Guid.NewGuid().ToString("N");
        services.AddSingleton<IDataBaseModelBuilderOptions, StubModelBuilderOptions>();
        services.AddDbContext<ApplicationDbContext>((provider, options) =>
        {
            options.UseInMemoryDatabase(databaseName);
            options.UseInternalServiceProvider(provider);
        });
        return services.BuildServiceProvider(validateScopes: true);
    }

    private sealed class StubModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}

