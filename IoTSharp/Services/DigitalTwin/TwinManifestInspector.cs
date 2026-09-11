#nullable enable
using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// 解析并规范化数字孪生场景清单，同时提取需要入库的对象绑定和路线。
/// </summary>
internal static class TwinManifestInspector
{
    private static readonly JsonSerializerOptions WebJsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> AllowedTransforms = new(StringComparer.OrdinalIgnoreCase)
    {
        "identity", "booleanVisibility", "booleanColor", "rangeColor", "numberScale",
        "numberRotation", "enumMap", "formatText", "alarmSeverityStyle",
        "booleanAnimation", "routeProgress", "routeDistance", "routeEvent", "routeSlotArray"
    };
    private static readonly HashSet<string> AllowedRoutePointKinds = new(StringComparer.OrdinalIgnoreCase)
    {
        "waypoint", "junction", "station", "diverter", "merger", "buffer", "processStation", "sensor"
    };
    private static readonly HashSet<string> AllowedRouteRuleOperators = new(StringComparer.OrdinalIgnoreCase)
    {
        "equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "contains", "truthy", "falsy"
    };
    private static readonly HashSet<string> AllowedProcessTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "robot-loading", "external-inspection", "bagging", "gantry-stacking", "scan",
        "wood-stack-ready", "top-cover", "wrapping", "labeling"
    };
    private static readonly HashSet<string> AllowedBehaviorActionKinds = new(StringComparer.OrdinalIgnoreCase)
    {
        "moveTo", "movePose", "jointMove", "axisMove", "pick", "place", "gripOpen", "gripClose",
        "waitSignal", "wait", "prepareSlot", "home", "attach", "detach"
    };
    private static readonly HashSet<string> AllowedMaterialSlotRoles = new(StringComparer.OrdinalIgnoreCase)
    {
        "source", "target", "buffer", "stack", "fixture"
    };
    private static readonly HashSet<string> AllowedActuatorKinds = new(StringComparer.OrdinalIgnoreCase)
    {
        "rotary-joint", "linear-axis", "gripper"
    };
    private static readonly HashSet<string> AllowedActuatorUnits = new(StringComparer.OrdinalIgnoreCase)
    {
        "rad", "degree", "meter", "boolean"
    };
    private static readonly HashSet<string> AllowedInterlockOperators = new(StringComparer.OrdinalIgnoreCase)
    {
        "equals", "notEquals", "truthy", "falsy"
    };
    private static readonly HashSet<string> AllowedConveyorSizeClasses = new(StringComparer.OrdinalIgnoreCase) { "small", "large" };
    private static readonly HashSet<string> AllowedTransportUnitTypes = new(StringComparer.OrdinalIgnoreCase) { "plastic-pallet", "wooden-pallet", "carton" };
    private static readonly HashSet<string> ForbiddenExecutablePropertyNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "script", "scripts", "function", "functions", "javascript"
    };

    /// <summary>
    /// 将客户端草稿固定到服务端场景 ID 和根 Asset，并执行无脚本合同检查。
    /// </summary>
    public static TwinManifestInspection Inspect(JsonElement payload, Guid sceneId, Guid rootAssetId)
    {
        var result = new TwinManifestInspection();
        JsonObject root;
        try
        {
            root = JsonNode.Parse(payload.GetRawText()) as JsonObject
                ?? throw new JsonException("场景清单根节点必须是对象");
        }
        catch (JsonException exception)
        {
            result.Diagnostics.Add(Error("twin.manifest.json.invalid", exception.Message));
            return result;
        }

        root["schemaVersion"] = DigitalTwinContractVersions.SceneV1;
        root["sceneId"] = sceneId.ToString("D");
        root["rootAssetId"] = rootAssetId.ToString("D");
        root["resources"] ??= new JsonArray();
        root["objects"] ??= new JsonArray();
        root["connections"] ??= new JsonArray();
        root["bindings"] ??= new JsonArray();
        root["routes"] ??= new JsonArray();
        root["workPoints"] ??= new JsonArray();
        root["materialSlots"] ??= new JsonArray();
        root["toolFrames"] ??= new JsonArray();
        root["actuators"] ??= new JsonArray();
        root["poses"] ??= new JsonArray();
        root["behaviors"] ??= new JsonArray();
        root["interlocks"] ??= new JsonArray();
        root["actionFlows"] ??= new JsonArray();
        root["runtime"] ??= new JsonObject
        {
            ["dataMode"] = "simulation",
            ["maxPixelRatio"] = 2,
            ["showGrid"] = true
        };

        // threejs-editor may serialize preview textures, editor callbacks and animation
        // helpers into its editor-only snapshot. They are not runtime resources and must
        // never enter the immutable Manifest. Strip them server-side so stale clients can
        // still save, while the general validator continues to reject them elsewhere.
        SanitizeThreeEditorSnapshot(root, result);

        result.NormalizedPayload = root.ToJsonString(WebJsonOptions);
        using var document = JsonDocument.Parse(result.NormalizedPayload);
        var manifest = document.RootElement;

        ValidateTopLevel(manifest, result);
        ValidateSilkLineSimulation(manifest, result);
        ValidateUntrustedValues(manifest, "$", result.Diagnostics);
        InspectResources(manifest, result);
        var objectIds = InspectObjects(manifest, rootAssetId, result);
        InspectConnections(manifest, objectIds, result);
        InspectBindings(manifest, objectIds, result);
        ValidateComponentBindingReferences(result);
        InspectActionOrchestration(manifest, objectIds, result);
        InspectRoutes(manifest, objectIds, result);
        var actionFlowInspection = TwinActionFlowServerCompiler.Inspect(manifest);
        result.Diagnostics.AddRange(actionFlowInspection.Diagnostics);
        result.ActionFlows.AddRange(actionFlowInspection.ActionFlows);
        return result;
    }

    private static void ValidateTopLevel(JsonElement manifest, TwinManifestInspection result)
    {
        if (!TryGetNonEmptyString(manifest, "name", out _))
        {
            result.Diagnostics.Add(Error("twin.scene.name.required", "场景名称不能为空。", "name"));
        }

        if (!manifest.TryGetProperty("world", out var world) || world.ValueKind != JsonValueKind.Object)
        {
            result.Diagnostics.Add(Error("twin.scene.world.required", "场景 world 配置不能为空。", "world"));
        }
        else
        {
            if (!TryGetNonEmptyString(world, "unit", out var unit) || unit != "meter")
            {
                result.Diagnostics.Add(Error("twin.scene.unit.invalid", "场景坐标单位必须是 meter。", "world.unit"));
            }

            if (!TryGetNonEmptyString(world, "upAxis", out var upAxis) || upAxis != "Y")
            {
                result.Diagnostics.Add(Error("twin.scene.axis.invalid", "场景上轴必须是 Y。", "world.upAxis"));
            }
        }
    }

    private static void ValidateSilkLineSimulation(JsonElement manifest, TwinManifestInspection result)
    {
        if (!manifest.TryGetProperty("runtime", out var runtime) || runtime.ValueKind != JsonValueKind.Object ||
            !runtime.TryGetProperty("silkLineSimulation", out var simulation)) return;
        if (simulation.ValueKind != JsonValueKind.Object)
        {
            result.Diagnostics.Add(Error("twin.silk-line.simulation.invalid", "silkLineSimulation 必须是对象。", "runtime.silkLineSimulation"));
            return;
        }

		foreach (var (name, minimum, maximum) in new[]
        {
            ("palletCount", 1, 200), ("silkCakesPerCart", 1, 100),
            ("stackRows", 1, 10), ("stackColumns", 1, 10), ("stackLayers", 1, 20)
        })
        {
            if (!simulation.TryGetProperty(name, out var value) || !value.TryGetInt32(out var parsed) || parsed < minimum || parsed > maximum)
            {
                result.Diagnostics.Add(Error("twin.silk-line.simulation.range.invalid", $"{name} 必须是 {minimum} 到 {maximum} 的整数。", $"runtime.silkLineSimulation.{name}"));
            }
        }

        foreach (var (name, minimum, maximum) in new[]
        {
            ("cartChangeDelaySeconds", 0.0, 300.0), ("robotCycleSeconds", 0.2, 120.0),
            ("gantryCycleSeconds", 0.2, 120.0), ("palletReleaseIntervalSeconds", 0.0, 60.0),
            ("inspectionCycleSeconds", 0.2, 120.0), ("inspectionNgRate", 0.0, 1.0),
            ("baggingCycleSeconds", 0.2, 120.0),
            ("coverCycleSeconds", 0.2, 120.0), ("labelCycleSeconds", 0.2, 120.0),
            ("wrappingCycleSeconds", 0.2, 300.0), ("warehouseInboundCycleSeconds", 0.2, 300.0),
            ("emptyWoodPalletFeedSeconds", 0.0, 300.0)
		})
		{
			var optionalV4 = name is "coverCycleSeconds" or "labelCycleSeconds" or "wrappingCycleSeconds" or "warehouseInboundCycleSeconds" or "emptyWoodPalletFeedSeconds" or "inspectionCycleSeconds" or "inspectionNgRate" or "baggingCycleSeconds";
			if (!simulation.TryGetProperty(name, out var value))
			{
				if (optionalV4) continue;
				result.Diagnostics.Add(Error("twin.silk-line.simulation.range.invalid", $"{name} 必须在 {minimum} 到 {maximum} 之间。", $"runtime.silkLineSimulation.{name}"));
				continue;
			}
			if (!value.TryGetDouble(out var parsed) || parsed < minimum || parsed > maximum)
			{
                result.Diagnostics.Add(Error("twin.silk-line.simulation.range.invalid", $"{name} 必须在 {minimum} 到 {maximum} 之间。", $"runtime.silkLineSimulation.{name}"));
			}
		}

		var isV4 = manifest.TryGetProperty("objects", out var objects) && objects.ValueKind == JsonValueKind.Array &&
			objects.EnumerateArray().Any(item => item.TryGetProperty("procedural", out var procedural) &&
				procedural.ValueKind == JsonValueKind.Object && procedural.TryGetProperty("preset", out var preset) &&
				preset.GetString() == "silk-cake-packaging-line");
		if (isV4)
		{
			var fixedValues = new[] { ("palletCount", 80), ("silkCakesPerCart", 36), ("stackRows", 2), ("stackColumns", 3), ("stackLayers", 8) };
			if (fixedValues.Any(entry => !simulation.TryGetProperty(entry.Item1, out var value) || !value.TryGetInt32(out var parsed) || parsed != entry.Item2))
			{
				result.Diagnostics.Add(Error("twin.silk-line.v6.fixed-process.invalid", "V6 固定工艺必须为 80 个在线闭环塑料托盘、双面丝车 36 件、木托盘 2×3×8 共 48 件。", "runtime.silkLineSimulation"));
			}
			if (!simulation.TryGetProperty("palletPopulationMode", out var populationMode) || populationMode.GetString() != "closed-loop")
			{
				result.Diagnostics.Add(Error("twin.silk-line.v6.population.invalid", "V6 丝饼线 palletPopulationMode 必须为 closed-loop。", "runtime.silkLineSimulation.palletPopulationMode"));
			}
		}
	}

    private static void InspectResources(JsonElement manifest, TwinManifestInspection result)
    {
        if (!manifest.TryGetProperty("resources", out var resources) || resources.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.resources.invalid", "resources 必须是数组。", "resources"));
            return;
        }

        var resourceIds = new HashSet<Guid>();
        var index = 0;
        foreach (var resource in resources.EnumerateArray())
        {
            var path = $"resources[{index}]";
            if (!TryGetGuid(resource, "resourceId", out var resourceId))
            {
                result.Diagnostics.Add(Error("twin.resource.id.invalid", "后端场景只能引用已经上传的模型资源 ID。", $"{path}.resourceId"));
            }
            else if (!resourceIds.Add(resourceId))
            {
                result.Diagnostics.Add(Error("twin.resource.id.duplicate", "模型资源 ID 不能重复。", $"{path}.resourceId"));
            }

            if (TryGetNonEmptyString(resource, "status", out var status) && status.Equals("local-poc", StringComparison.OrdinalIgnoreCase))
            {
                result.Diagnostics.Add(Error("twin.resource.local", "本地模型必须先上传到模型资源中心才能保存到服务器。", path));
            }

            index += 1;
        }

        result.ResourceIds.AddRange(resourceIds);
    }

    private static HashSet<string> InspectObjects(JsonElement manifest, Guid rootAssetId, TwinManifestInspection result)
    {
        var objectIds = new HashSet<string>(StringComparer.Ordinal);
        var objectKinds = new Dictionary<string, string>(StringComparer.Ordinal);
        var supportedObjectKinds = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "procedural", "model", "equipment", "component", "visual"
        };
        var equipmentReferences = new List<(string Path, string ParentObjectId, string EquipmentType)>();
        var supportedEquipmentTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "loading-robot", "silk-cart-turntable", "gantry-stacker", "cover-applicator",
            "labeler", "wrapper", "inbound-lift"
        };
        if (!manifest.TryGetProperty("objects", out var objects) || objects.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.objects.invalid", "objects 必须是数组。", "objects"));
            return objectIds;
        }

        var index = 0;
        foreach (var sceneObject in objects.EnumerateArray())
        {
            var path = $"objects[{index}]";
            if (!TryGetNonEmptyString(sceneObject, "objectId", out var objectId) || !objectIds.Add(objectId))
            {
                result.Diagnostics.Add(Error("twin.object.id.invalid", "objectId 不能为空且必须唯一。", $"{path}.objectId"));
                index += 1;
                continue;
            }

            var resourceId = TryGetGuid(sceneObject, "resourceId", out var parsedResourceId) ? parsedResourceId : (Guid?)null;
            var assetId = TryGetGuid(sceneObject, "assetId", out var parsedAssetId) ? parsedAssetId : rootAssetId;
            var hasKind = TryGetNonEmptyString(sceneObject, "kind", out var kind);
            objectKinds[objectId] = hasKind ? kind : string.Empty;
            if (!hasKind || !supportedObjectKinds.Contains(kind))
            {
                result.Diagnostics.Add(Error("twin.object.kind.invalid", "对象 kind 必须是 procedural、model、equipment、component 或 visual。", $"{path}.kind"));
            }
            var requiresDatabaseResource = hasKind && (kind.Equals("model", StringComparison.OrdinalIgnoreCase) || kind.Equals("component", StringComparison.OrdinalIgnoreCase));
            if (requiresDatabaseResource && resourceId == null)
            {
                result.Diagnostics.Add(Error("twin.object.resource.required", "模型或参数化组件必须引用已入库的 resourceId。", $"{path}.resourceId"));
            }
            else if (resourceId.HasValue && !result.ResourceIds.Contains(resourceId.Value))
            {
                result.Diagnostics.Add(Error("twin.object.resource.unlisted", "对象引用的模型必须同时出现在 resources 列表中。", $"{path}.resourceId"));
            }

            if (kind?.Equals("component", StringComparison.OrdinalIgnoreCase) == true)
            {
                InspectComponentObject(sceneObject, objectId, resourceId, path, result);
            }

            if (kind?.Equals("equipment", StringComparison.OrdinalIgnoreCase) == true)
            {
                if (!sceneObject.TryGetProperty("equipment", out var equipment) || equipment.ValueKind != JsonValueKind.Object)
                {
                    result.Diagnostics.Add(Error("twin.equipment.definition.required", "整机对象必须包含 equipment 定义。", $"{path}.equipment"));
                }
                else
                {
                    var equipmentType = GetString(equipment, "equipmentType");
                    var parentObjectId = GetString(equipment, "parentObjectId");
                    if (string.IsNullOrWhiteSpace(equipmentType) || !supportedEquipmentTypes.Contains(equipmentType))
                        result.Diagnostics.Add(Error("twin.equipment.type.invalid", "整机对象类型不受支持。", $"{path}.equipment.equipmentType"));
                    if (string.IsNullOrWhiteSpace(parentObjectId))
                        result.Diagnostics.Add(Error("twin.equipment.parent.required", "整机对象必须引用所属程序化产线。", $"{path}.equipment.parentObjectId"));
                    else if (!string.IsNullOrWhiteSpace(equipmentType))
                        equipmentReferences.Add((path, parentObjectId, equipmentType));
                }
            }

            if (kind?.Equals("procedural", StringComparison.OrdinalIgnoreCase) == true &&
                sceneObject.TryGetProperty("procedural", out var procedural) &&
                procedural.ValueKind == JsonValueKind.Object)
            {
                var preset = GetString(procedural, "preset");
                if (preset is not ("basic-conveyor" or "packaging-line" or "silk-cake-line" or "silk-cake-packaging-line"))
                {
                    result.Diagnostics.Add(Error("twin.object.procedural.preset.invalid", "程序化对象预设不受支持。", $"{path}.procedural.preset"));
                }
                else if (preset is "packaging-line" or "silk-cake-line" or "silk-cake-packaging-line")
                {
                    var palletCount = GetInt(procedural, "palletCount", 0);
                    if (palletCount is < 1 or > 200)
                    {
                        result.Diagnostics.Add(Error("twin.object.procedural.pallet-count.invalid", "包装线托盘数量必须是 1 到 200 的整数。", $"{path}.procedural.palletCount"));
                    }
                }
            }

            ValidateTransform(sceneObject, path, result.Diagnostics);
            result.Bindings.Add(new TwinBindingDraft
            {
                BindingKey = $"resource:{objectId}",
                ObjectId = objectId,
                ModelResourceId = resourceId,
                AssetId = assetId,
                SourceKind = TwinBindingSourceKind.Resource,
                TargetKind = TwinBindingTargetKind.Object,
                TransformKind = "identity",
                TransformConfig = "{}",
                Enabled = true,
                StaleAfterMs = 0
            });
            index += 1;
        }

        var equipmentSlots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var reference in equipmentReferences)
        {
            if (!objectKinds.TryGetValue(reference.ParentObjectId, out var parentKind))
            {
                result.Diagnostics.Add(Error("twin.equipment.parent.invalid", "整机对象引用的父产线不存在。", $"{reference.Path}.equipment.parentObjectId"));
            }
            else if (!parentKind.Equals("procedural", StringComparison.OrdinalIgnoreCase))
            {
                result.Diagnostics.Add(Error("twin.equipment.parent-kind.invalid", "整机对象的父对象必须是程序化产线。", $"{reference.Path}.equipment.parentObjectId"));
            }

            if (!equipmentSlots.Add($"{reference.ParentObjectId}\n{reference.EquipmentType}"))
            {
                result.Diagnostics.Add(Error("twin.equipment.duplicate", "同一程序化产线不能重复映射同一种整机设备。", $"{reference.Path}.equipment.equipmentType"));
            }
        }

        return objectIds;
    }

    /// <summary>
    /// 校验 V7 参数化组件的版本快照和不可缩放约束，并记录后续数据库资源一致性检查所需字段。
    /// </summary>
    private static void InspectComponentObject(
        JsonElement sceneObject,
        string objectId,
        Guid? resourceId,
        string path,
        TwinManifestInspection result)
    {
        if (!sceneObject.TryGetProperty("component", out var component) || component.ValueKind != JsonValueKind.Object)
        {
            result.Diagnostics.Add(Error("twin.component.definition.required", "参数化组件必须包含 component 定义。", $"{path}.component"));
            return;
        }

        var resourceKey = GetString(component, "resourceKey");
        var componentType = GetString(component, "componentType");
        var generator = GetString(component, "generator");
        var generatorVersion = GetInt(component, "generatorVersion", 0);
        if (string.IsNullOrWhiteSpace(resourceKey))
            result.Diagnostics.Add(Error("twin.component.resource-key.required", "组件 resourceKey 不能为空。", $"{path}.component.resourceKey"));
        if (string.IsNullOrWhiteSpace(componentType))
            result.Diagnostics.Add(Error("twin.component.type.required", "组件 componentType 不能为空。", $"{path}.component.componentType"));
        if (string.IsNullOrWhiteSpace(generator))
            result.Diagnostics.Add(Error("twin.component.generator.required", "组件 generator 不能为空。", $"{path}.component.generator"));
        if (generatorVersion <= 0)
            result.Diagnostics.Add(Error("twin.component.generator-version.invalid", "组件 generatorVersion 必须是正整数。", $"{path}.component.generatorVersion"));
        var instancePorts = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!component.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object)
            result.Diagnostics.Add(Error("twin.component.properties.invalid", "组件 properties 必须是对象。", $"{path}.component.properties"));
        else if (string.Equals(generator, "double-small-roller-conveyor-v1", StringComparison.Ordinal) &&
                 properties.TryGetProperty("routeTaps", out var routeTaps) && routeTaps.ValueKind == JsonValueKind.Array)
        {
            // 双排小辊道的中间接驳口由实例 routeTaps 参数生成，不可能穷举在数据库模板端口中。
            // 只登记生成器确实会创建的 A/B 排动态端口，连接校验仍拒绝任意伪造端口。
            foreach (var routeTap in routeTaps.EnumerateArray())
            {
                var lane = GetString(routeTap, "lane")?.Trim().ToLowerInvariant();
                var tapId = GetString(routeTap, "tapId")?.Trim();
                if (lane is not ("a" or "b") || string.IsNullOrWhiteSpace(tapId)) continue;
                instancePorts.TryAdd($"{lane}-{tapId}", "material-bidirectional");
            }
        }

        var componentBindings = new Dictionary<string, string>(StringComparer.Ordinal);
        if (component.TryGetProperty("bindings", out var bindings))
        {
            if (bindings.ValueKind != JsonValueKind.Object)
            {
                result.Diagnostics.Add(Error("twin.component.bindings.invalid", "组件 bindings 必须是 SlotId 到 BindingId 的对象。", $"{path}.component.bindings"));
            }
            else
            {
                foreach (var binding in bindings.EnumerateObject())
                {
                    if (string.IsNullOrWhiteSpace(binding.Name) || binding.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(binding.Value.GetString()))
                    {
                        result.Diagnostics.Add(Error("twin.component.binding.invalid", "组件 Binding Slot 必须引用非空 BindingId。", $"{path}.component.bindings.{binding.Name}"));
                        continue;
                    }
                    componentBindings[binding.Name] = binding.Value.GetString()!.Trim();
                }
            }
        }

        if (sceneObject.TryGetProperty("transform", out var transform) && transform.ValueKind == JsonValueKind.Object &&
            transform.TryGetProperty("scale", out var scale) && IsFiniteVector(scale) &&
            scale.EnumerateArray().Any(value => Math.Abs(value.GetDouble() - 1d) > 0.000001d))
        {
            result.Diagnostics.Add(Error("twin.component.scale.locked", "参数化组件 Scale 必须保持 1,1,1；实际尺寸只能通过 properties 修改。", $"{path}.transform.scale"));
        }

        if (resourceId.HasValue && !string.IsNullOrWhiteSpace(resourceKey) && !string.IsNullOrWhiteSpace(componentType) &&
            !string.IsNullOrWhiteSpace(generator) && generatorVersion > 0)
        {
            result.Components.Add(new TwinComponentReferenceDraft
            {
                ObjectId = objectId,
                ResourceId = resourceId.Value,
                ResourceKey = resourceKey,
                ComponentType = componentType,
                Generator = generator,
                GeneratorVersion = generatorVersion,
                Bindings = componentBindings,
                InstancePorts = instancePorts,
                Path = path
            });
        }
    }

    private static void ValidateComponentBindingReferences(TwinManifestInspection result)
    {
        var routeEventBindings = result.Bindings
            .Where(binding => binding.SourceKind != TwinBindingSourceKind.Resource && binding.TransformKind.Equals("routeEvent", StringComparison.OrdinalIgnoreCase))
            .Select(binding => binding.BindingKey)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var component in result.Components)
        {
            foreach (var (slotId, bindingId) in component.Bindings)
            {
                if (!routeEventBindings.Contains(bindingId))
                {
                    result.Diagnostics.Add(Error("twin.component.binding.reference.invalid", $"组件 {component.ObjectId} 的 Slot {slotId} 必须引用已存在的 routeEvent Binding。", $"{component.Path}.component.bindings.{slotId}"));
                }
            }
        }
    }

    private static void InspectConnections(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)
    {
        if (!manifest.TryGetProperty("connections", out var connections) || connections.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.connections.invalid", "connections 必须是数组。", "connections"));
            return;
        }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var occupiedPorts = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var connection in connections.EnumerateArray())
        {
            var path = $"connections[{index}]";
            var validConnectionId = TryGetNonEmptyString(connection, "connectionId", out var id) && ids.Add(id);
            if (!validConnectionId)
                result.Diagnostics.Add(Error("twin.connection.id.invalid", "connectionId 不能为空且必须唯一。", $"{path}.connectionId"));
            string? fromObjectId = null;
            string? fromPortId = null;
            string? toObjectId = null;
            string? toPortId = null;
            foreach (var endpointName in new[] { "from", "to" })
            {
                if (!connection.TryGetProperty(endpointName, out var endpoint) || endpoint.ValueKind != JsonValueKind.Object ||
                    !TryGetNonEmptyString(endpoint, "objectId", out var objectId) || !objectIds.Contains(objectId) ||
                    !TryGetNonEmptyString(endpoint, "portId", out var portId))
                {
                    result.Diagnostics.Add(Error("twin.connection.endpoint.invalid", "Connection 端点必须引用已存在对象和非空 portId。", $"{path}.{endpointName}"));
                    continue;
                }
                if (!occupiedPorts.Add($"{objectId}::{portId}"))
                    result.Diagnostics.Add(Error("twin.connection.port.duplicate", "同一个物理端口不能同时连接多个端点。", $"{path}.{endpointName}"));
                if (endpointName == "from")
                {
                    fromObjectId = objectId;
                    fromPortId = portId;
                }
                else
                {
                    toObjectId = objectId;
                    toPortId = portId;
                }
            }
            if (validConnectionId && fromObjectId != null && fromPortId != null && toObjectId != null && toPortId != null)
            {
                result.Connections.Add(new TwinConnectionReferenceDraft
                {
                    ConnectionId = id,
                    FromObjectId = fromObjectId,
                    FromPortId = fromPortId,
                    ToObjectId = toObjectId,
                    ToPortId = toPortId,
                    Path = path
                });
            }
            index += 1;
        }
    }

    private static void InspectBindings(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)
    {
        if (!manifest.TryGetProperty("bindings", out var bindings) || bindings.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.bindings.invalid", "bindings 必须是数组。", "bindings"));
            return;
        }

        var bindingKeys = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var binding in bindings.EnumerateArray())
        {
            var path = $"bindings[{index}]";
            if (!TryGetNonEmptyString(binding, "bindingId", out var bindingKey) || !bindingKeys.Add(bindingKey))
            {
                result.Diagnostics.Add(Error("twin.binding.id.invalid", "bindingId 不能为空且必须唯一。", $"{path}.bindingId"));
                index += 1;
                continue;
            }

            if (!TryGetNonEmptyString(binding, "objectId", out var objectId) || !objectIds.Contains(objectId))
            {
                result.Diagnostics.Add(Error("twin.binding.object.missing", "绑定引用的 objectId 不存在。", $"{path}.objectId"));
                index += 1;
                continue;
            }

            if (!binding.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.Object ||
                !TryGetNonEmptyString(source, "kind", out var sourceKindText) ||
                !TryParseSourceKind(sourceKindText, out var sourceKind) || sourceKind == TwinBindingSourceKind.Resource)
            {
                result.Diagnostics.Add(Error("twin.binding.source.invalid", "绑定数据源类型不受支持。", $"{path}.source.kind"));
                index += 1;
                continue;
            }

            if (!binding.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.Object ||
                !TryGetNonEmptyString(target, "kind", out var targetKindText) ||
                !TryParseTargetKind(targetKindText, out var targetKind) || targetKind == TwinBindingTargetKind.Object)
            {
                result.Diagnostics.Add(Error("twin.binding.target.invalid", "绑定目标类型不受支持。", $"{path}.target.kind"));
                index += 1;
                continue;
            }

            var transformKind = "identity";
            var transformConfig = "{}";
            if (binding.TryGetProperty("transform", out var transform) && transform.ValueKind == JsonValueKind.Object)
            {
                if (TryGetNonEmptyString(transform, "kind", out var parsedTransformKind)) transformKind = parsedTransformKind;
                transformConfig = transform.GetRawText();
            }
            if (!AllowedTransforms.Contains(transformKind))
            {
                result.Diagnostics.Add(Error("twin.binding.transform.invalid", $"转换器 {transformKind} 不在白名单中。", $"{path}.transform.kind"));
                index += 1;
                continue;
            }

            var deviceId = TryGetGuid(source, "deviceId", out var parsedDeviceId) ? parsedDeviceId : (Guid?)null;
            if (sourceKind is TwinBindingSourceKind.Telemetry or TwinBindingSourceKind.Attribute or TwinBindingSourceKind.Connectivity or TwinBindingSourceKind.CommandFeedback && deviceId == null)
            {
                result.Diagnostics.Add(Error("twin.binding.device.required", "设备运行数据绑定必须指定 deviceId。", $"{path}.source.deviceId"));
            }

            result.Bindings.Add(new TwinBindingDraft
            {
                BindingKey = bindingKey,
                ObjectId = objectId,
                NodePath = GetString(binding, "nodePath"),
                AssetId = TryGetGuid(source, "assetId", out var assetId) ? assetId : (Guid?)null,
                DeviceId = deviceId,
                SemanticId = GetString(source, "semanticId"),
                SourceKind = sourceKind,
                SourceKey = GetString(source, "key"),
                TargetKind = targetKind,
                TargetPath = targetKind == TwinBindingTargetKind.Actuator
                    ? GetString(target, "actuatorId") ?? GetString(target, "property") ?? GetString(target, "path")
                    : GetString(target, "property") ?? GetString(target, "path"),
                TransformKind = transformKind,
                TransformConfig = transformConfig,
                Priority = GetInt(binding, "priority", 0),
                StaleAfterMs = Math.Clamp(GetInt(binding, "staleAfterMs", 10000), 100, 86_400_000),
                Enabled = GetBoolean(binding, "enabled", true)
            });
            index += 1;
        }
    }

    /// <summary>
    /// 服务端独立校验动作编排引用。客户端诊断只用于即时提示，不能作为保存和发布的安全边界。
    /// </summary>
    private static void InspectActionOrchestration(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)
    {
        var bindingIds = result.Bindings.Select(item => item.BindingKey).ToHashSet(StringComparer.Ordinal);
        var materialSlotIds = new HashSet<string>(StringComparer.Ordinal);
        var toolFrameIds = new HashSet<string>(StringComparer.Ordinal);
        var toolFrameObjectIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var workPointIds = new HashSet<string>(StringComparer.Ordinal);
        var actuatorIds = new HashSet<string>(StringComparer.Ordinal);
        var actuatorObjectIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var actuatorKinds = new Dictionary<string, string>(StringComparer.Ordinal);
        var poseIds = new HashSet<string>(StringComparer.Ordinal);
        var poseObjectIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var interlockIds = new HashSet<string>(StringComparer.Ordinal);
        var allowedWorkPointRoles = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "pick", "place", "safe", "home", "buffer", "tcp", "stack"
        };

        InspectObjectArray(manifest, "materialSlots", result, (slot, index) =>
        {
            var path = $"materialSlots[{index}]";
            if (!TryGetNonEmptyString(slot, "slotId", out var slotId) || !materialSlotIds.Add(slotId))
                result.Diagnostics.Add(Error("twin.behavior.material-slot.id.invalid", "MaterialSlot ID 不能为空且必须唯一。", $"{path}.slotId"));
            if (!TryGetNonEmptyString(slot, "objectId", out var objectId) || !objectIds.Contains(objectId))
                result.Diagnostics.Add(Error("twin.behavior.material-slot.object.invalid", "MaterialSlot 引用的场景对象不存在。", $"{path}.objectId"));
            if (!TryGetNonEmptyString(slot, "role", out var role) || !AllowedMaterialSlotRoles.Contains(role))
                result.Diagnostics.Add(Error("twin.behavior.material-slot.role.invalid", "MaterialSlot 角色不受支持。", $"{path}.role"));
            if (!slot.TryGetProperty("localPosition", out var position) || !IsFiniteVector(position))
                result.Diagnostics.Add(Error("twin.behavior.material-slot.position.invalid", "MaterialSlot 局部坐标必须是三个有限数值。", $"{path}.localPosition"));
            ValidateOptionalVector(slot, "localRotation", path, "twin.behavior.material-slot.rotation.invalid", "MaterialSlot 局部旋转必须是三个有限数值。", result);
            ValidateOptionalVector(slot, "contactNormalLocal", path, "twin.behavior.material-slot.contact-normal.invalid", "MaterialSlot 接触法向必须是三个有限数值。", result);
            if (slot.TryGetProperty("capacity", out var capacity) &&
                (!capacity.TryGetDouble(out var capacityValue) || !double.IsFinite(capacityValue) || capacityValue <= 0))
                result.Diagnostics.Add(Error("twin.behavior.material-slot.capacity.invalid", "MaterialSlot 容量必须大于 0。", $"{path}.capacity"));
        });

        InspectObjectArray(manifest, "toolFrames", result, (frame, index) =>
        {
            var path = $"toolFrames[{index}]";
            if (!TryGetNonEmptyString(frame, "toolFrameId", out var frameId) || !toolFrameIds.Add(frameId))
                result.Diagnostics.Add(Error("twin.behavior.tool-frame.id.invalid", "TCP/ToolFrame ID 不能为空且必须唯一。", $"{path}.toolFrameId"));
            if (!TryGetNonEmptyString(frame, "objectId", out var objectId) || !objectIds.Contains(objectId))
                result.Diagnostics.Add(Error("twin.behavior.tool-frame.object.invalid", "TCP/ToolFrame 引用的场景对象不存在。", $"{path}.objectId"));
            else if (!string.IsNullOrWhiteSpace(frameId)) toolFrameObjectIds[frameId] = objectId;
            if (!TryGetNonEmptyString(frame, "nodePath", out _))
                result.Diagnostics.Add(Error("twin.behavior.tool-frame.node.required", "TCP/ToolFrame 必须配置稳定节点路径。", $"{path}.nodePath"));
            ValidateOptionalVector(frame, "localPosition", path, "twin.behavior.tool-frame.position.invalid", "TCP 局部坐标必须是三个有限数值。", result);
            ValidateOptionalVector(frame, "localRotation", path, "twin.behavior.tool-frame.rotation.invalid", "TCP 局部旋转必须是三个有限数值。", result);
            ValidateOptionalVector(frame, "approachDirectionLocal", path, "twin.behavior.tool-frame.approach.invalid", "TCP 接近方向必须是三个有限数值。", result);
        });

        InspectObjectArray(manifest, "workPoints", result, (workPoint, index) =>
        {
            var path = $"workPoints[{index}]";
            if (!TryGetNonEmptyString(workPoint, "workPointId", out var workPointId) || !workPointIds.Add(workPointId))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.id.invalid", "工作点 ID 不能为空且必须唯一。", $"{path}.workPointId"));
            if (!TryGetNonEmptyString(workPoint, "objectId", out var objectId) || !objectIds.Contains(objectId))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.object.invalid", "工作点引用的场景对象不存在。", $"{path}.objectId"));
            if (!TryGetNonEmptyString(workPoint, "role", out var role) || !allowedWorkPointRoles.Contains(role))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.role.invalid", "工作点角色不受支持。", $"{path}.role"));
            if (!workPoint.TryGetProperty("localPosition", out var position) || !IsFiniteVector(position))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.position.invalid", "工作点局部坐标必须是三个有限数值。", $"{path}.localPosition"));
            ValidateOptionalVector(workPoint, "localRotation", path, "twin.behavior.workpoint.rotation.invalid", "工作点局部旋转必须是三个有限数值。", result);
            if (TryGetNonEmptyString(workPoint, "materialSlotId", out var slotId) && !materialSlotIds.Contains(slotId))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.material-slot.invalid", "工作点引用的 MaterialSlot 不存在。", $"{path}.materialSlotId"));
            if (TryGetNonEmptyString(workPoint, "toolFrameId", out var frameId) && !toolFrameIds.Contains(frameId))
                result.Diagnostics.Add(Error("twin.behavior.workpoint.tool-frame.invalid", "工作点引用的 TCP/ToolFrame 不存在。", $"{path}.toolFrameId"));
        });

        InspectObjectArray(manifest, "actuators", result, (actuator, index) =>
        {
            var path = $"actuators[{index}]";
            if (!TryGetNonEmptyString(actuator, "actuatorId", out var actuatorId) || !actuatorIds.Add(actuatorId))
                result.Diagnostics.Add(Error("twin.behavior.actuator.id.invalid", "执行机构 ID 不能为空且必须唯一。", $"{path}.actuatorId"));
            if (!TryGetNonEmptyString(actuator, "objectId", out var objectId) || !objectIds.Contains(objectId))
                result.Diagnostics.Add(Error("twin.behavior.actuator.object.invalid", "执行机构引用的场景对象不存在。", $"{path}.objectId"));
            else if (!string.IsNullOrWhiteSpace(actuatorId)) actuatorObjectIds[actuatorId] = objectId;
            if (!TryGetNonEmptyString(actuator, "nodePath", out _))
                result.Diagnostics.Add(Error("twin.behavior.actuator.node.required", "执行机构必须配置稳定节点路径。", $"{path}.nodePath"));
            if (!TryGetNonEmptyString(actuator, "kind", out var kind) || !AllowedActuatorKinds.Contains(kind))
                result.Diagnostics.Add(Error("twin.behavior.actuator.kind.invalid", "执行机构类型不受支持。", $"{path}.kind"));
            else if (!string.IsNullOrWhiteSpace(actuatorId)) actuatorKinds[actuatorId] = kind;
            if (!TryGetNonEmptyString(actuator, "unit", out var unit) || !AllowedActuatorUnits.Contains(unit))
                result.Diagnostics.Add(Error("twin.behavior.actuator.unit.invalid", "执行机构单位不受支持。", $"{path}.unit"));
            if (!kind.Equals("gripper", StringComparison.OrdinalIgnoreCase) &&
                (!TryGetNonEmptyString(actuator, "motionAxis", out var axis) || !(axis is "x" or "y" or "z")))
                result.Diagnostics.Add(Error("twin.behavior.actuator.axis.invalid", "旋转关节和直线轴必须配置 X/Y/Z 运动轴。", $"{path}.motionAxis"));
            if (actuator.TryGetProperty("speed", out var speed) &&
                (!speed.TryGetDouble(out var speedValue) || !double.IsFinite(speedValue) || speedValue <= 0))
                result.Diagnostics.Add(Error("twin.behavior.actuator.speed.invalid", "执行机构速度必须大于 0。", $"{path}.speed"));
        });

        InspectObjectArray(manifest, "poses", result, (pose, index) =>
        {
            var path = $"poses[{index}]";
            if (!TryGetNonEmptyString(pose, "poseId", out var poseId) || !poseIds.Add(poseId))
                result.Diagnostics.Add(Error("twin.behavior.pose.id.invalid", "Pose ID 不能为空且必须唯一。", $"{path}.poseId"));
            if (!TryGetNonEmptyString(pose, "objectId", out var objectId) || !objectIds.Contains(objectId))
                result.Diagnostics.Add(Error("twin.behavior.pose.object.invalid", "Pose 引用的场景对象不存在。", $"{path}.objectId"));
            else if (!string.IsNullOrWhiteSpace(poseId)) poseObjectIds[poseId] = objectId;
            if (TryGetNonEmptyString(pose, "workPointId", out var workPointId) && !workPointIds.Contains(workPointId))
                result.Diagnostics.Add(Error("twin.behavior.pose.workpoint.invalid", "Pose 引用的工作点不存在。", $"{path}.workPointId"));
            if (TryGetNonEmptyString(pose, "toolFrameId", out var frameId))
            {
                if (!toolFrameIds.Contains(frameId)) result.Diagnostics.Add(Error("twin.behavior.pose.tool-frame.invalid", "Pose 引用的 TCP/ToolFrame 不存在。", $"{path}.toolFrameId"));
                else if (!string.IsNullOrWhiteSpace(objectId) && toolFrameObjectIds.TryGetValue(frameId, out var frameObjectId) && frameObjectId != objectId)
                    result.Diagnostics.Add(Error("twin.behavior.pose.tool-frame-object.mismatch", "Pose 的 TCP 必须属于 Pose 执行对象。", $"{path}.toolFrameId"));
            }
            if (!pose.TryGetProperty("targets", out var targets) || targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() == 0)
            {
                result.Diagnostics.Add(Error("twin.behavior.pose.targets.empty", "Pose 至少需要一个执行机构目标值。", $"{path}.targets"));
                return;
            }
            var targetActuatorIds = new HashSet<string>(StringComparer.Ordinal);
            var targetIndex = 0;
            foreach (var target in targets.EnumerateArray())
            {
                var targetPath = $"{path}.targets[{targetIndex}]";
                if (!TryGetNonEmptyString(target, "actuatorId", out var targetActuatorId) || !actuatorIds.Contains(targetActuatorId))
                    result.Diagnostics.Add(Error("twin.behavior.pose.actuator.invalid", "Pose 引用了不存在的执行机构。", $"{targetPath}.actuatorId"));
                else
                {
                    if (!targetActuatorIds.Add(targetActuatorId)) result.Diagnostics.Add(Error("twin.behavior.pose.actuator.duplicate", "同一个 Pose 不能重复配置同一执行机构。", $"{targetPath}.actuatorId"));
                    if (!string.IsNullOrWhiteSpace(objectId) && actuatorObjectIds.TryGetValue(targetActuatorId, out var actuatorObjectId) && actuatorObjectId != objectId)
                        result.Diagnostics.Add(Error("twin.behavior.pose.actuator-object.mismatch", "Pose 只能引用所属对象自己的执行机构。", $"{targetPath}.actuatorId"));
                    if (!target.TryGetProperty("value", out var targetValue) ||
                        (actuatorKinds.GetValueOrDefault(targetActuatorId) == "gripper"
                            ? targetValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                            : !targetValue.TryGetDouble(out var number) || !double.IsFinite(number)))
                        result.Diagnostics.Add(Error("twin.behavior.pose.target-value.invalid", "Pose 的执行机构目标值类型不正确。", $"{targetPath}.value"));
                }
                targetIndex += 1;
            }
        });

        InspectObjectArray(manifest, "interlocks", result, (interlock, index) =>
        {
            var path = $"interlocks[{index}]";
            if (!TryGetNonEmptyString(interlock, "interlockId", out var interlockId) || !interlockIds.Add(interlockId))
                result.Diagnostics.Add(Error("twin.behavior.interlock.id.invalid", "联锁 ID 不能为空且必须唯一。", $"{path}.interlockId"));
            if (!interlock.TryGetProperty("conditions", out var conditions) || conditions.ValueKind != JsonValueKind.Array || conditions.GetArrayLength() == 0)
            {
                result.Diagnostics.Add(Warning("twin.behavior.interlock.conditions.empty", "联锁没有配置任何结构化条件。", $"{path}.conditions"));
                return;
            }
            var conditionIndex = 0;
            foreach (var condition in conditions.EnumerateArray())
            {
                var conditionPath = $"{path}.conditions[{conditionIndex}]";
                if (!TryGetNonEmptyString(condition, "source", out _))
                    result.Diagnostics.Add(Error("twin.behavior.interlock.source.required", "联锁条件必须配置状态源。", $"{conditionPath}.source"));
                if (!TryGetNonEmptyString(condition, "operator", out var operation) || !AllowedInterlockOperators.Contains(operation))
                    result.Diagnostics.Add(Error("twin.behavior.interlock.operator.invalid", "联锁条件操作符不受支持。", $"{conditionPath}.operator"));
                conditionIndex += 1;
            }
        });

        var behaviorIds = new HashSet<string>(StringComparer.Ordinal);
        InspectObjectArray(manifest, "behaviors", result, (behavior, behaviorIndex) =>
        {
            var path = $"behaviors[{behaviorIndex}]";
            if (!TryGetNonEmptyString(behavior, "behaviorId", out var behaviorId) || !behaviorIds.Add(behaviorId))
                result.Diagnostics.Add(Error("twin.behavior.id.invalid", "动作编排 ID 不能为空且必须唯一。", $"{path}.behaviorId"));
            if (!TryGetNonEmptyString(behavior, "actorObjectId", out var actorObjectId) || !objectIds.Contains(actorObjectId))
                result.Diagnostics.Add(Error("twin.behavior.actor.invalid", "动作编排引用的执行对象不存在。", $"{path}.actorObjectId"));
            ValidateStateAssignments(behavior, "initialState", path, result);
            if (behavior.TryGetProperty("interlockIds", out var behaviorInterlocks))
            {
                if (behaviorInterlocks.ValueKind != JsonValueKind.Array)
                    result.Diagnostics.Add(Error("twin.behavior.interlocks.invalid", "动作编排联锁引用必须是数组。", $"{path}.interlockIds"));
                else foreach (var interlockIdElement in behaviorInterlocks.EnumerateArray())
                {
                    var reference = interlockIdElement.ValueKind == JsonValueKind.String ? interlockIdElement.GetString() : null;
                    if (string.IsNullOrWhiteSpace(reference) || !interlockIds.Contains(reference))
                        result.Diagnostics.Add(Error("twin.behavior.interlock.reference.invalid", "动作编排引用的联锁不存在。", $"{path}.interlockIds"));
                }
            }
            if (!behavior.TryGetProperty("actions", out var actions) || actions.ValueKind != JsonValueKind.Array || actions.GetArrayLength() == 0)
            {
                result.Diagnostics.Add(Error("twin.behavior.actions.empty", "动作编排至少需要一个动作步骤。", $"{path}.actions"));
                return;
            }
            var actionIds = new HashSet<string>(StringComparer.Ordinal);
            var actionIndex = 0;
            foreach (var action in actions.EnumerateArray())
            {
                var actionPath = $"{path}.actions[{actionIndex}]";
                if (action.ValueKind != JsonValueKind.Object)
                {
                    result.Diagnostics.Add(Error("twin.behavior.action.invalid", "动作步骤必须是对象。", actionPath));
                    actionIndex += 1;
                    continue;
                }
                if (!TryGetNonEmptyString(action, "actionId", out var actionId) || !actionIds.Add(actionId))
                    result.Diagnostics.Add(Error("twin.behavior.action.id.invalid", "动作步骤 actionId 不能为空且在同一编排内必须唯一。", $"{actionPath}.actionId"));
                if (!TryGetNonEmptyString(action, "kind", out var actionKind) || !AllowedBehaviorActionKinds.Contains(actionKind))
                    result.Diagnostics.Add(Error("twin.behavior.action.kind.invalid", "动作步骤类型不受支持。", $"{actionPath}.kind"));
                var referencedWorkPointId = GetString(action, "workPointId");
                if (actionKind is "moveTo" or "pick" or "place")
                {
                    if (string.IsNullOrWhiteSpace(referencedWorkPointId) || !workPointIds.Contains(referencedWorkPointId))
                        result.Diagnostics.Add(Error("twin.behavior.action.workpoint.invalid", "移动、抓取或放置动作必须引用有效工作点。", $"{actionPath}.workPointId"));
                }
                else if (!string.IsNullOrWhiteSpace(referencedWorkPointId) && !workPointIds.Contains(referencedWorkPointId))
                    result.Diagnostics.Add(Error("twin.behavior.action.workpoint-reference.invalid", "动作引用的工作点不存在。", $"{actionPath}.workPointId"));
                if (TryGetNonEmptyString(action, "sourceSlotId", out var sourceSlotId) && !materialSlotIds.Contains(sourceSlotId))
                    result.Diagnostics.Add(Error("twin.behavior.action.source-slot.invalid", "动作引用的来源 MaterialSlot 不存在。", $"{actionPath}.sourceSlotId"));
                if (TryGetNonEmptyString(action, "targetSlotId", out var targetSlotId) && !materialSlotIds.Contains(targetSlotId))
                    result.Diagnostics.Add(Error("twin.behavior.action.target-slot.invalid", "动作引用的目标 MaterialSlot 不存在。", $"{actionPath}.targetSlotId"));
                if (actionKind == "prepareSlot" && (!TryGetNonEmptyString(action, "sourceSlotId", out sourceSlotId) || !materialSlotIds.Contains(sourceSlotId)))
                    result.Diagnostics.Add(Error("twin.behavior.action.prepare-slot.invalid", "prepareSlot 必须引用有效来源 MaterialSlot。", $"{actionPath}.sourceSlotId"));
                if (TryGetNonEmptyString(action, "toolFrameId", out var actionFrameId))
                {
                    if (!toolFrameIds.Contains(actionFrameId)) result.Diagnostics.Add(Error("twin.behavior.action.tool-frame.invalid", "动作引用的 TCP/ToolFrame 不存在。", $"{actionPath}.toolFrameId"));
                    else if (!string.IsNullOrWhiteSpace(actorObjectId) && toolFrameObjectIds.TryGetValue(actionFrameId, out var frameObjectId) && frameObjectId != actorObjectId)
                        result.Diagnostics.Add(Error("twin.behavior.action.tool-frame-actor.mismatch", "动作 TCP 必须属于当前执行对象。", $"{actionPath}.toolFrameId"));
                }
                var referencedPoseId = GetString(action, "poseId");
                if (actionKind == "movePose" && (string.IsNullOrWhiteSpace(referencedPoseId) || !poseIds.Contains(referencedPoseId)))
                    result.Diagnostics.Add(Error("twin.behavior.action.pose.invalid", "movePose 必须引用有效 Pose。", $"{actionPath}.poseId"));
                else if (!string.IsNullOrWhiteSpace(referencedPoseId) &&
                         (!poseIds.Contains(referencedPoseId) || poseObjectIds.GetValueOrDefault(referencedPoseId) != actorObjectId))
                    result.Diagnostics.Add(Error("twin.behavior.action.pose-reference.invalid", "动作引用的 Pose 不存在或不属于当前执行对象。", $"{actionPath}.poseId"));
                if (TryGetNonEmptyString(action, "actuatorId", out var actionActuatorId))
                {
                    if (!actuatorIds.Contains(actionActuatorId)) result.Diagnostics.Add(Error("twin.behavior.action.actuator.invalid", "动作引用的执行机构不存在。", $"{actionPath}.actuatorId"));
                    else if (!string.IsNullOrWhiteSpace(actorObjectId) && actuatorObjectIds.GetValueOrDefault(actionActuatorId) != actorObjectId)
                        result.Diagnostics.Add(Error("twin.behavior.action.actuator-actor.mismatch", "动作只能引用当前执行对象所属的执行机构。", $"{actionPath}.actuatorId"));
                }
                if (actionKind == "waitSignal")
                {
                    if (!TryGetNonEmptyString(action, "signalBindingId", out var signalBindingId) || !bindingIds.Contains(signalBindingId))
                        result.Diagnostics.Add(Error("twin.behavior.action.signal.invalid", "waitSignal 必须引用已入库的数据绑定。", $"{actionPath}.signalBindingId"));
                    if (!HasPositiveNumber(action, "timeoutSeconds"))
                        result.Diagnostics.Add(Warning("twin.behavior.action.timeout.default", "阻塞动作未配置有限超时，将使用运行时 300 秒安全默认值。", $"{actionPath}.timeoutSeconds"));
                }
                if (TryGetNonEmptyString(action, "waitForInterlockId", out var waitInterlockId))
                {
                    if (!interlockIds.Contains(waitInterlockId)) result.Diagnostics.Add(Error("twin.behavior.action.interlock.invalid", "等待动作引用的联锁不存在。", $"{actionPath}.waitForInterlockId"));
                    if (!HasPositiveNumber(action, "timeoutSeconds")) result.Diagnostics.Add(Warning("twin.behavior.action.timeout.default", "联锁等待未配置有限超时，将使用运行时 300 秒安全默认值。", $"{actionPath}.timeoutSeconds"));
                }
                ValidateOptionalNonNegativeNumber(action, "timeoutSeconds", actionPath, "twin.behavior.action.timeout.invalid", "动作超时秒数不能小于 0。", result);
                ValidateOptionalNonNegativeNumber(action, "waitSeconds", actionPath, "twin.behavior.action.wait.invalid", "等待秒数不能小于 0。", result);
                ValidateOptionalNonNegativeNumber(action, "durationSeconds", actionPath, "twin.behavior.action.duration.invalid", "动作最短持续秒数不能小于 0。", result);
                ValidateOptionalVector(action, "approachOffset", actionPath, "twin.behavior.action.approach-offset.invalid", "动作接近偏移必须是三个有限数值。", result);
                ValidateOptionalVector(action, "liftOffset", actionPath, "twin.behavior.action.lift-offset.invalid", "动作提升偏移必须是三个有限数值。", result);
                ValidateStateAssignments(action, "onStartState", actionPath, result);
                ValidateStateAssignments(action, "onCompleteState", actionPath, result);
                actionIndex += 1;
            }
        });
    }

    private static void InspectObjectArray(JsonElement manifest, string propertyName, TwinManifestInspection result, Action<JsonElement, int> inspect)
    {
        if (!manifest.TryGetProperty(propertyName, out var items) || items.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error($"twin.{propertyName}.invalid", $"{propertyName} 必须是数组。", propertyName));
            return;
        }
        var index = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                result.Diagnostics.Add(Error($"twin.{propertyName}.item.invalid", $"{propertyName} 的成员必须是对象。", $"{propertyName}[{index}]"));
            else inspect(item, index);
            index += 1;
        }
    }

    private static void ValidateOptionalVector(JsonElement element, string propertyName, string path, string code, string message, TwinManifestInspection result)
    {
        if (element.TryGetProperty(propertyName, out var value) && value.ValueKind != JsonValueKind.Null && !IsFiniteVector(value))
            result.Diagnostics.Add(Error(code, message, $"{path}.{propertyName}"));
    }

    private static void ValidateOptionalNonNegativeNumber(JsonElement element, string propertyName, string path, string code, string message, TwinManifestInspection result)
    {
        if (element.TryGetProperty(propertyName, out var value) && value.ValueKind != JsonValueKind.Null &&
            (!value.TryGetDouble(out var number) || !double.IsFinite(number) || number < 0))
            result.Diagnostics.Add(Error(code, message, $"{path}.{propertyName}"));
    }

    private static bool HasPositiveNumber(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.TryGetDouble(out var number) && double.IsFinite(number) && number > 0;

    private static void ValidateStateAssignments(JsonElement element, string propertyName, string path, TwinManifestInspection result)
    {
        if (!element.TryGetProperty(propertyName, out var assignments)) return;
        if (assignments.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.behavior.state.invalid", "结构化状态赋值必须是数组。", $"{path}.{propertyName}"));
            return;
        }
        var index = 0;
        foreach (var assignment in assignments.EnumerateArray())
        {
            if (assignment.ValueKind != JsonValueKind.Object || !TryGetNonEmptyString(assignment, "source", out _))
                result.Diagnostics.Add(Error("twin.behavior.state-source.required", "结构化状态赋值必须配置状态源。", $"{path}.{propertyName}[{index}].source"));
            index += 1;
        }
    }

    private static void InspectRoutes(JsonElement manifest, HashSet<string> objectIds, TwinManifestInspection result)
    {
        if (!manifest.TryGetProperty("routes", out var routes) || routes.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("twin.routes.invalid", "routes 必须是数组。", "routes"));
            return;
        }

        var routeKeys = new HashSet<string>(StringComparer.Ordinal);
        var routeBindingKeys = result.Bindings
            .Where(binding => binding.SourceKind != TwinBindingSourceKind.Resource && binding.TransformKind.Equals("routeEvent", StringComparison.OrdinalIgnoreCase))
            .Select(binding => binding.BindingKey)
            .ToHashSet(StringComparer.Ordinal);
        var index = 0;
        foreach (var route in routes.EnumerateArray())
        {
            var path = $"routes[{index}]";
            if (!TryGetNonEmptyString(route, "routeId", out var routeKey) || !routeKeys.Add(routeKey))
            {
                result.Diagnostics.Add(Error("twin.route.id.invalid", "routeId 不能为空且必须唯一。", $"{path}.routeId"));
                index += 1;
                continue;
            }

            var hasGraph = route.TryGetProperty("edges", out var edges);
            var pointKeys = new HashSet<string>(StringComparer.Ordinal);
            var pointKinds = new Dictionary<string, string>(StringComparer.Ordinal);
            if (!route.TryGetProperty("points", out var points) || points.ValueKind != JsonValueKind.Array || points.GetArrayLength() < 2)
            {
                result.Diagnostics.Add(Error("twin.route.points.insufficient", "路线至少需要两个控制点。", $"{path}.points"));
            }
            else
            {
                var pointIndex = 0;
                foreach (var point in points.EnumerateArray())
                {
                    if (!point.TryGetProperty("position", out var position) || !IsFiniteVector(position))
                    {
                        result.Diagnostics.Add(Error("twin.route.point.invalid", "路线控制点必须包含三个有限数值坐标。", $"{path}.points[{pointIndex}].position"));
                    }
                    if (TryGetNonEmptyString(point, "pointId", out var pointKey))
                    {
                        if (!pointKeys.Add(pointKey))
                        {
                            result.Diagnostics.Add(Error("twin.route.point.id.invalid", "路线控制点 ID 必须唯一。", $"{path}.points[{pointIndex}].pointId"));
                        }
                        var pointKind = GetString(point, "kind") ?? "waypoint";
                        pointKinds[pointKey] = pointKind;
                        if (!AllowedRoutePointKinds.Contains(pointKind))
                        {
                            result.Diagnostics.Add(Error("twin.route.point.kind.invalid", $"路线节点类型 {pointKind} 不受支持。", $"{path}.points[{pointIndex}].kind"));
                        }
						if (TryGetNonEmptyString(point, "decisionMode", out var decisionMode) &&
							!decisionMode.Equals("plc", StringComparison.OrdinalIgnoreCase) &&
							!decisionMode.Equals("simulation", StringComparison.OrdinalIgnoreCase) &&
							!decisionMode.Equals("manual", StringComparison.OrdinalIgnoreCase))
						{
							result.Diagnostics.Add(Error("twin.route.point.decision-mode.invalid", "岔口决策模式只能是 plc、simulation 或 manual。", $"{path}.points[{pointIndex}].decisionMode"));
						}
						if (point.TryGetProperty("decisionTimeoutSeconds", out var decisionTimeout) &&
							(!decisionTimeout.TryGetDouble(out var decisionTimeoutValue) || !double.IsFinite(decisionTimeoutValue) || decisionTimeoutValue <= 0))
						{
							result.Diagnostics.Add(Error("twin.route.point.decision-timeout.invalid", "岔口决策超时必须大于 0 秒。", $"{path}.points[{pointIndex}].decisionTimeoutSeconds"));
						}
                        foreach (var bindingProperty in new[] { "actuatorBindingId", "sensorBindingId" })
                        {
                            if (TryGetNonEmptyString(point, bindingProperty, out var bindingId) && !routeBindingKeys.Contains(bindingId))
                            {
                                result.Diagnostics.Add(Error("twin.route.point.binding.invalid", "路线节点必须引用 routeEvent 数据绑定。", $"{path}.points[{pointIndex}].{bindingProperty}"));
                            }
                        }
						if (point.TryGetProperty("process", out var process))
						{
							var processPath = $"{path}.points[{pointIndex}].process";
							if (process.ValueKind != JsonValueKind.Object)
							{
								result.Diagnostics.Add(Error("twin.route.point.process.invalid", "工艺定义必须是对象。", processPath));
							}
							else
							{
								if (!pointKind.Equals("processStation", StringComparison.OrdinalIgnoreCase))
								{
									result.Diagnostics.Add(Error("twin.route.point.process-kind.invalid", "只有加工工位节点可以配置工艺定义。", processPath));
								}
								if (!TryGetNonEmptyString(process, "type", out var processType) || !AllowedProcessTypes.Contains(processType))
								{
									result.Diagnostics.Add(Error("twin.route.point.process-type.invalid", "工位类型不受支持。", $"{processPath}.type"));
								}
								if (process.TryGetProperty("cycleSeconds", out var cycleSeconds) &&
									(!cycleSeconds.TryGetDouble(out var cycleValue) || !double.IsFinite(cycleValue) || cycleValue <= 0))
								{
									result.Diagnostics.Add(Error("twin.route.point.process-cycle.invalid", "工位仿真节拍必须大于 0 秒。", $"{processPath}.cycleSeconds"));
								}
								foreach (var bindingProperty in new[] { "readyBindingId", "ackBindingId", "busyBindingId", "completeBindingId", "cycleIdBindingId", "resultBindingId", "faultBindingId" })
								{
									if (TryGetNonEmptyString(process, bindingProperty, out var bindingId) && !routeBindingKeys.Contains(bindingId))
									{
										result.Diagnostics.Add(Error("twin.route.point.process-binding.invalid", "工位信号必须引用 routeEvent 数据绑定。", $"{processPath}.{bindingProperty}"));
									}
								}
								if (process.TryGetProperty("timeoutSeconds", out var timeoutSeconds) &&
									(!timeoutSeconds.TryGetDouble(out var timeoutValue) || !double.IsFinite(timeoutValue) || timeoutValue <= 0))
								{
									result.Diagnostics.Add(Error("twin.route.point.process-timeout.invalid", "工位超时必须大于 0 秒。", $"{processPath}.timeoutSeconds"));
								}
							}
						}
                    }
                    else if (hasGraph)
                    {
                        result.Diagnostics.Add(Error("twin.route.point.id.required", "路线图中的控制点必须包含 pointId。", $"{path}.points[{pointIndex}].pointId"));
                    }
                    pointIndex += 1;
                }
            }

            if (TryGetNonEmptyString(route, "startPointId", out var startPointId) && !pointKeys.Contains(startPointId))
            {
                result.Diagnostics.Add(Error("twin.route.start.invalid", "路线起点不存在。", $"{path}.startPointId"));
            }
            if (TryGetNonEmptyString(route, "routingMode", out var routingMode) &&
                !routingMode.Equals("manual", StringComparison.OrdinalIgnoreCase) &&
                !routingMode.Equals("automatic", StringComparison.OrdinalIgnoreCase))
            {
                result.Diagnostics.Add(Error("twin.route.routing-mode.invalid", "分流方式只能是 manual 或 automatic。", $"{path}.routingMode"));
            }

            var edgeIndex = new Dictionary<string, (string From, string To, bool Bidirectional)>(StringComparer.Ordinal);
            var incidentCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            var incomingCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            var outgoingCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            if (hasGraph)
            {
                if (edges.ValueKind != JsonValueKind.Array)
                {
                    result.Diagnostics.Add(Error("twin.route.edges.invalid", "路线 edges 必须是数组。", $"{path}.edges"));
                }
                else
                {
                    var edgePosition = 0;
                    foreach (var edge in edges.EnumerateArray())
                    {
                        var edgePath = $"{path}.edges[{edgePosition}]";
                        var hasEdgeId = TryGetNonEmptyString(edge, "edgeId", out var edgeId);
                        var hasFrom = TryGetNonEmptyString(edge, "fromPointId", out var fromPointId);
                        var hasTo = TryGetNonEmptyString(edge, "toPointId", out var toPointId);
                        if (!hasEdgeId || edgeIndex.ContainsKey(edgeId))
                        {
                            result.Diagnostics.Add(Error("twin.route.edge.id.invalid", "路线边 ID 不能为空且必须唯一。", $"{edgePath}.edgeId"));
                        }
                        if (!hasFrom || !hasTo || !pointKeys.Contains(fromPointId) || !pointKeys.Contains(toPointId))
                        {
                            result.Diagnostics.Add(Error("twin.route.edge.reference.invalid", "路线边引用了不存在的控制点。", edgePath));
                        }
                        if (hasFrom && hasTo && string.Equals(fromPointId, toPointId, StringComparison.Ordinal))
                        {
                            result.Diagnostics.Add(Error("twin.route.edge.self.invalid", "路线边不允许连接到自身。", edgePath));
                        }
                        if (edge.TryGetProperty("capacity", out var capacity) && (!capacity.TryGetInt32(out var capacityValue) || capacityValue <= 0))
                        {
                            result.Diagnostics.Add(Error("twin.route.edge.capacity.invalid", "输送段容量必须是大于 0 的整数。", $"{edgePath}.capacity"));
                        }
						var occupancyMode = GetString(edge, "occupancyMode");
						if (occupancyMode != null &&
							!occupancyMode.Equals("calculated", StringComparison.OrdinalIgnoreCase) &&
							!occupancyMode.Equals("simulation", StringComparison.OrdinalIgnoreCase) &&
							!occupancyMode.Equals("live", StringComparison.OrdinalIgnoreCase))
						{
							result.Diagnostics.Add(Error("twin.route.edge.occupancy-mode.invalid", "输送段占用模式只能是 calculated、simulation 或 live。", $"{edgePath}.occupancyMode"));
						}
						if (edge.TryGetProperty("reservationTimeoutSeconds", out var reservationTimeout) &&
							(!reservationTimeout.TryGetDouble(out var reservationTimeoutValue) || !double.IsFinite(reservationTimeoutValue) || reservationTimeoutValue <= 0))
						{
							result.Diagnostics.Add(Error("twin.route.edge.reservation-timeout.invalid", "输送段预占租约必须大于 0 秒。", $"{edgePath}.reservationTimeoutSeconds"));
						}
						var conveyorSizeClass = GetString(edge, "conveyorSizeClass");
						var transportUnitType = GetString(edge, "transportUnitType");
						if (conveyorSizeClass != null && !AllowedConveyorSizeClasses.Contains(conveyorSizeClass))
						{
							result.Diagnostics.Add(Error("twin.route.edge.conveyor-size.invalid", "辊道规格只能是 small 或 large。", $"{edgePath}.conveyorSizeClass"));
						}
						if (transportUnitType != null && !AllowedTransportUnitTypes.Contains(transportUnitType))
						{
							result.Diagnostics.Add(Error("twin.route.edge.transport-unit.invalid", "输送对象类型不受支持。", $"{edgePath}.transportUnitType"));
						}
						if (conveyorSizeClass?.Equals("small", StringComparison.OrdinalIgnoreCase) == true && transportUnitType?.Equals("wooden-pallet", StringComparison.OrdinalIgnoreCase) == true)
						{
							result.Diagnostics.Add(Error("twin.route.edge.transport-unit-size.invalid", "小辊道不允许输送木托盘。", $"{edgePath}.transportUnitType"));
						}
						if (conveyorSizeClass?.Equals("large", StringComparison.OrdinalIgnoreCase) == true && transportUnitType?.Equals("plastic-pallet", StringComparison.OrdinalIgnoreCase) == true)
						{
							result.Diagnostics.Add(Error("twin.route.edge.transport-unit-size.invalid", "大辊道不允许输送塑料托盘。", $"{edgePath}.transportUnitType"));
						}
						if (occupancyMode?.Equals("live", StringComparison.OrdinalIgnoreCase) == true &&
							!TryGetNonEmptyString(edge, "occupancyBindingId", out _) &&
							!TryGetNonEmptyString(edge, "fullBindingId", out _))
						{
							result.Diagnostics.Add(Warning("twin.route.edge.live-binding.missing", "Live 占用模式至少应配置占用数量或满位信号。", edgePath));
						}
						foreach (var bindingProperty in new[] { "occupancyBindingId", "fullBindingId", "blockedBindingId" })
                        {
                            if (TryGetNonEmptyString(edge, bindingProperty, out var bindingId) && !routeBindingKeys.Contains(bindingId))
                            {
                                result.Diagnostics.Add(Error("twin.route.edge.binding.invalid", "输送段必须引用 routeEvent 数据绑定。", $"{edgePath}.{bindingProperty}"));
                            }
                        }
                        if (TryGetNonEmptyString(edge, "conveyorObjectId", out var conveyorObjectId) && !objectIds.Contains(conveyorObjectId))
                        {
                            result.Diagnostics.Add(Error("twin.route.edge.object.invalid", "输送段引用的场景对象不存在。", $"{edgePath}.conveyorObjectId"));
                        }
                        if (hasEdgeId && hasFrom && hasTo && !edgeIndex.ContainsKey(edgeId))
                        {
                            edgeIndex[edgeId] = (fromPointId, toPointId, GetBoolean(edge, "bidirectional", false));
                        }
                        if (hasFrom && hasTo && GetBoolean(edge, "enabled", true))
                        {
                            incidentCounts[fromPointId] = incidentCounts.GetValueOrDefault(fromPointId) + 1;
                            incidentCounts[toPointId] = incidentCounts.GetValueOrDefault(toPointId) + 1;
                            outgoingCounts[fromPointId] = outgoingCounts.GetValueOrDefault(fromPointId) + 1;
                            incomingCounts[toPointId] = incomingCounts.GetValueOrDefault(toPointId) + 1;
                            if (GetBoolean(edge, "bidirectional", false))
                            {
                                outgoingCounts[toPointId] = outgoingCounts.GetValueOrDefault(toPointId) + 1;
                                incomingCounts[fromPointId] = incomingCounts.GetValueOrDefault(fromPointId) + 1;
                            }
                        }
                        edgePosition += 1;
                    }
                }
            }

            if (route.TryGetProperty("junctionDecisions", out var junctionDecisions))
            {
                if (junctionDecisions.ValueKind != JsonValueKind.Object)
                {
                    result.Diagnostics.Add(Error("twin.route.junction.decisions.invalid", "junctionDecisions 必须是对象。", $"{path}.junctionDecisions"));
                }
                else
                {
                    foreach (var decision in junctionDecisions.EnumerateObject())
                    {
                        var edgeId = decision.Value.ValueKind == JsonValueKind.String ? decision.Value.GetString() : null;
                        var valid = pointKeys.Contains(decision.Name) && edgeId != null && edgeIndex.TryGetValue(edgeId, out var selectedEdge) &&
                                    (selectedEdge.From == decision.Name || (selectedEdge.Bidirectional && selectedEdge.To == decision.Name));
                        if (!valid)
                        {
                            result.Diagnostics.Add(Error("twin.route.junction.decision.invalid", "交叉口转向规则没有指向该节点可用的出边。", $"{path}.junctionDecisions.{decision.Name}"));
                        }
                    }
                }
            }

            if (route.TryGetProperty("decisionRules", out var decisionRules))
            {
                if (decisionRules.ValueKind != JsonValueKind.Array)
                {
                    result.Diagnostics.Add(Error("twin.route.rules.invalid", "decisionRules 必须是数组。", $"{path}.decisionRules"));
                }
                else
                {
                    var ruleIds = new HashSet<string>(StringComparer.Ordinal);
                    var ruleIndex = 0;
                    foreach (var rule in decisionRules.EnumerateArray())
                    {
                        var rulePath = $"{path}.decisionRules[{ruleIndex}]";
                        if (!TryGetNonEmptyString(rule, "ruleId", out var ruleId) || !ruleIds.Add(ruleId))
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.id.invalid", "自动选路规则 ID 不能为空且必须唯一。", $"{rulePath}.ruleId"));
                        }
                        var hasPoint = TryGetNonEmptyString(rule, "junctionPointId", out var junctionPointId);
                        var hasEdge = TryGetNonEmptyString(rule, "edgeId", out var ruleEdgeId);
                        var canLeave = hasPoint && hasEdge && pointKeys.Contains(junctionPointId) &&
                            edgeIndex.TryGetValue(ruleEdgeId, out var ruleEdge) &&
                            (ruleEdge.From == junctionPointId || (ruleEdge.Bidirectional && ruleEdge.To == junctionPointId));
                        if (!canLeave)
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.reference.invalid", "自动选路规则没有指向分流节点的有效出边。", rulePath));
                        }
                        if (!TryGetNonEmptyString(rule, "source", out var source) ||
                            (!source.Equals("payload", StringComparison.OrdinalIgnoreCase) && !source.Equals("binding", StringComparison.OrdinalIgnoreCase)))
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.source.invalid", "自动选路规则来源只能是 payload 或 binding。", $"{rulePath}.source"));
                        }
                        else if (source.Equals("payload", StringComparison.OrdinalIgnoreCase) && !TryGetNonEmptyString(rule, "payloadKey", out _))
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.payload-key.required", "物料属性规则必须填写属性 Key。", $"{rulePath}.payloadKey"));
                        }
                        else if (source.Equals("binding", StringComparison.OrdinalIgnoreCase) &&
                                 (!TryGetNonEmptyString(rule, "bindingId", out var bindingId) || !routeBindingKeys.Contains(bindingId)))
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.binding.invalid", "设备信号规则必须引用 routeEvent 数据绑定。", $"{rulePath}.bindingId"));
                        }
                        if (!TryGetNonEmptyString(rule, "operator", out var ruleOperator) || !AllowedRouteRuleOperators.Contains(ruleOperator))
                        {
                            result.Diagnostics.Add(Error("twin.route.rule.operator.invalid", "自动选路规则操作符不受支持。", $"{rulePath}.operator"));
                        }
                        ruleIndex += 1;
                    }
                }
            }

            foreach (var (pointKey, pointKind) in pointKinds)
            {
                if ((pointKind.Equals("junction", StringComparison.OrdinalIgnoreCase) ||
                     pointKind.Equals("diverter", StringComparison.OrdinalIgnoreCase) ||
                     pointKind.Equals("merger", StringComparison.OrdinalIgnoreCase)) &&
                    incidentCounts.GetValueOrDefault(pointKey) < 3)
                {
                    result.Diagnostics.Add(Error("twin.route.junction.degree.invalid", "交叉口、分流器或汇流器至少需要连接三条路线边。", $"{path}.points"));
                }
                if (pointKind.Equals("diverter", StringComparison.OrdinalIgnoreCase) && outgoingCounts.GetValueOrDefault(pointKey) < 2)
                {
                    result.Diagnostics.Add(Error("twin.route.diverter.outgoing.invalid", "分流器至少需要两条可用出边。", $"{path}.points"));
                }
                if (pointKind.Equals("merger", StringComparison.OrdinalIgnoreCase) && incomingCounts.GetValueOrDefault(pointKey) < 2)
                {
                    result.Diagnostics.Add(Error("twin.route.merger.incoming.invalid", "汇流器至少需要两条可用入边。", $"{path}.points"));
                }
            }

            if (!route.TryGetProperty("defaultSpeed", out var speed) || !speed.TryGetDouble(out var speedValue) || !double.IsFinite(speedValue) || speedValue <= 0)
            {
                result.Diagnostics.Add(Error("twin.route.speed.invalid", "路线速度必须大于 0。", $"{path}.defaultSpeed"));
            }

            result.Routes.Add(new TwinRouteDraft
            {
                RouteKey = routeKey,
                Name = GetString(route, "name") ?? routeKey,
                RouteType = GetString(route, "type") ?? "conveyor",
                GraphPayload = route.GetRawText(),
                Enabled = GetBoolean(route, "enabled", true)
            });
            index += 1;
        }

        foreach (var binding in result.Bindings.Where(item => item.TransformKind.Equals("routeSlotArray", StringComparison.OrdinalIgnoreCase)))
        {
            if (binding.SourceKind != TwinBindingSourceKind.Telemetry)
            {
                result.Diagnostics.Add(Error("twin.binding.route-slot.source.invalid", "托盘位置数组只能绑定 Telemetry 数据源。", $"bindings.{binding.BindingKey}.source.kind"));
            }

            using var transformDocument = JsonDocument.Parse(binding.TransformConfig);
            var routeId = GetString(transformDocument.RootElement, "routeId");
            if (string.IsNullOrWhiteSpace(routeId) && !string.IsNullOrWhiteSpace(binding.TargetPath) && binding.TargetPath.StartsWith("routeSlots:", StringComparison.Ordinal))
            {
                routeId = binding.TargetPath["routeSlots:".Length..];
            }
            if (string.IsNullOrWhiteSpace(routeId) || !routeKeys.Contains(routeId))
            {
                result.Diagnostics.Add(Error("twin.binding.route-slot.route.invalid", "托盘位置数组必须引用当前场景中存在的目标路线。", $"bindings.{binding.BindingKey}.transform.routeId"));
            }
        }

        foreach (var binding in result.Bindings.Where(item => item.TransformKind.Equals("routeDistance", StringComparison.OrdinalIgnoreCase)))
        {
            if (binding.SourceKind != TwinBindingSourceKind.Telemetry)
            {
                result.Diagnostics.Add(Error("twin.binding.route-distance.source.invalid", "路线实际位置只能绑定 Telemetry 数据源。", $"bindings.{binding.BindingKey}.source.kind"));
            }

            using var transformDocument = JsonDocument.Parse(binding.TransformConfig);
            var routeId = GetString(transformDocument.RootElement, "routeId");
            if (string.IsNullOrWhiteSpace(routeId) || !routeKeys.Contains(routeId))
            {
                result.Diagnostics.Add(Error("twin.binding.route-distance.route.invalid", "路线实际位置必须引用当前场景中存在的目标路线。", $"bindings.{binding.BindingKey}.transform.routeId"));
            }
        }
    }

    private static void ValidateTransform(JsonElement sceneObject, string path, List<TwinValidationDiagnosticDto> diagnostics)
    {
        if (!sceneObject.TryGetProperty("transform", out var transform) || transform.ValueKind != JsonValueKind.Object)
        {
            diagnostics.Add(Error("twin.object.transform.required", "对象 transform 不能为空。", $"{path}.transform"));
            return;
        }

        foreach (var property in new[] { "position", "rotation", "scale" })
        {
            if (!transform.TryGetProperty(property, out var value) || !IsFiniteVector(value))
            {
                diagnostics.Add(Error("twin.object.transform.invalid", $"对象 {property} 必须是三个有限数值。", $"{path}.transform.{property}"));
            }
        }
    }

    private static void ValidateUntrustedValues(JsonElement element, string path, List<TwinValidationDiagnosticDto> diagnostics)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    var propertyPath = $"{path}.{property.Name}";
                    if (IsForbiddenExecutablePropertyName(property.Name))
                    {
                        diagnostics.Add(Error("twin.script.forbidden", "场景清单禁止包含脚本或函数。", propertyPath));
                    }
                    ValidateUntrustedValues(property.Value, propertyPath, diagnostics);
                }
                break;
            case JsonValueKind.Array:
                var index = 0;
                foreach (var child in element.EnumerateArray())
                {
                    ValidateUntrustedValues(child, $"{path}[{index}]", diagnostics);
                    index += 1;
                }
                break;
            case JsonValueKind.String:
                var text = element.GetString()?.Trim();
                if (text != null && (text.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase) ||
                                     text.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ||
                                     text.StartsWith("blob:", StringComparison.OrdinalIgnoreCase) ||
                                     text.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                                     text.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                                     text.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                {
                    diagnostics.Add(Error("twin.external-url.forbidden", "场景清单不能包含外部 URL 或内联 data URL。", path));
                }
                break;
            case JsonValueKind.Number:
                if (!element.TryGetDouble(out var number) || !double.IsFinite(number))
                {
                    diagnostics.Add(Error("twin.number.invalid", "场景数值必须是有限数值。", path));
                }
                break;
        }
    }

    private static void SanitizeThreeEditorSnapshot(JsonObject root, TwinManifestInspection result)
    {
        if (root["editorExtension"] is not JsonObject extension ||
            extension["threeEditor"] is not JsonObject snapshot) return;

        StripUnsafeEditorValues(snapshot, "$.editorExtension.threeEditor", result.Diagnostics);
    }

    private static void StripUnsafeEditorValues(JsonNode? node, string path, List<TwinValidationDiagnosticDto> diagnostics)
    {
        if (node is JsonObject jsonObject)
        {
            foreach (var property in jsonObject.ToList())
            {
                var propertyPath = $"{path}.{property.Key}";
                if (IsForbiddenExecutablePropertyName(property.Key))
                {
                    jsonObject.Remove(property.Key);
                    diagnostics.Add(Warning("twin.editor-executable.stripped", "已移除 three editor 快照中的脚本或函数配置。", propertyPath));
                    continue;
                }
                if (IsTransientEditorUrl(property.Value))
                {
                    jsonObject[property.Key] = null;
                    diagnostics.Add(Warning("twin.editor-url.stripped", "已移除 three editor 快照中的临时图片或外部 URL。", propertyPath));
                    continue;
                }
                StripUnsafeEditorValues(property.Value, propertyPath, diagnostics);
            }
            return;
        }

        if (node is not JsonArray jsonArray) return;
        for (var index = 0; index < jsonArray.Count; index += 1)
        {
            var itemPath = $"{path}[{index}]";
            if (IsTransientEditorUrl(jsonArray[index]))
            {
                jsonArray[index] = null;
                diagnostics.Add(Warning("twin.editor-url.stripped", "已移除 three editor 快照中的临时图片或外部 URL。", itemPath));
                continue;
            }
            StripUnsafeEditorValues(jsonArray[index], itemPath, diagnostics);
        }
    }

    private static bool IsTransientEditorUrl(JsonNode? node)
    {
        if (node is not JsonValue value || !value.TryGetValue<string>(out var text)) return false;
        text = text.Trim();
        return text.StartsWith("blob:", StringComparison.OrdinalIgnoreCase) ||
               text.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
               text.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
               text.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsForbiddenExecutablePropertyName(string propertyName)
    {
        if (ForbiddenExecutablePropertyNames.Contains(propertyName)) return true;
        return ContainsIdentifierToken(propertyName, "script") || ContainsIdentifierToken(propertyName, "function");
    }

    private static bool ContainsIdentifierToken(string propertyName, string token)
    {
        var searchFrom = 0;
        while (searchFrom < propertyName.Length)
        {
            var index = propertyName.IndexOf(token, searchFrom, StringComparison.OrdinalIgnoreCase);
            if (index < 0) return false;

            var end = index + token.Length;
            var startsToken = index == 0 ||
                              !char.IsLetterOrDigit(propertyName[index - 1]) ||
                              (char.IsLower(propertyName[index - 1]) && char.IsUpper(propertyName[index]));
            var endsToken = end == propertyName.Length ||
                            !char.IsLetterOrDigit(propertyName[end]) ||
                            char.IsUpper(propertyName[end]);
            if (startsToken && endsToken) return true;
            searchFrom = index + 1;
        }
        return false;
    }

    private static bool TryParseSourceKind(string value, out TwinBindingSourceKind kind) =>
        Enum.TryParse(value, true, out kind);

    private static bool TryParseTargetKind(string value, out TwinBindingTargetKind kind) =>
        Enum.TryParse(value, true, out kind);

    private static bool IsFiniteVector(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != 3) return false;
        return value.EnumerateArray().All(component => component.TryGetDouble(out var number) && double.IsFinite(number));
    }

    private static bool TryGetGuid(JsonElement element, string propertyName, out Guid value)
    {
        value = Guid.Empty;
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty(propertyName, out var property) &&
               property.ValueKind == JsonValueKind.String &&
               Guid.TryParse(property.GetString(), out value) && value != Guid.Empty;
    }

    private static bool TryGetNonEmptyString(JsonElement element, string propertyName, out string value)
    {
        value = GetString(element, propertyName) ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static string? GetString(JsonElement element, string propertyName) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(propertyName, out var property) &&
        property.ValueKind == JsonValueKind.String
            ? property.GetString()?.Trim()
            : null;

    private static int GetInt(JsonElement element, string propertyName, int fallback) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(propertyName, out var property) &&
        property.TryGetInt32(out var value)
            ? value
            : fallback;

    private static bool GetBoolean(JsonElement element, string propertyName, bool fallback) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(propertyName, out var property) &&
        property.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? property.GetBoolean()
            : fallback;

    private static TwinValidationDiagnosticDto Error(string code, string message, string? path = null) => new()
    {
        Severity = "error",
        Code = code,
        Message = message,
        Path = path
    };

    private static TwinValidationDiagnosticDto Warning(string code, string message, string? path = null) => new()
    {
        Severity = "warning",
        Code = code,
        Message = message,
        Path = path
    };
}

