#nullable enable
using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// Action Flow V2 的服务端安全校验和确定性编译器。服务端始终重新编译，
/// 不信任客户端提供的 graphHash/compiledPlanHash/compiledPayload。
/// </summary>
internal static class TwinActionFlowServerCompiler
{
    private static readonly JsonSerializerOptions WebJsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> AllowedNodeTypes = new(StringComparer.Ordinal)
    {
        "Start", "End", "Merge", "Condition", "Switch", "ParallelFork", "ParallelJoin",
        "MoveTo", "MovePose", "JointMove", "AxisMove", "Home",
        "GripOpen", "GripClose", "Attach", "Detach",
        "PrepareSlot", "ReserveSlot", "TransferMaterial", "ReleaseSlot",
        "ReserveSection", "EnterSection", "LeaveSection", "SelectRoute",
        "WaitSignal", "WriteCommand", "WaitAck", "Delay", "Deadline", "Subflow",
        "ManualConfirm", "RaiseAlarm", "Compensate"
    };
    private static readonly HashSet<string> BlockingNodeTypes = new(StringComparer.Ordinal)
        { "ReserveSlot", "ReserveSection", "WaitSignal", "WaitAck", "ManualConfirm", "Deadline", "WriteCommand" };
    private static readonly HashSet<string> MotionNodeTypes = new(StringComparer.Ordinal)
        { "MoveTo", "MovePose", "JointMove", "AxisMove", "Home" };
    private static readonly HashSet<string> ActuatorNodeTypes = new(StringComparer.Ordinal)
        { "JointMove", "AxisMove", "GripOpen", "GripClose" };
    private static readonly Regex CredentialKeyPattern = new("password|passwd|pwd|token|secret|connectionstring|api[_-]?key|clientsecret", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ExternalUrlPattern = new("^(https?:|data:|javascript:|file:)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static TwinActionFlowServerInspection Inspect(JsonElement manifest)
    {
        var result = new TwinActionFlowServerInspection();
        if (!manifest.TryGetProperty("actionFlows", out var flowsElement) || flowsElement.ValueKind != JsonValueKind.Array)
        {
            result.Diagnostics.Add(Error("AF1001", "actionFlows 必须是数组。", "actionFlows"));
            return result;
        }

        var flows = flowsElement.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).Select(item => item.Clone()).ToList();
        var flowIds = new HashSet<string>(StringComparer.Ordinal);
        var flowKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var flow in flows)
        {
            var flowId = GetString(flow, "flowId");
            var key = GetString(flow, "key");
            if (string.IsNullOrWhiteSpace(flowId) || string.IsNullOrWhiteSpace(key) || !flowIds.Add(flowId) || !flowKeys.Add(key))
                result.Diagnostics.Add(Error("AF1001", "flowId/key 在场景内不能为空且必须唯一。", "actionFlows", flowId));
        }

        foreach (var flow in flows)
        {
            var compiled = Compile(flow, manifest, flowIds);
            result.Diagnostics.AddRange(compiled.Diagnostics);
            if (compiled.Draft is not null) result.ActionFlows.Add(compiled.Draft);
        }
        return result;
    }

