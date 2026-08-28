using IoTSharp.Contracts;
using IoTSharp.Services.DigitalTwin;
using System;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace IoTSharp.Test;

/// <summary>
/// 数字孪生清单的安全边界和关系提取回归测试。
/// </summary>
public sealed class DigitalTwinManifestInspectorTests
{
    [Fact]
    public void Inspect_NormalizesIdentityAndExtractsResourceDeviceAndRouteBindings()
    {
        var sceneId = Guid.NewGuid();
        var assetId = Guid.NewGuid();
        var resourceId = Guid.NewGuid();
        var deviceId = Guid.NewGuid();
        using var document = JsonDocument.Parse($$"""
        {
          "schemaVersion": "legacy",
          "sceneId": "wrong",
          "name": "一号产线",
          "rootAssetId": "wrong",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [{ "resourceId": "{{resourceId:D}}", "name": "输送机", "status": "ready" }],
          "objects": [{
            "objectId": "conveyor-1", "name": "输送机", "kind": "model", "resourceId": "{{resourceId:D}}",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [{
            "bindingId": "motor-running", "objectId": "conveyor-1", "nodePath": "Motor_01",
            "source": { "kind": "telemetry", "deviceId": "{{deviceId:D}}", "key": "running" },
            "target": { "kind": "animation", "property": "rotation.y" },
            "transform": { "kind": "booleanAnimation", "trueValue": { "speed": 2 }, "falseValue": { "speed": 0 } },
            "staleAfterMs": 10000
          }],
          "routes": [{
            "routeId": "main", "name": "主线", "type": "conveyor", "defaultSpeed": 1.2,
            "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }]
          }],
          "editorExtension": {
            "source": "threejs-editor", "payloadVersion": 2,
            "threeEditor": {
              "sceneParams": { "camera": { "fov": 50 }, "environment": { "background": "#07111f" } },
              "modelParams": [{
                "rootInfo": { "type": "GLTF", "iotsharpObjectId": "conveyor-1", "iotsharpResourceId": "{{resourceId:D}}", "name": "conveyor.glb" },
                "group": { "name": "输送机", "position": { "x": 0, "y": 0, "z": 0 } }
              }],
              "upstream": { "repository": "z2586300277/threejs-editor", "license": "Apache-2.0" }
            }
          }
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, sceneId, assetId);

        Assert.True(result.Valid, string.Join("; ", result.Diagnostics.Select(item => item.Message)));
        Assert.Equal(2, result.Bindings.Count);
        Assert.Contains(result.Bindings, item => item.SourceKind == TwinBindingSourceKind.Resource && item.ModelResourceId == resourceId);
        Assert.Contains(result.Bindings, item => item.BindingKey == "motor-running" && item.DeviceId == deviceId && item.NodePath == "Motor_01");
        Assert.Single(result.Routes);
        using var normalized = JsonDocument.Parse(result.NormalizedPayload);
        Assert.Equal(sceneId.ToString("D"), normalized.RootElement.GetProperty("sceneId").GetString());
        Assert.Equal(assetId.ToString("D"), normalized.RootElement.GetProperty("rootAssetId").GetString());
        Assert.Equal(DigitalTwinContractVersions.SceneV1, normalized.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal("threejs-editor", normalized.RootElement.GetProperty("editorExtension").GetProperty("source").GetString());
        Assert.Equal(resourceId.ToString("D"), normalized.RootElement.GetProperty("editorExtension").GetProperty("threeEditor").GetProperty("modelParams")[0].GetProperty("rootInfo").GetProperty("iotsharpResourceId").GetString());
    }

    [Fact]
    public void Inspect_RejectsScriptsAndExternalUrls()
    {
        using var document = JsonDocument.Parse("""
        {
          "name": "危险场景",
          "world": { "unit": "meter", "upAxis": "Y", "background": "https://example.test/background" },
          "resources": [],
          "objects": [{
            "objectId": "object-1", "name": "对象", "kind": "procedural", "script": "alert(1)",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [],
          "routes": [{ "routeId": "main", "defaultSpeed": 1, "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }] }]
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.False(result.Valid);
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.script.forbidden");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.external-url.forbidden");
    }

    [Fact]
    public void Inspect_AllowsDescriptionButStillRejectsExecutablePropertyNames()
    {
        using var safeDocument = JsonDocument.Parse("""
        {
          "name": "包装线",
          "description": "包装数字孪生场景说明",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [],
          "objects": [{
            "objectId": "packaging-1", "name": "包装设备", "kind": "procedural",
            "description": "包装设备说明",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [],
          "routes": [{ "routeId": "main", "defaultSpeed": 1, "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }] }]
        }
        """);

        var safeResult = TwinManifestInspector.Inspect(safeDocument.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.True(safeResult.Valid, string.Join("; ", safeResult.Diagnostics.Select(item => item.Message)));

        using var unsafeDocument = JsonDocument.Parse("""
        {
          "name": "危险包装线",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [],
          "objects": [{
            "objectId": "packaging-1", "name": "包装设备", "kind": "procedural",
            "customScript": "alert(1)", "functionBody": "return true",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [],
          "routes": [{ "routeId": "main", "defaultSpeed": 1, "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }] }]
        }
        """);

        var unsafeResult = TwinManifestInspector.Inspect(unsafeDocument.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.False(unsafeResult.Valid);
        Assert.Equal(2, unsafeResult.Diagnostics.Count(item => item.Code == "twin.script.forbidden"));
    }

    [Fact]
    public void Inspect_StripsTransientEditorUrls_ButStillRejectsRuntimeUrls()
    {
        using var document = JsonDocument.Parse("""
        {
          "name": "编辑器快照清理",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [], "objects": [], "bindings": [],
          "routes": [{ "routeId": "main", "defaultSpeed": 1, "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }] }],
          "editorExtension": {
            "source": "threejs-editor", "payloadVersion": 2,
            "threeEditor": { "sceneParams": { "preview": "data:image/png;base64,AAA", "environment": "https://example.test/env.hdr", "nested": ["blob:test", "safe"] }, "modelParams": [] }
          }
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.True(result.Valid, string.Join("; ", result.Diagnostics.Select(item => item.Message)));
        Assert.Equal(3, result.Diagnostics.Count(item => item.Code == "twin.editor-url.stripped"));
        Assert.DoesNotContain("data:", result.NormalizedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("blob:", result.NormalizedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", result.NormalizedPayload, StringComparison.OrdinalIgnoreCase);

        using var unsafeRuntimeDocument = JsonDocument.Parse("""
        {
          "name": "运行时外链仍禁止",
          "world": { "unit": "meter", "upAxis": "Y", "background": "blob:unsafe" },
          "resources": [], "objects": [], "bindings": [],
          "routes": [{ "routeId": "main", "defaultSpeed": 1, "points": [{ "position": [0,0,0] }, { "position": [1,0,0] }] }]
        }
        """);
        var unsafeResult = TwinManifestInspector.Inspect(unsafeRuntimeDocument.RootElement, Guid.NewGuid(), Guid.NewGuid());
        Assert.Contains(unsafeResult.Diagnostics, item => item.Code == "twin.external-url.forbidden" && item.Path == "$.world.background");
    }

    [Fact]
    public void Inspect_AcceptsIntersectionGraphAndPersistsBranchDecision()
    {
        using var document = JsonDocument.Parse("""
        {
          "name": "交叉口场景",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [], "objects": [], "bindings": [],
          "routes": [{
            "routeId": "sorter", "name": "分拣路线", "type": "conveyor", "defaultSpeed": 1,
            "startPointId": "entry",
            "points": [
              { "pointId": "entry", "name": "入口", "kind": "station", "position": [0,0,0] },
              { "pointId": "junction", "name": "交叉口", "kind": "junction", "position": [1,0,0] },
              { "pointId": "out-a", "name": "出口 A", "kind": "station", "position": [2,0,1] },
              { "pointId": "out-b", "name": "出口 B", "kind": "station", "position": [2,0,-1] }
            ],
            "edges": [
              { "edgeId": "in", "fromPointId": "entry", "toPointId": "junction", "bidirectional": false, "enabled": true },
              { "edgeId": "out-a", "fromPointId": "junction", "toPointId": "out-a", "bidirectional": false, "enabled": true },
              { "edgeId": "out-b", "fromPointId": "junction", "toPointId": "out-b", "bidirectional": false, "enabled": true }
            ],
            "junctionDecisions": { "junction": "out-b" }
          }]
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.True(result.Valid, string.Join("; ", result.Diagnostics.Select(item => item.Message)));
        Assert.Single(result.Routes);
        using var graph = JsonDocument.Parse(result.Routes[0].GraphPayload);
        Assert.Equal("out-b", graph.RootElement.GetProperty("junctionDecisions").GetProperty("junction").GetString());
    }

    [Fact]
    public void Inspect_RejectsDanglingIntersectionEdgeAndDecision()
    {
        using var document = JsonDocument.Parse("""
        {
          "name": "错误路线图",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [], "objects": [], "bindings": [],
          "routes": [{
            "routeId": "broken", "name": "错误路线", "type": "conveyor", "defaultSpeed": 1,
            "points": [
              { "pointId": "p1", "name": "入口", "position": [0,0,0] },
              { "pointId": "p2", "name": "出口", "position": [1,0,0] }
            ],
            "edges": [{ "edgeId": "e1", "fromPointId": "p1", "toPointId": "missing", "bidirectional": false, "enabled": true }],
            "junctionDecisions": { "p1": "missing-edge" }
          }]
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.False(result.Valid);
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.edge.reference.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.junction.decision.invalid");
    }

    [Fact]
    public void Inspect_AcceptsPackagingDiverterMergerCapacityAndAutomaticRules()
    {
        var deviceId = Guid.NewGuid();
        using var document = JsonDocument.Parse($$"""
        {
          "name": "包装多路线输送",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [],
          "objects": [{
            "objectId": "sorter", "name": "分流器", "kind": "procedural",
            "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] }
          }],
          "bindings": [{
            "bindingId": "line-blocked", "objectId": "sorter",
            "source": { "kind": "telemetry", "deviceId": "{{deviceId:D}}", "key": "branchBlocked" },
            "target": { "kind": "customProperty", "property": "routeSignal" },
            "transform": { "kind": "routeEvent" }
          }],
          "routes": [{
            "routeId": "packaging", "name": "包装线", "type": "conveyor", "defaultSpeed": 1,
            "routingMode": "automatic", "startPointId": "entry",
            "points": [
              { "pointId": "entry", "name": "入口", "kind": "station", "position": [0,0,0] },
              { "pointId": "split", "name": "分流器", "kind": "diverter", "position": [1,0,0], "actuatorBindingId": "line-blocked" },
              { "pointId": "a", "name": "A 线", "kind": "processStation", "position": [2,0,1] },
              { "pointId": "b", "name": "B 线", "kind": "processStation", "position": [2,0,-1] },
              { "pointId": "merge", "name": "汇流器", "kind": "merger", "position": [3,0,0] },
              { "pointId": "exit", "name": "出口", "kind": "station", "position": [4,0,0] }
            ],
            "edges": [
              { "edgeId": "in", "fromPointId": "entry", "toPointId": "split", "bidirectional": false, "enabled": true, "capacity": 2 },
              { "edgeId": "out-a", "fromPointId": "split", "toPointId": "a", "bidirectional": false, "enabled": true, "capacity": 3 },
              { "edgeId": "out-b", "fromPointId": "split", "toPointId": "b", "bidirectional": false, "enabled": true, "capacity": 3, "blockedBindingId": "line-blocked", "conveyorObjectId": "sorter" },
              { "edgeId": "a-merge", "fromPointId": "a", "toPointId": "merge", "bidirectional": false, "enabled": true, "capacity": 2 },
              { "edgeId": "b-merge", "fromPointId": "b", "toPointId": "merge", "bidirectional": false, "enabled": true, "capacity": 2 },
              { "edgeId": "exit", "fromPointId": "merge", "toPointId": "exit", "bidirectional": false, "enabled": true, "capacity": 4 }
            ],
            "junctionDecisions": { "split": "out-a" },
            "decisionRules": [{
              "ruleId": "sku-b", "name": "SKU-B 走 B 线", "junctionPointId": "split", "edgeId": "out-b",
              "source": "payload", "payloadKey": "sku", "operator": "equals", "matchValue": "B", "priority": 100, "enabled": true
            }]
          }]
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.True(result.Valid, string.Join("; ", result.Diagnostics.Select(item => item.Message)));
        Assert.Contains(result.Bindings, item => item.BindingKey == "line-blocked" && item.TransformKind == "routeEvent");
        using var graph = JsonDocument.Parse(result.Routes.Single().GraphPayload);
        Assert.Equal("automatic", graph.RootElement.GetProperty("routingMode").GetString());
        Assert.Equal(3, graph.RootElement.GetProperty("edges")[1].GetProperty("capacity").GetInt32());
        Assert.Equal("sku-b", graph.RootElement.GetProperty("decisionRules")[0].GetProperty("ruleId").GetString());
    }

    [Fact]
    public void Inspect_RejectsInvalidPackagingCapacityAndAutomaticRuleReferences()
    {
        using var document = JsonDocument.Parse("""
        {
          "name": "错误包装路线",
          "world": { "unit": "meter", "upAxis": "Y", "background": "#07111f" },
          "resources": [], "objects": [], "bindings": [],
          "routes": [{
            "routeId": "broken-packaging", "name": "错误包装线", "type": "conveyor", "defaultSpeed": 1,
            "routingMode": "automatic",
            "points": [
              { "pointId": "entry", "name": "入口", "kind": "station", "position": [0,0,0] },
              { "pointId": "split", "name": "分流器", "kind": "diverter", "position": [1,0,0] },
              { "pointId": "exit", "name": "出口", "kind": "station", "position": [2,0,0] }
            ],
            "edges": [
              { "edgeId": "in", "fromPointId": "entry", "toPointId": "split", "bidirectional": false, "enabled": true, "capacity": 0 },
              { "edgeId": "out", "fromPointId": "split", "toPointId": "exit", "bidirectional": false, "enabled": true, "capacity": 1, "occupancyBindingId": "missing-binding" }
            ],
            "decisionRules": [{
              "ruleId": "bad", "junctionPointId": "split", "edgeId": "missing-edge",
              "source": "binding", "bindingId": "missing-binding", "operator": "unknown"
            }]
          }]
        }
        """);

        var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), Guid.NewGuid());

        Assert.False(result.Valid);
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.edge.capacity.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.edge.binding.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.rule.reference.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.rule.binding.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.rule.operator.invalid");
        Assert.Contains(result.Diagnostics, item => item.Code == "twin.route.diverter.outgoing.invalid");
    }
}