internal sealed class TwinManifestInspection
{
    public string NormalizedPayload { get; set; } = "{}";
    public List<TwinValidationDiagnosticDto> Diagnostics { get; } = [];
    public List<Guid> ResourceIds { get; } = [];
    public List<TwinBindingDraft> Bindings { get; } = [];
    public List<TwinRouteDraft> Routes { get; } = [];
    public List<TwinActionFlowDraft> ActionFlows { get; } = [];
    public List<TwinComponentReferenceDraft> Components { get; } = [];
    public List<TwinConnectionReferenceDraft> Connections { get; } = [];
    public bool Valid => Diagnostics.All(item => !string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase));
}

internal sealed class TwinComponentReferenceDraft
{
    public string ObjectId { get; set; } = string.Empty;
    public Guid ResourceId { get; set; }
    public string ResourceKey { get; set; } = string.Empty;
    public string ComponentType { get; set; } = string.Empty;
    public string Generator { get; set; } = string.Empty;
    public int GeneratorVersion { get; set; }
    public Dictionary<string, string> Bindings { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> InstancePorts { get; set; } = new(StringComparer.Ordinal);
    public string Path { get; set; } = string.Empty;
}

internal sealed class TwinConnectionReferenceDraft
{
    public string ConnectionId { get; set; } = string.Empty;
    public string FromObjectId { get; set; } = string.Empty;
    public string FromPortId { get; set; } = string.Empty;
    public string ToObjectId { get; set; } = string.Empty;
    public string ToPortId { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
}

internal sealed class TwinBindingDraft
{
    public string BindingKey { get; set; } = string.Empty;
    public string ObjectId { get; set; } = string.Empty;
    public string? NodePath { get; set; }
    public Guid? ModelResourceId { get; set; }
    public Guid? AssetId { get; set; }
    public Guid? DeviceId { get; set; }
    public string? SemanticId { get; set; }
    public TwinBindingSourceKind SourceKind { get; set; }
    public string? SourceKey { get; set; }
    public TwinBindingTargetKind TargetKind { get; set; }
    public string? TargetPath { get; set; }
    public string TransformKind { get; set; } = "identity";
    public string TransformConfig { get; set; } = "{}";
    public int Priority { get; set; }
    public int StaleAfterMs { get; set; } = 10000;
    public bool Enabled { get; set; } = true;
}

internal sealed class TwinRouteDraft
{
    public string RouteKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string RouteType { get; set; } = "conveyor";
    public string GraphPayload { get; set; } = "{}";
    public bool Enabled { get; set; } = true;
}
