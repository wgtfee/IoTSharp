#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Models;
using IoTSharp.Services.DigitalTwin;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

/// <summary>
/// 场景草稿幂等提交和不可变发布快照的领域回归测试。
/// </summary>
public sealed class DigitalTwinSceneServiceTests
{
    [Fact]
    public async Task SceneRevision_IsTheOnlyAggregateConcurrencyToken()
    {
        await using var services = BuildServices();
        await using var scope = services.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        var sceneRevision = context.Model.FindEntityType(typeof(DigitalTwinScene))!
            .FindProperty(nameof(DigitalTwinScene.Revision));
        var routeRevision = context.Model.FindEntityType(typeof(TwinRoute))!
            .FindProperty(nameof(TwinRoute.Revision));

        Assert.True(sceneRevision!.IsConcurrencyToken);
        Assert.False(routeRevision!.IsConcurrencyToken);
    }

    [Fact]
    public async Task SaveAndPublish_AreIdempotent_AndCopyDraftRelationsOnce()
    {
        await using var services = BuildServices();
        await using var scope = services.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var service = new DigitalTwinSceneService(context);
        var tenant = new Tenant { Id = Guid.NewGuid(), Name = "测试租户" };
        var customer = new Customer { Id = Guid.NewGuid(), Name = "测试客户", Tenant = tenant };
        var asset = new Asset
        {
            Id = Guid.NewGuid(),
            Name = "包装",
            Description = string.Empty,
            AssetType = "Line",
            Tenant = tenant,
            Customer = customer
        };
        context.AddRange(tenant, customer, asset);
        await context.SaveChangesAsync();

        var profile = new UserProfile
        {
            Id = Guid.NewGuid(),
            Name = "admin",
            Email = "admin@local",
            Tenant = tenant.Id,
            Customer = customer.Id,
            Roles = ["SystemAdmin"]
        };
        using var manifest = JsonDocument.Parse($$"""
        {
          "schemaVersion": "iotsharp-twin-scene/v1",
          "sceneId": "{{Guid.NewGuid():D}}",
          "name": "发布测试场景",
          "description": "发布快照集合修复",
          "rootAssetId": "{{asset.Id:D}}",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [],
          "objects": [{
            "objectId": "packaging-line", "name": "包装线", "kind": "procedural", "assetId": "{{asset.Id:D}}",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [],
          "routes": [{
            "routeId": "main", "name": "主线", "type": "conveyor", "defaultSpeed": 1,
            "startPointId": "entry",
            "points": [
              { "pointId": "entry", "name": "入口", "position": [0,0,0] },
              { "pointId": "exit", "name": "出口", "position": [1,0,0] }
            ],
            "edges": [{ "edgeId": "main-edge", "fromPointId": "entry", "toPointId": "exit", "enabled": true }]
          }],
          "runtime": { "dataMode": "simulation" }
        }
        """);

        var created = await service.CreateAsync(new DigitalTwinSceneCreateDto
        {
            Name = "发布测试场景",
            Description = "发布快照集合修复",
            RootAssetId = asset.Id,
            DraftPayload = manifest.RootElement.Clone()
        }, profile, CancellationToken.None);

        var staleSave = new DigitalTwinDraftSaveDto
        {
            Revision = created.Revision,
            Name = created.Name,
            Description = created.Description,
            RootAssetId = created.RootAssetId,
            Payload = created.DraftPayload.Clone()
        };
        var saved = await service.SaveDraftAsync(created.Id, staleSave, profile, CancellationToken.None);
        var retriedSave = await service.SaveDraftAsync(created.Id, staleSave, profile, CancellationToken.None);

        Assert.Equal(2, saved.Revision);
        Assert.Equal(saved.Revision, retriedSave.Revision);

        var publishRequest = new DigitalTwinPublishDto { Revision = saved.Revision, ChangeSummary = "首次发布" };
        var published = await service.PublishAsync(created.Id, publishRequest, profile, CancellationToken.None);
        var retriedPublish = await service.PublishAsync(created.Id, publishRequest, profile, CancellationToken.None);

        Assert.Equal(published.Id, retriedPublish.Id);
        Assert.Equal(1, await context.DigitalTwinSceneVersions.CountAsync());
        Assert.Equal(2, await context.TwinObjectBindings.CountAsync());
        Assert.Equal(2, await context.TwinRoutes.CountAsync());
        Assert.Single(await context.TwinObjectBindings.Where(item => item.SceneVersionId == published.Id).ToListAsync());
        Assert.Single(await context.TwinRoutes.Where(item => item.SceneVersionId == published.Id).ToListAsync());

        await service.DeleteAsync(created.Id, profile, CancellationToken.None);

        Assert.Null(await service.GetAsync(created.Id, profile, CancellationToken.None));
        Assert.Null(await service.GetRuntimeManifestAsync(created.Id, profile, CancellationToken.None));
        Assert.True(await context.DigitalTwinScenes.IgnoreQueryFilters().Where(item => item.Id == created.Id).Select(item => item.Deleted).SingleAsync());
        Assert.Equal(1, await context.DigitalTwinSceneVersions.CountAsync());
        Assert.Single(await context.TwinObjectBindings.Where(item => item.SceneVersionId == published.Id && !item.Deleted).ToListAsync());
        Assert.Single(await context.TwinRoutes.Where(item => item.SceneVersionId == published.Id && !item.Deleted).ToListAsync());
    }

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
