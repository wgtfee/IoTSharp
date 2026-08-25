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
        "booleanAnimation", "routeProgress", "routeEvent"
    };
    private static readonly HashSet<string> AllowedRoutePointKinds = new(StringComparer.OrdinalIgnoreCase)
    {
        "waypoint", "junction", "station", "diverter", "merger", "buffer", "processStation", "sensor"
    };
    private static readonly HashSet<string> AllowedRouteRuleOperators = new(StringComparer.OrdinalIgnoreCase)
    {
        "equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "contains", "truthy", "falsy"
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
        root["bindings"] ??= new JsonArray();
        root["routes"] ??= new JsonArray();
        root["runtime"] ??= new JsonObject
        {
            ["dataMode"] = "simulation",
            ["maxPixelRatio"] = 2,
            ["showGrid"] = true
        };

        result.NormalizedPayload = root.ToJsonString(WebJsonOptions);
        using var document = JsonDocument.Parse(result.NormalizedPayload);
        var manifest = document.RootElement;

        ValidateTopLevel(manifest, result);
        ValidateUntrustedValues(manifest, "$", result.Diagnostics);
        InspectResources(manifest, result);
        var objectIds = InspectObjects(manifest, rootAssetId, result);
        InspectBindings(manifest, objectIds, result);
        InspectRoutes(manifest, objectIds, result);
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
            if (TryGetNonEmptyString(sceneObject, "kind", out var kind) && kind.Equals("model", StringComparison.OrdinalIgnoreCase) && resourceId == null)
            {
                result.Diagnostics.Add(Error("twin.object.resource.required", "模型对象必须引用已入库的 resourceId。", $"{path}.resourceId"));
            }
            else if (resourceId.HasValue && !result.ResourceIds.Contains(resourceId.Value))
            {
                result.Diagnostics.Add(Error("twin.object.resource.unlisted", "对象引用的模型必须同时出现在 resources 列表中。", $"{path}.resourceId"));
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

        return objectIds;
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
                TargetPath = GetString(target, "property") ?? GetString(target, "path"),
                TransformKind = transformKind,
                TransformConfig = transformConfig,
                Priority = GetInt(binding, "priority", 0),
                StaleAfterMs = Math.Clamp(GetInt(binding, "staleAfterMs", 10000), 100, 86_400_000),
                Enabled = GetBoolean(binding, "enabled", true)
            });
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
                        foreach (var bindingProperty in new[] { "actuatorBindingId", "sensorBindingId" })
                        {
                            if (TryGetNonEmptyString(point, bindingProperty, out var bindingId) && !routeBindingKeys.Contains(bindingId))
                            {
                                result.Diagnostics.Add(Error("twin.route.point.binding.invalid", "路线节点必须引用 routeEvent 数据绑定。", $"{path}.points[{pointIndex}].{bindingProperty}"));
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
                        foreach (var bindingProperty in new[] { "occupancyBindingId", "blockedBindingId" })
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
                    if (property.Name.Contains("script", StringComparison.OrdinalIgnoreCase) ||
                        property.Name.Equals("function", StringComparison.OrdinalIgnoreCase))
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
}

internal sealed class TwinManifestInspection
{
    public string NormalizedPayload { get; set; } = "{}";
    public List<TwinValidationDiagnosticDto> Diagnostics { get; } = [];
    public List<Guid> ResourceIds { get; } = [];
    public List<TwinBindingDraft> Bindings { get; } = [];
    public List<TwinRouteDraft> Routes { get; } = [];
    public bool Valid => Diagnostics.All(item => !string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase));
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
