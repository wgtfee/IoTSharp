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
Console.WriteLine(JsonSerializer.Serialize(new { passed = true, productionInspector = true, resources = result.ResourceIds.Count, componentBindings = result.Components.Count, routes = result.Routes.Count, actionFlows = result.ActionFlows.Count, rejectedInvalidCases = invalidCases.Length, databaseWritten = false }));
