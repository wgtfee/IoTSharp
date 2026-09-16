using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Services.RuleAudit;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

public sealed class FlowRuleAuditPipelineTests
{
    [Fact]
    public async Task StopAsync_DrainsQueuedRecords_AndRejectsLateEnqueueWithoutThrowing()
    {
        using var provider = BuildServices();
        var ruleId = Guid.NewGuid();

        await using (var scope = provider.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            dbContext.FlowRules.Add(new FlowRule
            {
                RuleId = ruleId,
                Name = "audit-drain-test",
                Describes = string.Empty,
                Runner = string.Empty,
                ExecutableCode = string.Empty,
                Creator = string.Empty,
                RuleDesc = string.Empty,
                DefinitionsXml = string.Empty,
                MountType = EventType.Telemetry,
                CreatTime = DateTime.UtcNow
            });
            await dbContext.SaveChangesAsync();
        }

        using var pipeline = new FlowRuleAuditPipeline(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new FlowRuleAuditOptions
            {
                Capacity = 16,
                BatchSize = 16,
                FlushIntervalMilliseconds = 5_000,
                RetryDelayMilliseconds = 1
            }),
            NullLogger<FlowRuleAuditPipeline>.Instance);

        await pipeline.StartAsync(CancellationToken.None);

        for (var i = 0; i < 5; i++)
        {
            await pipeline.EnqueueAsync(CreateRecord(ruleId, i));
        }

        using (var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
        {
            await pipeline.StopAsync(stopCts.Token);
        }

        await using (var scope = provider.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            Assert.Equal(5, await dbContext.BaseEvents.CountAsync());
        }

        await pipeline.EnqueueAsync(CreateRecord(ruleId, 99));

        await using (var scope = provider.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            Assert.Equal(5, await dbContext.BaseEvents.CountAsync());
        }
    }

    private static FlowRuleAuditRecord CreateRecord(Guid ruleId, int index) => new(
        Guid.NewGuid(),
        $"event-{index}",
        "shutdown drain",
        0,
        FlowRuleRunType.Normal,
        "{}",
        Guid.NewGuid(),
        ruleId,
        $"biz-{index}",
        DateTime.UtcNow,
        "{}");

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddEntityFrameworkInMemoryDatabase();
        services.AddSingleton<IDataBaseModelBuilderOptions, TestModelBuilderOptions>();
        services.AddDbContext<ApplicationDbContext>((provider, options) =>
        {
            options.UseInMemoryDatabase(Guid.NewGuid().ToString("N"));
            options.UseInternalServiceProvider(provider);
        });
        return services.BuildServiceProvider(validateScopes: true);
    }

    private sealed class TestModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}
