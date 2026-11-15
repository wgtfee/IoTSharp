using System.Text.Json;
using System.Text.Json.Nodes;
using IoTSharp.Services.DigitalTwin;

// 直接编译生产校验器与 DTO，不启动数据库或 Web 服务。
var count = 0;
JsonObject Manifest() => JsonNode.Parse("""
{"objects":[{"objectId":"gantry"}],"materialSlots":[
 {"slotId":"source","role":"source","payloadType":"box","toolTargets":[{"toolFrameId":"main"},{"toolFrameId":"sheet"}]},
 {"slotId":"target","role":"stack","payloadType":"box","stackPattern":{"layers":8},"toolTargets":[{"toolFrameId":"main"},{"toolFrameId":"sheet"}]}],
 "toolFrames":[{"toolFrameId":"main","objectId":"gantry","payloadTypes":["box"],"cartesianActuatorIds":["x"]},
 {"toolFrameId":"sheet","objectId":"gantry","payloadTypes":["box"],"cartesianActuatorIds":["z"]}],
 "actuators":[{"actuatorId":"x","objectId":"gantry","kind":"linear-axis","speed":1},
 {"actuatorId":"z","objectId":"gantry","kind":"linear-axis","speed":1}]}
""")!.AsObject();
JsonObject Request() => JsonNode.Parse("""
{"taskId":"task","name":"task","sourceSlotId":"source","targetSlotId":"target","toolFrameId":"main","transferMaterials":true,"payloadCount":1,"palletRecipeId":"recipe","expectedLayer":0,"axisLimits":{"x":{"velocity":1,"acceleration":1,"jerk":1}}}
""")!.AsObject();
void Check(string name, JsonObject manifest, string type, JsonObject config, string code, bool rejected)
{
    var flow = new JsonObject { ["flowId"] = "flow", ["key"] = "flow", ["contractVersion"] = "2.0", ["policies"] = new JsonObject { ["executionTarget"] = "scene" },
        ["nodes"] = new JsonArray(new JsonObject { ["nodeId"] = "action", ["type"] = type, ["actorObjectId"] = "gantry", ["config"] = config }), ["edges"] = new JsonArray() };
    using var m = JsonDocument.Parse(manifest.ToJsonString()); using var f = JsonDocument.Parse(flow.ToJsonString());
    var result = TwinActionFlowServerCompiler.Compile(f.RootElement, m.RootElement);
    if (result.Diagnostics.Any(d => d.Code == code) != rejected) throw new Exception(name + ": unexpected " + code + " result");
    Console.WriteLine("PASS " + name); count++;
}
void Plan(string name, Action<JsonObject, JsonObject> mutate, bool rejected = true)
{
    var manifest = Manifest(); var request = Request(); mutate(manifest, request);
    Check(name, manifest, "PlanPickPlace", new JsonObject { ["request"] = request }, "AF1502", rejected);
}
Plan("valid main tool in dual-tool scene", (_, _) => { }, false);
Plan("valid sheet tool with independent axis", (_, r) => { r["toolFrameId"] = "sheet"; r["axisLimits"] = new JsonObject { ["z"] = r["axisLimits"]!["x"]!.DeepClone() }; }, false);
Plan("missing recipe slot", (m, _) => m["materialSlots"]![1]!["stackPatternSlotId"] = "missing");
Plan("duplicate recipe slot", (m, _) => { m["materialSlots"]![1]!["stackPatternSlotId"] = "pattern"; m["materialSlots"]!.AsArray().Add(new JsonObject { ["slotId"] = "pattern" }); m["materialSlots"]!.AsArray().Add(new JsonObject { ["slotId"] = "pattern" }); });
Plan("unknown selected axis", (m, _) => m["toolFrames"]![0]!["cartesianActuatorIds"]!.AsArray().Add("missing"));
Plan("duplicate selected axis", (m, _) => m["toolFrames"]![0]!["cartesianActuatorIds"]!.AsArray().Add("x"));
Plan("non-string selected axis", (m, _) => m["toolFrames"]![0]!["cartesianActuatorIds"]!.AsArray().Add(3));
Plan("duplicate actuator declaration", (m, _) => m["actuators"]!.AsArray().Add(m["actuators"]![0]!.DeepClone()));
Plan("extra limit for other tool", (_, r) => r["axisLimits"]!["z"] = r["axisLimits"]!["x"]!.DeepClone());
Plan("layer outside recipe", (_, r) => r["expectedLayer"] = 8);
var matrix = JsonNode.Parse("[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]")!;
foreach (var type in new[] { "Attach", "Detach" })
{
    foreach (var raw in new[] { "[null]", "[1]", "[\"bad\"]", "[{}]", "[]", "null" })
        Check(type + " malformed payload " + raw, Manifest(), type, new JsonObject { ["expectedPayloads"] = JsonNode.Parse(raw) }, "AF1505", true);
    Check(type + " valid payload", Manifest(), type, new JsonObject { ["expectedPayloads"] = new JsonArray(new JsonObject { ["entityId"] = "box", ["worldMatrix"] = matrix.DeepClone() }), ["payloadCount"] = 1 }, "AF1505", false);
}
Console.WriteLine($"{count} compiler regressions passed.");
