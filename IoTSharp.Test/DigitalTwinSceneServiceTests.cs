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

    [Fact]
    public async Task Create_ValidatesV7ComponentAgainstDatabaseResourceMetadata()
    {
        await using var services = BuildServices();
        await using var scope = services.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var service = new DigitalTwinSceneService(context);
        var tenant = new Tenant { Id = Guid.NewGuid(), Name = "V7 测试租户" };
        var customer = new Customer { Id = Guid.NewGuid(), Name = "V7 测试客户", Tenant = tenant };
        var asset = new Asset { Id = Guid.NewGuid(), Name = "V7 组件线", Description = string.Empty, AssetType = "Line", Tenant = tenant, Customer = customer };
        var resource = new TwinModelResource
        {
            Id = Guid.NewGuid(),
            ResourceKey = "builtin-small-roller-conveyor",
            Name = "标准小辊道",
            RuntimeFormat = "application/vnd.iotsharp.twin-component+json",
            ModelMetadata = """{"resourceKey":"builtin-small-roller-conveyor","resourceType":"procedural-component","componentType":"roller-conveyor","generator":"roller-conveyor-v1","generatorVersion":1,"ports":[{"portId":"input","type":"material-input"},{"portId":"output","type":"material-output"}],"bindingSlots":[{"slotId":"ready","semantic":"ready"}]}""",
            ProcessingStatus = TwinModelProcessingStatus.Ready,
            OriginalFileName = string.Empty,
            StoragePath = string.Empty,
            ContentHash = "component-hash",
            NodeIndex = "{}",
            LicenseMetadata = """{"commercialUseAllowed":true}""",
            PreviewResourcePath = string.Empty,
            CreatedBy = "test",
            UpdatedBy = "test",
            TenantId = tenant.Id,
            CustomerId = customer.Id
        };
        context.AddRange(tenant, customer, asset, resource);
        await context.SaveChangesAsync();
        var profile = new UserProfile { Id = Guid.NewGuid(), Name = "admin", Email = "admin@local", Tenant = tenant.Id, Customer = customer.Id, Roles = ["SystemAdmin"] };

        static JsonElement CreateManifest(Guid assetId, Guid resourceId, int generatorVersion, string fromPortId = "output", string bindingSlotId = "ready")
        {
            using var document = JsonDocument.Parse($$"""
            {
              "name": "V7 数据库组件校验",
              "rootAssetId": "{{assetId:D}}",
              "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
              "resources": [{ "resourceId": "{{resourceId:D}}", "name": "标准小辊道", "status": "ready" }],
              "objects": [{
                "objectId": "roller-1", "name": "标准小辊道", "kind": "component", "resourceId": "{{resourceId:D}}", "assetId": "{{assetId:D}}",
                "component": {
                  "resourceKey": "builtin-small-roller-conveyor", "componentType": "roller-conveyor",
                  "generator": "roller-conveyor-v1", "generatorVersion": {{generatorVersion}},
                  "properties": { "length": 3, "transportUnitType": "plastic-pallet" },
                  "bindings": { "{{bindingSlotId}}": "binding-ready" }
                },
                "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
              }],
              "connections": [{
                "connectionId": "loop-test", "from": { "objectId": "roller-1", "portId": "{{fromPortId}}" },
                "to": { "objectId": "roller-1", "portId": "input" }
              }],
              "bindings": [{
                "bindingId": "binding-ready", "objectId": "roller-1",
                "source": { "kind": "simulation", "key": "ready" },
                "target": { "kind": "customProperty", "property": "ready" },
                "transform": { "kind": "routeEvent" }, "staleAfterMs": 5000
              }],
              "routes": [], "runtime": { "dataMode": "simulation" }
            }
            """);
            return document.RootElement.Clone();
        }

        var valid = await service.CreateAsync(new DigitalTwinSceneCreateDto
        {
            Name = "V7 合法组件",
            RootAssetId = asset.Id,
            DraftPayload = CreateManifest(asset.Id, resource.Id, 1)
        }, profile, CancellationToken.None);
        Assert.NotEqual(Guid.Empty, valid.Id);

        var exception = await Assert.ThrowsAsync<TwinValidationException>(() => service.CreateAsync(new DigitalTwinSceneCreateDto
        {
            Name = "V7 错误组件",
            RootAssetId = asset.Id,
            DraftPayload = CreateManifest(asset.Id, resource.Id, 2)
        }, profile, CancellationToken.None));
        Assert.Contains(exception.Validation.Diagnostics, item => item.Code == "twin.component.metadata.mismatch");

        var invalidPort = await Assert.ThrowsAsync<TwinValidationException>(() => service.CreateAsync(new DigitalTwinSceneCreateDto
        {
            Name = "V7 未登记端口",
            RootAssetId = asset.Id,
            DraftPayload = CreateManifest(asset.Id, resource.Id, 1, "forged-output")
        }, profile, CancellationToken.None));
        Assert.Contains(invalidPort.Validation.Diagnostics, item => item.Code == "twin.connection.port.unregistered");

        var invalidSlot = await Assert.ThrowsAsync<TwinValidationException>(() => service.CreateAsync(new DigitalTwinSceneCreateDto
        {
            Name = "V7 未登记 Binding Slot",
            RootAssetId = asset.Id,
            DraftPayload = CreateManifest(asset.Id, resource.Id, 1, "output", "forged-slot")
        }, profile, CancellationToken.None));
        Assert.Contains(invalidSlot.Validation.Diagnostics, item => item.Code == "twin.component.binding-slot.unregistered");
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