    public static TwinActionFlowServerCompileResult Compile(JsonElement flow, JsonElement manifest, IReadOnlySet<string>? allFlowIds = null)
    {
        var result = new TwinActionFlowServerCompileResult();
        var flowId = GetString(flow, "flowId");
        var key = GetString(flow, "key");
        var name = GetString(flow, "name") ?? key ?? flowId ?? "Action Flow";
        var contractVersion = GetString(flow, "contractVersion");
        var nodes = Array(flow, "nodes");
        var edges = Array(flow, "edges");
        var policies = Object(flow, "policies");
        var defaultTimeoutSeconds = PositiveNumber(policies, "defaultTimeoutSeconds") ?? 300d;
        var maxLoopIterations = PositiveInt(policies, "maxLoopIterations") ?? 1000;
        var requireInterlockForCommands = !policies.HasValue || !policies.Value.TryGetProperty("requireInterlockForCommands", out var requireElement) || requireElement.ValueKind != JsonValueKind.False;

        if (string.IsNullOrWhiteSpace(flowId) || string.IsNullOrWhiteSpace(key)) result.Diagnostics.Add(Error("AF1001", "flowId 和 key 均不能为空。", "flowId/key", flowId));
        if (!string.Equals(contractVersion, "2.0", StringComparison.Ordinal)) result.Diagnostics.Add(Error("AF1304", $"不支持的 Action Flow 合同版本：{contractVersion}", "contractVersion", flowId));
        if (nodes.Count > 2000 || edges.Count > 5000) result.Diagnostics.Add(Error("AF1305", "流程节点或边数量超过安全上限。", null, flowId));

        var objectIds = IdSet(manifest, "objects", "objectId");
        var workPointIds = IdSet(manifest, "workPoints", "workPointId");
        var poseIds = IdSet(manifest, "poses", "poseId");
        var actuatorIds = IdSet(manifest, "actuators", "actuatorId");
        var toolFrameIds = IdSet(manifest, "toolFrames", "toolFrameId");
        var slotIds = IdSet(manifest, "materialSlots", "slotId");
        var bindingIds = IdSet(manifest, "bindings", "bindingId");
        var routeIds = IdSet(manifest, "routes", "routeId");
        var interlockIds = IdSet(manifest, "interlocks", "interlockId");
        var declaredVariables = IdSet(flow, "variables", "name");
        allFlowIds ??= new HashSet<string>(new[] { flowId ?? string.Empty }, StringComparer.Ordinal);

        var nodeIds = new HashSet<string>(StringComparer.Ordinal);
        var nodeById = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        for (var index = 0; index < nodes.Count; index++)
        {
            var node = nodes[index];
            var nodeId = GetString(node, "nodeId");
            var type = GetString(node, "type") ?? string.Empty;
            var actorObjectId = GetString(node, "actorObjectId");
            var config = Object(node, "config");
            var nodePath = $"nodes[{index}]";
            if (string.IsNullOrWhiteSpace(nodeId) || !nodeIds.Add(nodeId)) result.Diagnostics.Add(Error("AF1002", "节点 ID 不能为空且必须唯一。", $"{nodePath}.nodeId", flowId, nodeId));
            else nodeById[nodeId] = node;
            if (!AllowedNodeTypes.Contains(type)) result.Diagnostics.Add(Error("AF1006", $"未注册节点类型 {type}。", $"{nodePath}.type", flowId, nodeId));
            if (!string.IsNullOrWhiteSpace(actorObjectId) && !objectIds.Contains(actorObjectId)) result.Diagnostics.Add(Error("AF1101", "actorObjectId 不存在。", $"{nodePath}.actorObjectId", flowId, nodeId));
            if (MotionNodeTypes.Contains(type) && string.IsNullOrWhiteSpace(actorObjectId)) result.Diagnostics.Add(Error("AF1101", $"{type} 必须配置执行 Actor。", $"{nodePath}.actorObjectId", flowId, nodeId));

            var compensationNodeId = GetString(node, "compensationNodeId");
            if (!string.IsNullOrWhiteSpace(compensationNodeId) && !nodes.Any(item => string.Equals(GetString(item, "nodeId"), compensationNodeId, StringComparison.Ordinal)))
                result.Diagnostics.Add(Error("AF1005", "补偿节点引用不存在。", $"{nodePath}.compensationNodeId", flowId, nodeId));

            var retry = Object(node, "retryPolicy");
            if (retry.HasValue && (!TryInt(retry.Value, "maxAttempts", out var maxAttempts) || maxAttempts < 1)) result.Diagnostics.Add(Error("AF1205", "重试次数必须是大于等于 1 的整数。", $"{nodePath}.retryPolicy.maxAttempts", flowId, nodeId));
            var timeout = Object(node, "timeoutPolicy");
            if (timeout.HasValue && !(PositiveNumber(timeout, "seconds") > 0)) result.Diagnostics.Add(Error("AF1202", "超时秒数必须大于 0。", $"{nodePath}.timeoutPolicy.seconds", flowId, nodeId));
            if (BlockingNodeTypes.Contains(type) && !timeout.HasValue && defaultTimeoutSeconds <= 0) result.Diagnostics.Add(Error("AF1202", $"{type} 是阻塞节点，必须配置有限超时策略或流程默认超时。", nodePath, flowId, nodeId));

            var workPointId = ConfigString(config, "workPointId");
            var poseId = ConfigString(config, "poseId");
            var actuatorId = ConfigString(config, "actuatorId");
            if (type == "MoveTo" && !workPointIds.Contains(workPointId)) result.Diagnostics.Add(Error("AF1103", "MoveTo 必须引用有效 WorkPoint。", $"{nodePath}.config.workPointId", flowId, nodeId));
            if (type == "MovePose" && !poseIds.Contains(poseId)) result.Diagnostics.Add(Error("AF1103", "MovePose 必须引用有效 Pose。", $"{nodePath}.config.poseId", flowId, nodeId));
            if (ActuatorNodeTypes.Contains(type) && !actuatorIds.Contains(actuatorId)) result.Diagnostics.Add(Error("AF1103", $"{type} 必须引用有效 Actuator。", $"{nodePath}.config.actuatorId", flowId, nodeId));

            if (type is "Attach" or "Detach")
            {
                var slotId = ConfigString(config, type == "Attach" ? "sourceSlotId" : "targetSlotId");
                if (!string.IsNullOrWhiteSpace(slotId) && !slotIds.Contains(slotId)) result.Diagnostics.Add(Error("AF1103", $"{type} 引用的 MaterialSlot 不存在。", nodePath, flowId, nodeId));
                var frameId = ConfigString(config, "toolFrameId");
                if (!string.IsNullOrWhiteSpace(frameId) && !toolFrameIds.Contains(frameId)) result.Diagnostics.Add(Error("AF1103", $"{type} 引用的 ToolFrame 不存在。", nodePath, flowId, nodeId));
            }
            if (type is "PrepareSlot" or "ReserveSlot" or "ReleaseSlot")
            {
                var slotId = ConfigString(config, "slotId");
                if (!slotIds.Contains(slotId)) result.Diagnostics.Add(Error("AF1103", $"{type} 必须引用有效 MaterialSlot。", $"{nodePath}.config.slotId", flowId, nodeId));
            }
            if (type is "WaitSignal" or "WaitAck" or "WriteCommand")
            {
                var bindingId = ConfigString(config, "bindingId");
                if (!bindingIds.Contains(bindingId)) result.Diagnostics.Add(Error("AF1104", $"{type} 必须引用已入库 Binding。", $"{nodePath}.config.bindingId", flowId, nodeId));
            }
            if (type is "ReserveSection" or "EnterSection" or "LeaveSection" or "SelectRoute")
            {
                var routeId = ConfigString(config, "routeId");
                if (!string.IsNullOrWhiteSpace(routeId) && !routeIds.Contains(routeId)) result.Diagnostics.Add(Error("AF1106", $"{type} 引用的路线不存在。", $"{nodePath}.config.routeId", flowId, nodeId));
            }
            if (type == "Subflow")
            {
                var subflowId = ConfigString(config, "flowId");
                if (string.IsNullOrWhiteSpace(subflowId) || !allFlowIds.Contains(subflowId) || string.Equals(subflowId, flowId, StringComparison.Ordinal))
                    result.Diagnostics.Add(Error("AF1105", "Subflow 必须引用其它已存在流程，且不能直接递归调用自身。", $"{nodePath}.config.flowId", flowId, nodeId));
            }

            var guardIds = ConfigStringArray(config, "interlockIds");
            foreach (var interlockId in guardIds.Where(item => !interlockIds.Contains(item))) result.Diagnostics.Add(Error("AF1103", $"联锁 {interlockId} 不存在。", $"{nodePath}.config.interlockIds", flowId, nodeId));
            if (type == "WriteCommand" && requireInterlockForCommands && guardIds.Count == 0) result.Diagnostics.Add(Error("AF1201", "WriteCommand 必须配置结构化安全联锁。", $"{nodePath}.config.interlockIds", flowId, nodeId));
            if (MotionNodeTypes.Contains(type) && guardIds.Count == 0) result.Diagnostics.Add(Warning("AF1201", $"{type} 未配置节点级联锁；请确认流程 Start Guard 已覆盖安全条件。", nodePath, flowId, nodeId));

            if (type is "MoveTo" or "MovePose" or "JointMove" or "AxisMove")
            {
                var speedRatio = ConfigNumber(config, "speedRatio");
                if (speedRatio.HasValue && (speedRatio <= 0 || speedRatio > 2)) result.Diagnostics.Add(Error("AF1204", "运动速度倍率必须大于 0 且不超过 2。", $"{nodePath}.config.speedRatio", flowId, nodeId));
            }
            if (config.HasValue) ScanUnsafe(config.Value, $"{nodePath}.config", flowId, nodeId, result.Diagnostics);
        }

        var edgeIds = new HashSet<string>(StringComparer.Ordinal);
        var outgoing = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var incoming = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var nodeId in nodeIds) { outgoing[nodeId] = []; incoming[nodeId] = []; }
        for (var index = 0; index < edges.Count; index++)
        {
            var edge = edges[index];
            var edgeId = GetString(edge, "edgeId");
            var source = GetString(edge, "sourceNodeId") ?? string.Empty;
            var target = GetString(edge, "targetNodeId") ?? string.Empty;
            var edgePath = $"edges[{index}]";
            if (string.IsNullOrWhiteSpace(edgeId) || !edgeIds.Add(edgeId)) result.Diagnostics.Add(Error("AF1002", "边 ID 不能为空且必须唯一。", $"{edgePath}.edgeId", flowId, edgeId: edgeId));
            if (!nodeIds.Contains(source) || !nodeIds.Contains(target)) result.Diagnostics.Add(Error("AF1005", "流程边引用了不存在的节点。", edgePath, flowId, edgeId: edgeId));
            else { outgoing[source].Add(target); incoming[target].Add(source); }
            if (edge.TryGetProperty("predicate", out var predicate) && predicate.ValueKind == JsonValueKind.Object) ValidatePredicate(predicate, manifest, declaredVariables, bindingIds, result.Diagnostics, flowId, edgeId, $"{edgePath}.predicate");
        }

