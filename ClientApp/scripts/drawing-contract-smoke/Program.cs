using System.Text.Json;
using System.Text.Json.Nodes;
using IoTSharp.Contracts;
using IoTSharp.Services.DigitalTwin;

// 直接链接生产校验器；不依赖 WebHost、数据库或 Testcontainers，不替代真实入库测试。
var root = JsonNode.Parse(File.ReadAllText(args[0]))!.AsObject();
var objects = root["objects"]!.AsArray();
var resources = objects.Select(o => o!["component"]!["resourceKey"]!.GetValue<string>()).Distinct().ToDictionary(k => k, _ => Guid.NewGuid());
var assetId = Guid.NewGuid();
root["resources"] = new JsonArray(resources.Select(p => (JsonNode)new JsonObject { ["resourceId"] = p.Value.ToString(), ["name"] = p.Key, ["status"] = "ready" }).ToArray());
foreach (var item in objects) { item!["resourceId"] = resources[item["component"]!["resourceKey"]!.GetValue<string>()].ToString(); item["assetId"] = assetId.ToString(); }
using var document = JsonDocument.Parse(root.ToJsonString());
var result = TwinManifestInspector.Inspect(document.RootElement, Guid.NewGuid(), assetId);
if (!result.Valid) throw new Exception(string.Join("; ", result.Diagnostics.Select(d => $"{d.Code}: {d.Message} ({d.Path})")));
if (result.Bindings.Count(b => b.SourceKind == TwinBindingSourceKind.Resource) != 98 || result.Routes.Count != 2 || result.Components.Count != 98) throw new Exception("资源、组件或路线绑定提取数量不匹配");
using var normalized = JsonDocument.Parse(result.NormalizedPayload);
if (normalized.RootElement.GetProperty("behaviors").GetArrayLength() != 0 || result.ActionFlows.Count != 7 || !normalized.RootElement.GetProperty("routes")[0].GetProperty("replanUpcomingJunctions").GetBoolean()) throw new Exception("动作图工艺字段未保留");
// 使用生产校验器执行反例；错误配置应返回明确诊断，不能保存后才卡住或返回 500。
var millimeterScene = (JsonObject)root.DeepClone();
millimeterScene["actuators"]!.AsArray().First(a => a!["kind"]!.GetValue<string>() == "linear-axis")!["unit"] = "millimeter";
using (var millimeterInput = JsonDocument.Parse(millimeterScene.ToJsonString()))
{
    var inspected = TwinManifestInspector.Inspect(millimeterInput.RootElement, Guid.NewGuid(), assetId);
    if (!inspected.Valid) throw new Exception("毫米直线轴必须能通过服务端保存校验：" + string.Join("; ", inspected.Diagnostics.Select(d => d.Code)));
    using var persistedUnits = JsonDocument.Parse(inspected.NormalizedPayload);
    if (!persistedUnits.RootElement.GetProperty("actuators").EnumerateArray().Any(a => a.GetProperty("unit").GetString() == "millimeter")) throw new Exception("归一化后丢失毫米单位");
}
JsonNode Batch(JsonObject scene) => scene["routes"]![0]!["points"]!.AsArray().First(p => p?["process"]?["batchSize"]?.GetValue<int>() == 12)!["process"]!;
JsonNode Node(JsonObject scene, string id) => scene["actionFlows"]![0]!["nodes"]!.AsArray().First(n => n!["nodeId"]!.GetValue<string>() == id)!;
var invalidCases = new (string Code, Action<JsonObject> Change)[]
{
    ("AF1414", s => Node(s,"left-approach")["timeoutPolicy"]!["onTimeout"] = "skip"),
    ("AF1414", s => Node(s,"left-approach")["retryPolicy"] = new JsonObject { ["maxAttempts"]=2,["backoffSeconds"]=1 }),
    ("AF1414", s => Node(s,"left-approach")["compensationNodeId"] = "end"),
    ("AF1414", s => s["actionFlows"]![0]!["edges"]!.AsArray().Add(new JsonObject { ["edgeId"]="unsafe-timeout",["sourceNodeId"]="left-approach",["sourcePort"]="timeout",["targetNodeId"]="end" })),
    ("AF1411", s => Node(s,"left-next")["config"] = new JsonObject { ["scope"]="semantic",["ref"]=" binding:permit ",["value"]=true }),
    ("AF1411", s => Node(s,"left-approach")["config"]!["onStartState"] = new JsonArray(new JsonObject { ["source"]="binding:permit",["value"]=true })),
    ("AF1411", s => Node(s,"left-approach")["config"]!["onCompleteState"] = new JsonArray(new JsonObject { ["source"]="station.materialCount",["value"]=12 })),
    ("AF1412", s => Node(s,"left-attach")["config"]!["payloadType"] = "separator"),
    ("AF1412", s => s["toolFrames"]!.AsArray().First(f=>f!["objectId"]!.GetValue<string>()=="drawing-loading-robot")!["payloadTypes"] = new JsonArray("separator")),
    ("AF1412", s => Node(s,"left-place")["config"]!["payloadType"] = "separator"),
    ("AF1410", s => Node(s,"side")["config"]!["predicate"]!["items"]![0] = new JsonObject { ["source"]="runtime",["ref"]="material/slot/missing/occupied",["operator"]="truthy" }),
    ("AF1411", s => Node(s,"left-next")["config"] = new JsonObject { ["scope"]="semantic",["ref"]="material/tool/fake/empty",["value"]=true }),
    ("AF1412", s => Node(s,"left-attach")["config"]!["sourceSlotId"] = "missing"),
    ("AF1412", s => Node(s,"left-attach")["config"]!["toolFrameId"] = "drawing-stacking-gantry:gantry-yarn-tcp"),
    ("AF1412", s => Node(s,"left-attach")["config"]!["payloadCount"] = 1.5),
    ("AF1413", s => { Node(s,"left-close")["type"]="AxisMove"; Node(s,"left-close")["config"] = new JsonObject { ["actuatorId"]="drawing-loading-robot:robot-j1",["targetValue"]=10000 }; }),
    ("twin.behavior.actuator.unit.invalid", s => s["actuators"]![0]!["unit"] = "inch"),
    ("twin.behavior.actuator.linear-unit.invalid", s => s["actuators"]!.AsArray().First(a => a!["kind"]!.GetValue<string>() == "linear-axis")!["unit"] = "degree"),
    ("twin.behavior.actuator.rotary-unit.invalid", s => s["actuators"]!.AsArray().First(a => a!["kind"]!.GetValue<string>() == "rotary-joint")!["unit"] = "millimeter"),
    ("twin.behavior.actuator.gripper-unit.invalid", s => s["actuators"]!.AsArray().First(a => a!["kind"]!.GetValue<string>() == "gripper")!["unit"] = "meter"),
    ("twin.behavior.tool-frame.cartesian.invalid", s => s["toolFrames"]![0]!["cartesianActuatorIds"] = new JsonArray("missing-axis")),
    ("twin.behavior.tool-frame.cartesian.invalid", s => s["toolFrames"]![0]!["cartesianActuatorIds"] = true),
    ("twin.behavior.tool-frame.cartesian.invalid", s => s["toolFrames"]![0]!["cartesianActuatorIds"] = new JsonArray(s["toolFrames"]!.AsArray().First(f => f?["cartesianActuatorIds"] is JsonArray)!["cartesianActuatorIds"]![0]!.DeepClone())),
    ("AF1406", s => Node(s,"left-prepare")["config"]!["alignPayloadGrid"] = true),
    ("AF1406", s => Node(s,"left-approach")["config"]!["targetSlotId"] = "drawing-loading-target"),
    ("AF1406", s => Node(s,"left-approach")["config"]!["payloadCount"] = 13),
    ("AF1404", s => Node(s,"arrive")["config"]!["completionGroup"] = "missing"),
    ("AF1407", s => s["actionFlows"]![0]!["edges"]!.AsArray().RemoveAt(0)),
    ("AF1401", s => s["actionFlows"]![0]!["policies"]!["allowedRuntimeModes"] = new JsonArray("live")),
    ("AF1403", s => Node(s,"left-prepare")["type"] = "Subflow"),
    ("AF1409", s => Node(s,"side")["config"]!["predicate"] = new JsonObject { ["logic"]="and",["items"]=new JsonArray() }),
    ("AF1409", s => Node(s,"side")["config"]!["predicate"] = new JsonObject { ["logic"]="and",["items"]=new JsonArray((JsonNode?)null) }),
    ("AF1005", s => Node(s,"side")["config"]!["predicate"]!["items"]![0]!["ref"] = "missing-variable"),
    ("AF1408", s => s["actionFlows"]![0]!["variables"]![0]!["name"] = "__proto__"),
    ("AF1408", s => s["actionFlows"]![0]!["variables"]![0]!["initialValue"] = "true"),
    ("AF1402", s => s["behaviors"] = new JsonArray(new JsonObject { ["behaviorId"]="conflict",["name"]="冲突控制",["actorObjectId"]="drawing-loading-robot",["enabled"]=true,["actions"]=new JsonArray(new JsonObject { ["actionId"]="wait",["kind"]="wait" }) })),
    ("twin.route.batch.size.invalid", s => Batch(s)["batchLaneSize"] = 13),
    ("twin.route.batch.size.invalid", s => Batch(s)["batchLaneSize"] = "six"),
    ("twin.route.batch.capacity.invalid", s => Batch(s)["batchLaneSize"] = 5),
    ("twin.route.batch.mode.invalid", s => Batch(s)["batchArrivalMode"] = ""),
    ("twin.route.batch.admission.invalid", s => Batch(s)["materialAdmission"] = false),
    ("twin.route.batch.stage.invalid", s => Batch(s)["materialStageOnComplete"] = new JsonObject()),
    ("twin.route.replan.invalid", s => s["routes"]![0]!["curveKind"] = "catmull-rom"),
    ("twin.runtime.transport-properties.invalid", s => s["runtime"]!["routePalletInitializers"]![0]!["transportUnitProperties"] = new JsonObject { ["length"] = new JsonObject() }),
    ("twin.runtime.hide-exit.invalid", s => s["runtime"]!["routePalletInitializers"]![0]!["simulationHideAtExit"] = "true"),
};
foreach (var (code, change) in invalidCases)
{
    var invalid = (JsonObject)root.DeepClone(); change(invalid);
    using var input = JsonDocument.Parse(invalid.ToJsonString());
    var inspection = TwinManifestInspector.Inspect(input.RootElement, Guid.NewGuid(), assetId);
    if (inspection.Valid || !inspection.Diagnostics.Any(d => d.Code == code)) throw new Exception($"未拒绝错误配置：{code}");
}
// 与前端共用声明反例，验证生产保存/发布检查器的错误码和归一化往返。
JsonNode TargetSlot(JsonObject scene) => scene["materialSlots"]!.AsArray().First(s => s!["slotId"]!.GetValue<string>() == "drawing-cart-left")!;
JsonNode TargetTool(JsonObject scene) => scene["toolFrames"]!.AsArray().First(f => f!["objectId"]!.GetValue<string>() == "drawing-loading-robot")!;
TwinManifestInspection InspectTarget(JsonObject scene)
{
    using var input = JsonDocument.Parse(scene.ToJsonString());
    return TwinManifestInspector.Inspect(input.RootElement, Guid.NewGuid(), assetId);
}
var declared = (JsonObject)root.DeepClone();
TargetSlot(declared)["contactNormalLocal"] = new JsonArray(0, 1, 0);
TargetTool(declared)["approachDirectionLocal"] = new JsonArray(0, -1, 0);
TargetTool(declared)["payloadTypes"] = new JsonArray("silk-cake");
TargetSlot(declared)["toolTargets"] = new JsonArray(new JsonObject
{
    ["contractVersion"] = "slot-tool-target/1", ["templateId"] = "top",
    ["toolFrameId"] = TargetTool(declared)["toolFrameId"]!.DeepClone(), ["payloadType"] = "silk-cake",
    ["tcpOffset"] = new JsonArray(0.2, 0, 0), ["tcpRotation"] = new JsonArray(0, 0, 0),
    ["approachDistance"] = 0.3, ["retreatDistance"] = 0.4
});
var inspectedTarget = InspectTarget(declared);
if (!inspectedTarget.Valid) throw new Exception("有效派生声明被拒绝：" + string.Join("; ", inspectedTarget.Diagnostics.Select(d => d.Code)));
var restoredTarget = JsonNode.Parse(inspectedTarget.NormalizedPayload)!.AsObject();
if (!JsonNode.DeepEquals(TargetSlot(restoredTarget)["toolTargets"], TargetSlot(declared)["toolTargets"])) throw new Exception("归一化丢失槽位派生声明");
var sharedTargetCases = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "slot-tool-target-cases.json")))!.AsArray();
foreach (var test in sharedTargetCases)
{
    var changed = (JsonObject)declared.DeepClone();
    var steps = test!["path"]!.AsArray();
    var parent = TargetSlot(changed);
    foreach (var step in steps.Take(steps.Count - 1)) parent = step!.GetValueKind() == JsonValueKind.Number ? parent[step.GetValue<int>()]! : parent[step.GetValue<string>()]!;
    var last = steps.Last()!;
    if (last.GetValueKind() == JsonValueKind.Number) parent[last.GetValue<int>()] = test["value"]?.DeepClone();
    else parent[last.GetValue<string>()] = test["value"]?.DeepClone();
    var inspected = InspectTarget(changed);
    var expected = "twin.motion.target." + test["code"]!.GetValue<string>();
    if (inspected.Valid || !inspected.Diagnostics.Any(d => d.Code == expected)) throw new Exception($"声明反例未拒绝：{test["name"]}，预期 {expected}");
}
var trajectoryRoundtrip = false;
var rejectedTrajectories = 0;
if (args.Length > 1)
{
    var motion = JsonNode.Parse(File.ReadAllText(args[1]))!.AsObject();
    var inspectedMotion = InspectTarget(motion);
    if (!inspectedMotion.Valid) throw new Exception("前端实际轨迹未通过服务端检查：" + string.Join("; ", inspectedMotion.Diagnostics.Select(d => d.Code + ":" + d.Message)));
    var reopened = JsonNode.Parse(inspectedMotion.NormalizedPayload)!.AsObject();
    if (!JsonNode.DeepEquals(motion["motionTrajectories"], reopened["motionTrajectories"]) || !InspectTarget(reopened).Valid) throw new Exception("轨迹保存重开不一致");
    using var motionDocument = JsonDocument.Parse(reopened.ToJsonString());
    var publishDiagnostics = new List<IoTSharp.Contracts.TwinValidationDiagnosticDto>();
    TwinJointTrajectoryInspector.Inspect(motionDocument.RootElement, publishDiagnostics, forPublish: true);
    if (!publishDiagnostics.Any(d => d.Message.Contains("不能正式发布"))) throw new Exception("未拦截仿真产物正式发布");
    Action<JsonNode>[] mutations = [
        t => t["contractVersion"] = "unknown", t => t["validation"] = "passed", t => t["axisIds"] = new JsonArray("x", "x", "z"),
        t => t["points"]![0]!["time"] = 1, t => t["points"]![1]!["time"] = 0, t => t["points"]![1]!["time"] = .00001,
        t => t["points"]![1]!["positions"]![0] = 5, t => t["points"]![1]!["positions"]![0] = "1",
        t => t["limits"]![0]!["velocity"] = 2, t => t["limits"]![0]!["jerk"] = 0, t => t["limits"] = null,
        t => t["points"] = null, t => t["dependencySnapshot"] = "{}"
    ];
    foreach (var mutate in mutations)
    {
        var changed = motion.DeepClone().AsObject(); mutate(changed["motionTrajectories"]![0]!);
        if (!InspectTarget(changed).Diagnostics.Any(d => d.Code == "twin.motion.trajectory.invalid")) throw new Exception("无效轨迹未拒绝");
        rejectedTrajectories++;
    }
    var wrongActor = motion.DeepClone().AsObject(); wrongActor["actionFlows"]![0]!["nodes"]![1]!["actorObjectId"] = "source";
    if (!InspectTarget(wrongActor).Diagnostics.Any(d => d.Code == "AF1501")) throw new Exception("错误执行对象未拒绝");
    trajectoryRoundtrip = true;
}
var batchPlanningRoundtrips = 0;
foreach (var batchPath in args.Skip(2))
{
    var batch = JsonNode.Parse(File.ReadAllText(batchPath))!.AsObject();
    var inspection = InspectTarget(batch);
    if (!inspection.Valid) throw new Exception("批次/整托工艺合同无效：" + string.Join("; ", inspection.Diagnostics.Select(d => d.Code + ":" + d.Message)));
    if (!InspectTarget(JsonNode.Parse(inspection.NormalizedPayload)!.AsObject()).Valid) throw new Exception("批次工艺重开失败");
    using var doc = JsonDocument.Parse(inspection.NormalizedPayload);
    var publishDiagnostics = new List<IoTSharp.Contracts.TwinValidationDiagnosticDto>();
    TwinJointTrajectoryInspector.Inspect(doc.RootElement, publishDiagnostics, forPublish: true);
    if (!publishDiagnostics.Any(d => d.Message.Contains("不能正式发布"))) throw new Exception("批次工艺绕过正式发布验证");
    var plan = batch["actionFlows"]!.AsArray().SelectMany(f => f!["nodes"]!.AsArray()).First(n => n!["type"]!.GetValue<string>() == "PlanPickPlace")!;
    plan["config"]!["request"]!["payloadCount"] = 0;
    if (!InspectTarget(batch).Diagnostics.Any(d => d.Code == "AF1502")) throw new Exception("非法批次配置未拒绝");
    batchPlanningRoundtrips++;
}
Console.WriteLine(JsonSerializer.Serialize(new { passed = true, productionInspector = true, resources = result.ResourceIds.Count, componentBindings = result.Components.Count, routes = result.Routes.Count, actionFlows = result.ActionFlows.Count, rejectedInvalidCases = invalidCases.Length, sharedTargetCases = sharedTargetCases.Count, targetContractRoundtrip = true, trajectoryRoundtrip, rejectedTrajectories, batchPlanningRoundtrips, databaseWritten = false }));
