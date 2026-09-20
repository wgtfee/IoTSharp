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
        "ManualConfirm", "RaiseAlarm", "Compensate",
        "WaitStation", "CompleteStation", "WaitInterlock", "SetState", "MarkMaterial", "Loop", "Pick", "Place"
    };
    private static readonly HashSet<string> BlockingNodeTypes = new(StringComparer.Ordinal)
        { "ReserveSlot", "ReserveSection", "WaitSignal", "WaitAck", "ManualConfirm", "Deadline", "WriteCommand", "WaitStation", "WaitInterlock" };
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
        var sceneFlow = ConfigString(policies, "executionTarget") == "scene";
        if (sceneFlow)
        {
            var modes = ConfigStringArray(policies, "allowedRuntimeModes");
            if (modes.Count != 1 || modes[0] != "simulation") result.Diagnostics.Add(Error("AF1401", "三维联动节点只允许 simulation；不得作为 Live 设备流程运行。", "policies", flowId));
            if (Array(manifest, "behaviors").Any(b => !b.TryGetProperty("enabled", out var enabled) || enabled.ValueKind != JsonValueKind.False)) result.Diagnostics.Add(Error("AF1402", "三维动作流场景不能混用启用中的 V1 序列，请完整迁移或停用旧序列。", "behaviors", flowId));
        }

        var variableNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var variable in Array(flow, "variables"))
        {
            var variableName = GetString(variable, "name") ?? ""; var variableType = GetString(variable, "type");
            var validValue = !variable.TryGetProperty("initialValue", out var initial) || variableType == "json" || variableType == "string" && initial.ValueKind == JsonValueKind.String || variableType == "number" && initial.ValueKind == JsonValueKind.Number || variableType == "boolean" && (initial.ValueKind is JsonValueKind.True or JsonValueKind.False);
            if (string.IsNullOrWhiteSpace(variableName) || !variableNames.Add(variableName) || (variableName is "__proto__" or "constructor" or "prototype") || variableType is not ("string" or "number" or "boolean" or "json") || !validValue) result.Diagnostics.Add(Error("AF1408", "变量名必须唯一且非保留名，初始值必须符合声明类型。", "variables", flowId));
        }

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
            if (type == "Condition")
            {
                var predicate = config.HasValue ? Object(config.Value, "predicate") : null;
                if (!predicate.HasValue) result.Diagnostics.Add(Error("AF1409", "条件节点必须配置结构化条件。", $"{nodePath}.config.predicate", flowId, nodeId));
                else ValidatePredicate(predicate.Value, manifest, declaredVariables, bindingIds, result.Diagnostics, flowId, null, $"{nodePath}.config.predicate", sceneFlow);
            }
            if (sceneFlow && config.HasValue) ValidateSceneNode(node, config.Value, manifest, flow, declaredVariables, workPointIds, slotIds, interlockIds, result.Diagnostics, flowId);
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
            if (edge.TryGetProperty("predicate", out var predicate)) ValidatePredicate(predicate, manifest, declaredVariables, bindingIds, result.Diagnostics, flowId, edgeId, $"{edgePath}.predicate", sceneFlow);
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

        if (sceneFlow) foreach (var node in nodes)
        {
            var nodeId = GetString(node, "nodeId");
            var type = GetString(node, "type");
            var ports = type == "End" ? System.Array.Empty<string>() : type == "Condition" ? new[] { "true", "false" } : type == "Loop" ? new[] { "repeat", "done" } : new[] { "success" };
            foreach (var port in ports) if (!edges.Any(e => GetString(e, "sourceNodeId") == nodeId && GetString(e, "sourcePort") == port)) result.Diagnostics.Add(Error("AF1407", $"节点缺少 {port} 连线，禁止断图假完成。", "edges", flowId, nodeId));
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
            ["variables"] = graphNode["variables"]?.DeepClone() ?? new JsonArray(),
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

    /// <summary>验证三维联动节点引用；与客户端一致地拒绝断图、假动作和错误工位归属。</summary>
    private static void ValidateSceneNode(JsonElement node, JsonElement config, JsonElement manifest, JsonElement flow, HashSet<string> variables, HashSet<string> workPoints, HashSet<string> slots, HashSet<string> interlocks, List<TwinValidationDiagnosticDto> diagnostics, string? flowId)
    {
        var type = GetString(node, "type") ?? ""; var nodeId = GetString(node, "nodeId"); var actor = GetString(node, "actorObjectId");
        var supported = new HashSet<string>(new[] { "Start", "End", "Merge", "Condition", "Loop", "Delay", "WaitStation", "CompleteStation", "WaitInterlock", "SetState", "MarkMaterial", "SelectRoute", "MoveTo", "MovePose", "JointMove", "AxisMove", "Home", "GripOpen", "GripClose", "Attach", "Detach", "Pick", "Place", "PrepareSlot", "RaiseAlarm" });
        void Reject(string code, string message) => diagnostics.Add(Error(code, message, "config", flowId, nodeId));
        bool ReadOnly(string reference) { var key = reference.Trim(); return key.StartsWith("material/", StringComparison.Ordinal) || key.StartsWith("binding:", StringComparison.Ordinal) || key.StartsWith("station.", StringComparison.Ordinal) || Array(manifest,"bindings").Any(b=>GetString(b,"bindingId")==key); }
        var safety = new HashSet<string>(new[] { "MoveTo", "MovePose", "JointMove", "AxisMove", "Home", "GripOpen", "GripClose", "Attach", "Detach", "Pick", "Place", "PrepareSlot", "WaitInterlock", "WaitStation", "CompleteStation", "MarkMaterial", "SelectRoute" });
        var timeoutPolicy = Object(node,"timeoutPolicy");
        if (safety.Contains(type) && ((timeoutPolicy.HasValue && (GetString(timeoutPolicy.Value,"onTimeout") ?? "fault") != "fault") || ConfigNumber(Object(node,"retryPolicy"),"maxAttempts") > 1 || !string.IsNullOrEmpty(GetString(node,"compensationNodeId")) || Array(flow,"edges").Any(e=>GetString(e,"sourceNodeId")==nodeId && (GetString(e,"sourcePort") is "failure" or "timeout")))) Reject("AF1414","安全动作只允许超时/失败停机，禁止跳过、自动重试或错误分支绕行。");
        foreach (var key in new[] { "onStartState", "onCompleteState" }) if (Array(config,key).Any(a=>ReadOnly(GetString(a,"source") ?? ""))) Reject("AF1411","绑定、物料及工位状态只读，禁止动作赋值。");
        if (!supported.Contains(type)) Reject("AF1403", $"{type} 未提供三维执行适配器，不能以计时假完成。");
        if (type is "AxisMove" or "JointMove" or "GripOpen" or "GripClose")
        {
            var axis = Array(manifest,"actuators").FirstOrDefault(a=>GetString(a,"actuatorId")==ConfigString(config,"actuatorId"));
            if (axis.ValueKind == JsonValueKind.Object)
            {
                if (GetString(axis,"objectId") != actor || ((type is "GripOpen" or "GripClose") && GetString(axis,"kind") != "gripper")) Reject("AF1413","执行轴必须属于当前设备且夹具类型匹配。");
                if (type is "AxisMove" or "JointMove")
                {
                    if (!config.TryGetProperty("targetValue",out var target) || target.ValueKind != JsonValueKind.Number || !target.TryGetDouble(out var number) || !double.IsFinite(number)
                        || (axis.TryGetProperty("minValue",out var min) && min.TryGetDouble(out var lo) && number < lo)
                        || (axis.TryGetProperty("maxValue",out var max) && max.TryGetDouble(out var hi) && number > hi)) Reject("AF1413","运动目标必须符合声明行程。");
                }
            }
        }
        if ((type is "WaitStation" or "CompleteStation" or "MarkMaterial" or "SelectRoute" or "Pick" or "Place" or "Attach" or "Detach" or "PrepareSlot") && string.IsNullOrWhiteSpace(actor)) Reject("AF1101", "节点必须指定执行设备。");
        if (type is "WaitStation" or "CompleteStation")
        {
            var group = ConfigString(config, "completionGroup");
            var found = Array(manifest, "routes").SelectMany(r => Array(r, "points")).Any(p => GetString(p, "componentObjectId") == actor && Object(p, "process") is JsonElement process &&
                (ConfigStringArray(process, "behaviorCompletionGroups").Contains(group) || ConfigNumber(Object(process, "behaviorCompletionRequirements"), group) > 0));
            if (string.IsNullOrWhiteSpace(group) || !found) Reject("AF1404", "节点必须引用设备工位已有的完成组。");
        }
        if (type == "WaitInterlock" && !interlocks.Contains(ConfigString(config, "interlockId"))) Reject("AF1103", "等待联锁引用不存在。");
        if (type == "SetState" && ConfigString(config,"scope") == "semantic" && ReadOnly(ConfigString(config,"ref"))) Reject("AF1411", "绑定、物料及工位状态只读，禁止写入。");
        if (type is "Attach" or "Detach" or "Pick" or "Place")
        {
            var pick = type is "Attach" or "Pick";
            var slot = Array(manifest,"materialSlots").FirstOrDefault(s => GetString(s,"slotId") == ConfigString(config,pick ? "sourceSlotId" : "targetSlotId"));
            var point = Array(manifest,"workPoints").FirstOrDefault(p => GetString(p,"workPointId") == ConfigString(config,"workPointId"));
            var frameId = ConfigString(config,"toolFrameId");
            if (string.IsNullOrWhiteSpace(frameId) && point.ValueKind == JsonValueKind.Object) frameId = GetString(point,"toolFrameId") ?? "";
            var frame = Array(manifest,"toolFrames").FirstOrDefault(f => GetString(f,"toolFrameId") == frameId);
            var payloadType = ConfigString(config,"payloadType");
            var slotType = slot.ValueKind == JsonValueKind.Object ? GetString(slot,"payloadType") : null;
            if (string.IsNullOrEmpty(payloadType) && pick) payloadType = slotType ?? "";
            var toolTypes = frame.ValueKind == JsonValueKind.Object ? ConfigStringArray(frame,"payloadTypes") : new List<string>();
            if (!string.IsNullOrEmpty(payloadType) && ((!string.IsNullOrEmpty(slotType) && slotType != payloadType) || (toolTypes.Any() && !toolTypes.Contains(payloadType)))) Reject("AF1412","物料类型必须与槽位及工具允许类型一致。");
            if (slot.ValueKind != JsonValueKind.Object || frame.ValueKind != JsonValueKind.Object || GetString(frame,"objectId") != actor
                || (point.ValueKind == JsonValueKind.Object && (GetString(point,"materialSlotId") != GetString(slot,"slotId") || GetString(point,"toolFrameId") != frameId))
                || (pick ? GetString(slot,"role") == "target" : GetString(slot,"role") == "source")) Reject("AF1412", "物料交接必须引用角色正确的槽位、当前设备 TCP 和一致的工作点。");
            if (config.TryGetProperty("payloadCount", out var count) && (count.ValueKind != JsonValueKind.Number || !count.TryGetInt32(out var n) || n < 1)) Reject("AF1412", "抓取数量必须为正整数。");
        }
        if ((type is "Pick" or "Place") && (!workPoints.Contains(ConfigString(config, "workPointId")) || !slots.Contains(ConfigString(config, type == "Pick" ? "sourceSlotId" : "targetSlotId")))) Reject("AF1103", "抓放节点必须引用有效工作点和物料槽位。");
        if (type == "SetState" && ((ConfigString(config, "scope") is not ("variable" or "semantic")) || string.IsNullOrWhiteSpace(ConfigString(config, "ref")) || (ConfigString(config, "ref") is "__proto__" or "constructor" or "prototype") || !config.TryGetProperty("value", out _) || (ConfigString(config, "scope") == "variable" && !variables.Contains(ConfigString(config, "ref"))))) Reject("AF1405", "状态节点需要有效范围、语义键或已声明变量以及状态值。");
        if (type == "MarkMaterial" && string.IsNullOrWhiteSpace(ConfigString(config, "stage"))) Reject("AF1405", "工艺标记不能为空。");
        if (type == "SelectRoute" && !Array(manifest, "routes").Where(r => GetString(r, "routeId") == ConfigString(config, "routeId")).SelectMany(r => Array(r, "edges")).Any(e => GetString(e, "edgeId") == ConfigString(config, "edgeId") && GetString(e, "fromPointId") == ConfigString(config, "junctionPointId") && (!e.TryGetProperty("enabled", out var enabled) || enabled.ValueKind != JsonValueKind.False))) Reject("AF1106", "必须选择路线中真实存在的岔口出边。");
        if (config.TryGetProperty("alignPayloadGrid", out var grid) && grid.ValueKind == JsonValueKind.True && (type != "MoveTo" || string.IsNullOrWhiteSpace(ConfigString(config, "sourceSlotId")) == string.IsNullOrWhiteSpace(ConfigString(config, "targetSlotId")) || ConfigNumber(config, "payloadCount") > 12)) Reject("AF1406", "变距需唯一来源或目标，不能超出 12 抓位。");
        foreach (var key in new[] { "payloadCount", "minimumPayloadCount", "durationSeconds" }) if (config.TryGetProperty(key, out var value) && (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number) || number < 0)) Reject("AF1406", $"{key} 必须为有限非负数。");
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

    private static void ValidatePredicate(JsonElement group, JsonElement manifest, HashSet<string> variables, HashSet<string> bindings, List<TwinValidationDiagnosticDto> diagnostics, string? flowId, string? edgeId, string path, bool requireNonEmpty = false, int depth = 0)
    {
        if (group.ValueKind != JsonValueKind.Object || depth >= 32 || (GetString(group, "logic") is not ("and" or "or")) || !group.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array || (requireNonEmpty && items.GetArrayLength() == 0)) { diagnostics.Add(Error("AF1409", "条件组必须配置有效逻辑及条件列表。", path, flowId, edgeId:edgeId)); return; }
        var i = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) { diagnostics.Add(Error("AF1409", "条件项必须为结构化对象。", path, flowId, edgeId:edgeId)); i++; continue; }
            if (item.TryGetProperty("logic", out _)) ValidatePredicate(item, manifest, variables, bindings, diagnostics, flowId, edgeId, $"{path}.items[{i}]", requireNonEmpty, depth+1);
            else
            {
                var source = GetString(item, "source"); var reference = GetString(item, "ref");
                if ((source is not ("binding" or "variable" or "material" or "runtime")) || (GetString(item, "operator") is not ("eq" or "ne" or "gt" or "gte" or "lt" or "lte" or "in" or "changed" or "risingEdge" or "truthy" or "falsy"))) diagnostics.Add(Error("AF1409", "条件数据来源或比较方式无效。", path, flowId, edgeId:edgeId));
                if (string.IsNullOrWhiteSpace(reference)) diagnostics.Add(Error("AF1005", "条件谓词必须引用 binding/variable/material/runtime 字段。", $"{path}.items[{i}].ref", flowId, edgeId: edgeId));
                else if (source == "binding" && !bindings.Contains(reference)) diagnostics.Add(Error("AF1104", $"条件引用的 Binding {reference} 不存在。", path, flowId, edgeId: edgeId));
                else if (source == "variable" && !variables.Contains(reference)) diagnostics.Add(Error("AF1005", $"条件引用的变量 {reference} 未声明。", path, flowId, edgeId: edgeId));
                else if (requireNonEmpty && (source is "runtime" or "material") && !ValidMaterialStateRef(reference, manifest)) diagnostics.Add(Error("AF1410", "物料条件引用的槽位、TCP、夹具或状态字段不存在。", path, flowId, edgeId:edgeId));
            }
            i++;
        }
    }

    /// <summary>只读物料状态引用，与前端相同：不存在的状态不能保存成永远等不到的条件。</summary>
    private static bool ValidMaterialStateRef(string reference, JsonElement manifest)
    {
        if (!reference.StartsWith("material/", StringComparison.Ordinal)) return true;
        string[] parts;
        try { parts = reference.Split('/').Skip(1).Select(Uri.UnescapeDataString).ToArray(); } catch (UriFormatException) { return false; }
        if (parts.Length < 3) return false;
        bool Has(string collection, string key, string id) => Array(manifest,collection).Any(v=>GetString(v,key)==id);
        return parts[0] switch
        {
            "slot" => parts.Length==3 && Has("materialSlots","slotId",parts[1]) && (parts[2] is "present" or "availableCount" or "freeCapacity" or "occupied"),
            "tool" => parts.Length==3 && Has("toolFrames","toolFrameId",parts[1]) && (parts[2] is "empty" or "heldCount"),
            "gripper" => parts.Length==3 && parts[2]=="closed" && Array(manifest,"actuators").Any(a=>GetString(a,"actuatorId")==parts[1] && GetString(a,"kind")=="gripper"),
            "contact" => parts.Length==4 && parts[3]=="ready" && Has("toolFrames","toolFrameId",parts[1]) && Has("materialSlots","slotId",parts[2]),
            _ => false
        };
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
    private static double? ConfigNumber(JsonElement? config, string name) => config.HasValue && config.Value.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;
    private static double? PositiveNumber(JsonElement? element, string name) => element.HasValue && element.Value.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) && number > 0 ? number : null;
    private static int? PositiveInt(JsonElement? element, string name) => element.HasValue && TryInt(element.Value, name, out var value) && value > 0 ? value : null;
    private static bool TryInt(JsonElement element, string name, out int value) { value = default; return element.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out value); }
    private static bool TryLong(JsonElement element, string name, out long value) { value = default; return element.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out value); }

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