        var starts = nodes.Where(item => string.Equals(GetString(item, "type"), "Start", StringComparison.Ordinal)).ToList();
        if (starts.Count != 1) result.Diagnostics.Add(Error("AF1003", "流程必须且只能包含一个 Start 节点。", null, flowId));
        if (starts.Count == 1)
        {
            var startId = GetString(starts[0], "nodeId") ?? string.Empty;
            var reachable = Reachable(startId, outgoing);
            if (!nodes.Any(item => string.Equals(GetString(item, "type"), "End", StringComparison.Ordinal) && reachable.Contains(GetString(item, "nodeId") ?? string.Empty))) result.Diagnostics.Add(Error("AF1004", "Start 不存在可达 End。", null, flowId));
            foreach (var node in nodes)
            {
                var nodeId = GetString(node, "nodeId") ?? string.Empty;
                if (!reachable.Contains(nodeId)) result.Diagnostics.Add(Warning("AF1007", $"节点 {GetString(node, "name") ?? nodeId} 不可达。", null, flowId, nodeId));
            }
        }
        if (HasCycle(nodeIds, outgoing) && maxLoopIterations <= 0) result.Diagnostics.Add(Error("AF1008", "流程存在循环但没有配置有限 maxLoopIterations。", "policies.maxLoopIterations", flowId));
        foreach (var node in nodes)
        {
            var nodeId = GetString(node, "nodeId") ?? string.Empty;
            var type = GetString(node, "type");
            if (type == "ParallelFork" && outgoing.GetValueOrDefault(nodeId, []).Count < 2) result.Diagnostics.Add(Error("AF1009", "ParallelFork 至少需要两个输出分支。", null, flowId, nodeId));
            if (type == "ParallelJoin" && incoming.GetValueOrDefault(nodeId, []).Count < 2) result.Diagnostics.Add(Error("AF1009", "ParallelJoin 至少需要两个输入分支。", null, flowId, nodeId));
        }

        if (result.Diagnostics.Any(item => string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase))) return result;

        var graphNode = JsonNode.Parse(flow.GetRawText())!.AsObject();
        graphNode.Remove("graphHash"); graphNode.Remove("compiledPlanHash");
        if (graphNode["nodes"] is JsonArray nodeArray)
        {
            foreach (var item in nodeArray.OfType<JsonObject>()) item.Remove("editor");
            var sorted = nodeArray.Select(item => item?.DeepClone()).OrderBy(item => item?["nodeId"]?.GetValue<string>() ?? string.Empty, StringComparer.Ordinal).ToArray();
            graphNode["nodes"] = new JsonArray(sorted);
        }
        if (graphNode["edges"] is JsonArray edgeArray)
        {
            var sorted = edgeArray.Select(item => item?.DeepClone()).OrderBy(item => item?["edgeId"]?.GetValue<string>() ?? string.Empty, StringComparer.Ordinal).ToArray();
            graphNode["edges"] = new JsonArray(sorted);
        }
        var graphHash = Hash(CanonicalJson(graphNode));
        var entryNodeId = starts.Count == 1 ? GetString(starts[0], "nodeId") ?? string.Empty : string.Empty;
        var compiledPlan = new JsonObject
        {
            ["flowId"] = flowId,
            ["key"] = key,
            ["name"] = name,
            ["contractVersion"] = "2.0",
            ["revision"] = TryLong(flow, "revision", out var revision) ? revision : 1,
            ["entryNodeId"] = entryNodeId,
            ["nodes"] = graphNode["nodes"]?.DeepClone(),
            ["edges"] = graphNode["edges"]?.DeepClone(),
            ["policies"] = BuildPolicies(policies, defaultTimeoutSeconds, maxLoopIterations, requireInterlockForCommands),
            ["graphHash"] = graphHash
        };
        var compiledPlanHash = Hash(CanonicalJson(compiledPlan));
        compiledPlan["compiledPlanHash"] = compiledPlanHash;
        result.Draft = new TwinActionFlowDraft
        {
            FlowKey = key!, Name = name, ContractVersion = "2.0",
            ActorScope = SerializeActorScope(flow, nodes), GraphPayload = flow.GetRawText(),
            GraphHash = graphHash, CompiledPayload = compiledPlan.ToJsonString(WebJsonOptions), CompiledPlanHash = compiledPlanHash,
            Revision = TryLong(flow, "revision", out var flowRevision) ? Math.Max(1, flowRevision) : 1,
            Enabled = !flow.TryGetProperty("enabled", out var enabled) || enabled.ValueKind != JsonValueKind.False
        };
        return result;
    }

    private static JsonObject BuildPolicies(JsonElement? policies, double timeout, int maxLoop, bool requireInterlock)
    {
        var result = policies.HasValue && policies.Value.ValueKind == JsonValueKind.Object ? JsonNode.Parse(policies.Value.GetRawText())!.AsObject() : new JsonObject();
        result["defaultTimeoutSeconds"] = Math.Max(.1, timeout);
        result["maxLoopIterations"] = Math.Max(1, maxLoop);
        result["requireInterlockForCommands"] = requireInterlock;
        return result;
    }

    private static string SerializeActorScope(JsonElement flow, List<JsonElement> nodes)
    {
        var actors = new HashSet<string>(StringComparer.Ordinal);
        if (flow.TryGetProperty("actorObjectIds", out var configured) && configured.ValueKind == JsonValueKind.Array)
            foreach (var item in configured.EnumerateArray()) if (item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString())) actors.Add(item.GetString()!);
        foreach (var node in nodes) { var actor = GetString(node, "actorObjectId"); if (!string.IsNullOrWhiteSpace(actor)) actors.Add(actor); }
        return JsonSerializer.Serialize(actors.OrderBy(item => item, StringComparer.Ordinal).ToArray(), WebJsonOptions);
    }

    private static void ValidatePredicate(JsonElement group, JsonElement manifest, HashSet<string> variables, HashSet<string> bindings, List<TwinValidationDiagnosticDto> diagnostics, string? flowId, string? edgeId, string path)
    {
        if (!group.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return;
        var i = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) { i++; continue; }
            if (item.TryGetProperty("logic", out _)) ValidatePredicate(item, manifest, variables, bindings, diagnostics, flowId, edgeId, $"{path}.items[{i}]");
            else
            {
                var source = GetString(item, "source"); var reference = GetString(item, "ref");
                if (string.IsNullOrWhiteSpace(reference)) diagnostics.Add(Error("AF1005", "条件谓词必须引用 binding/variable/material/runtime 字段。", $"{path}.items[{i}].ref", flowId, edgeId: edgeId));
                else if (source == "binding" && !bindings.Contains(reference)) diagnostics.Add(Error("AF1104", $"条件引用的 Binding {reference} 不存在。", path, flowId, edgeId: edgeId));
                else if (source == "variable" && !variables.Contains(reference)) diagnostics.Add(Error("AF1005", $"条件引用的变量 {reference} 未声明。", path, flowId, edgeId: edgeId));
            }
            i++;
        }
    }

    private static void ScanUnsafe(JsonElement value, string path, string? flowId, string? nodeId, List<TwinValidationDiagnosticDto> diagnostics)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString()?.Trim() ?? string.Empty;
            if (ExternalUrlPattern.IsMatch(text)) diagnostics.Add(Error("AF1302", "流程配置不允许直接保存外部 URL、data URL 或脚本 URL。", path, flowId, nodeId));
            return;
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            var i = 0; foreach (var item in value.EnumerateArray()) { ScanUnsafe(item, $"{path}[{i}]", flowId, nodeId, diagnostics); i++; }
            return;
        }
        if (value.ValueKind != JsonValueKind.Object) return;
        foreach (var property in value.EnumerateObject())
        {
            if (CredentialKeyPattern.IsMatch(property.Name)) diagnostics.Add(Error("AF1303", "流程配置不允许保存密码、Token、Secret、API Key 或连接串。", $"{path}.{property.Name}", flowId, nodeId));
            if (property.Name.Equals("script", StringComparison.OrdinalIgnoreCase) || property.Name.Equals("function", StringComparison.OrdinalIgnoreCase) || property.Name.Equals("javascript", StringComparison.OrdinalIgnoreCase)) diagnostics.Add(Error("AF1301", "流程配置不允许函数、脚本或可执行表达式。", $"{path}.{property.Name}", flowId, nodeId));
            ScanUnsafe(property.Value, $"{path}.{property.Name}", flowId, nodeId, diagnostics);
        }
    }

    private static HashSet<string> Reachable(string start, Dictionary<string, List<string>> outgoing)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal); var queue = new Queue<string>(); queue.Enqueue(start);
        while (queue.Count > 0) { var current = queue.Dequeue(); if (!visited.Add(current)) continue; foreach (var next in outgoing.GetValueOrDefault(current, [])) queue.Enqueue(next); }
        return visited;
    }

    private static bool HasCycle(IEnumerable<string> ids, Dictionary<string, List<string>> outgoing)
    {
        var state = new Dictionary<string, byte>(StringComparer.Ordinal);
        bool Visit(string id) { var current = state.GetValueOrDefault(id); if (current == 1) return true; if (current == 2) return false; state[id] = 1; foreach (var next in outgoing.GetValueOrDefault(id, [])) if (Visit(next)) return true; state[id] = 2; return false; }
        return ids.Any(Visit);
    }

    private static string CanonicalJson(JsonNode? node)
    {
        JsonNode? Normalize(JsonNode? value)
        {
            if (value is JsonArray array) return new JsonArray(array.Select(Normalize).ToArray());
            if (value is JsonObject obj)
            {
                var normalized = new JsonObject();
                foreach (var property in obj.OrderBy(item => item.Key, StringComparer.Ordinal))
                {
                    if (property.Key is "editor" or "graphHash" or "compiledPlanHash") continue;
                    normalized[property.Key] = Normalize(property.Value);
                }
                return normalized;
            }
            return value?.DeepClone();
        }
        return Normalize(node)?.ToJsonString(WebJsonOptions) ?? "null";
    }

    private static string Hash(string text)
    {
        const ulong offset = 14695981039346656037UL; const ulong prime = 1099511628211UL; var hash = offset;
        foreach (var ch in text) { hash ^= ch; hash = unchecked(hash * prime); }
        return $"fnv1a64:{hash:x16}";
    }

    private static List<JsonElement> Array(JsonElement parent, string name) => parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).Select(item => item.Clone()).ToList() : [];
    private static JsonElement? Object(JsonElement parent, string name) => parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value.Clone() : null;
    private static HashSet<string> IdSet(JsonElement parent, string arrayName, string idName) => new(Array(parent, arrayName).Select(item => GetString(item, idName)).Where(item => !string.IsNullOrWhiteSpace(item))!, StringComparer.Ordinal);
    private static string? GetString(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string ConfigString(JsonElement? config, string name) => config.HasValue ? GetString(config.Value, name)?.Trim() ?? string.Empty : string.Empty;
    private static List<string> ConfigStringArray(JsonElement? config, string name) => config.HasValue && config.Value.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).Select(item => item!).ToList() : [];
    private static double? ConfigNumber(JsonElement? config, string name) => config.HasValue && config.Value.TryGetProperty(name, out var value) && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;
    private static double? PositiveNumber(JsonElement? element, string name) => element.HasValue && element.Value.TryGetProperty(name, out var value) && value.TryGetDouble(out var number) && double.IsFinite(number) && number > 0 ? number : null;
    private static int? PositiveInt(JsonElement? element, string name) => element.HasValue && TryInt(element.Value, name, out var value) && value > 0 ? value : null;
    private static bool TryInt(JsonElement element, string name, out int value) { value = default; return element.TryGetProperty(name, out var item) && item.TryGetInt32(out value); }
    private static bool TryLong(JsonElement element, string name, out long value) { value = default; return element.TryGetProperty(name, out var item) && item.TryGetInt64(out value); }

    private static TwinValidationDiagnosticDto Error(string code, string message, string? path = null, string? flowId = null, string? nodeId = null, string? edgeId = null) => new() { Severity = "error", Code = code, Message = message, Path = path, FlowId = flowId, NodeId = nodeId, EdgeId = edgeId };
    private static TwinValidationDiagnosticDto Warning(string code, string message, string? path = null, string? flowId = null, string? nodeId = null, string? edgeId = null) => new() { Severity = "warning", Code = code, Message = message, Path = path, FlowId = flowId, NodeId = nodeId, EdgeId = edgeId };
}

internal sealed class TwinActionFlowServerInspection
{
    public List<TwinActionFlowDraft> ActionFlows { get; } = [];
    public List<TwinValidationDiagnosticDto> Diagnostics { get; } = [];
}

internal sealed class TwinActionFlowServerCompileResult
{
    public TwinActionFlowDraft? Draft { get; set; }
    public List<TwinValidationDiagnosticDto> Diagnostics { get; } = [];
}

internal sealed class TwinActionFlowDraft
{
    public string FlowKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ContractVersion { get; set; } = "2.0";
    public string ActorScope { get; set; } = "[]";
    public string GraphPayload { get; set; } = "{}";
    public string GraphHash { get; set; } = string.Empty;
    public string CompiledPayload { get; set; } = "{}";
    public string CompiledPlanHash { get; set; } = string.Empty;
    public long Revision { get; set; } = 1;
    public bool Enabled { get; set; } = true;
}
