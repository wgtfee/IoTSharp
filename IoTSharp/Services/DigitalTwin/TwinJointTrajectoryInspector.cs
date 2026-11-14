using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>定时轴轨迹的服务端合同与解析极值检查；不信任客户端的验证状态。</summary>
internal static class TwinJointTrajectoryInspector
{
    /// <summary>检查草稿轨迹；正式发布仍须拒绝尚无完整碰撞和交接验证的产物。</summary>
    internal static void Inspect(JsonElement manifest, List<TwinValidationDiagnosticDto> diagnostics, bool forPublish = false)
    {
        void Add(string message, string path = "motionTrajectories") => diagnostics.Add(new TwinValidationDiagnosticDto { Severity = "error", Code = "twin.motion.trajectory.invalid", Message = message, Path = path });
        if (forPublish && Items(manifest, "actionFlows").Any(flow => Items(flow, "nodes").Any(node => Text(node, "type") is "PlanPickPlace" or "PlannedTransferStep"))) Add("按批次规划尚缺完整碰撞验证，不能正式发布。", "actionFlows");
        if (!manifest.TryGetProperty("motionTrajectories", out var trajectories)) return;
        if (trajectories.ValueKind != JsonValueKind.Array || trajectories.GetArrayLength() > 256) { Add("场景轨迹必须是最多 256 项的数组。"); return; }
        if (forPublish && trajectories.GetArrayLength() > 0) Add("定时轨迹当前仅允许仿真试运行，缺少完整碰撞与交接验证，不能正式发布。");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var trajectory in trajectories.EnumerateArray())
        {
            var path = $"motionTrajectories[{index++}]";
            void Reject(string message) => Add(message, path);
            if (trajectory.ValueKind != JsonValueKind.Object) { Reject("轨迹必须是对象。"); continue; }
            var id = Text(trajectory, "trajectoryId");
            if (string.IsNullOrWhiteSpace(id) || !ids.Add(id) || string.IsNullOrWhiteSpace(Text(trajectory, "name"))) Reject("轨迹名称和标识不能为空且标识不能重复。");
            if (Text(trajectory, "contractVersion") != "joint-trajectory/1" || Text(trajectory, "interpolation") != "quintic-stop" || Text(trajectory, "validation") != "simulation-only") Reject("轨迹版本、插值方式或验证范围不受支持。");
            var actor = Text(trajectory, "actorObjectId");
            if (Items(manifest, "objects").Count(o => Text(o, "objectId") == actor) != 1) Reject("轨迹必须引用唯一执行对象。");
            if (!DependenciesMatch(manifest, Text(trajectory, "dependencySnapshot"))) Reject("场景依赖已变化，请重新生成轨迹。");
            var axes = Items(trajectory, "axisIds").ToArray();
            var limits = Items(trajectory, "limits").ToArray();
            var points = Items(trajectory, "points").ToArray();
            if (axes.Length is < 1 or > 16 || axes.Any(a => a.ValueKind != JsonValueKind.String) || axes.Select(a => a.GetString()).Distinct(StringComparer.Ordinal).Count() != axes.Length) { Reject("轨迹轴必须为 1 至 16 个不重复的执行轴。"); continue; }
            if (limits.Length != axes.Length || limits.Any(l => new[] { "velocity", "acceleration", "jerk" }.Any(k => !Number(l, k, out var n) || n <= 0))) { Reject("每轴必须声明正的速度、加速度和加加速度约束。"); continue; }
            if (points.Length is < 2 or > 4096 || points.Any(p => !Number(p, "time", out _) || Items(p, "positions").Count() != axes.Length || Items(p, "positions").Any(v => !Finite(v, out _)))) { Reject("轨迹必须包含 2 至 4096 个有限的定时轴位置。"); continue; }
            var times = points.Select(p => p.GetProperty("time").GetDouble()).ToArray();
            if (times[0] != 0 || times.Skip(1).Where((t, i) => t <= times[i]).Any()) { Reject("轨迹时间必须从零开始且严格递增。"); continue; }
            for (var a = 0; a < axes.Length; a++)
            {
                var axisId = axes[a].GetString();
                var matches = Items(manifest, "actuators").Where(d => Text(d, "actuatorId") == axisId).ToArray();
                if (matches.Length != 1) { Reject($"执行轴 {axisId} 不存在或重复。"); continue; }
                var axis = matches[0];
                if (Text(axis, "objectId") != actor || Text(axis, "kind") is not ("linear-axis" or "rotary-joint") || !Number(axis, "minValue", out var min) || !Number(axis, "maxValue", out var max) || min >= max) { Reject($"执行轴 {axisId} 缺少有效机构归属或有限行程。"); continue; }
                var velocity = limits[a].GetProperty("velocity").GetDouble();
                var acceleration = limits[a].GetProperty("acceleration").GetDouble();
                var jerk = limits[a].GetProperty("jerk").GetDouble();
                if (!Number(axis, "speed", out var speed) || speed <= 0 || velocity > speed) Reject($"执行轴 {axisId} 的轨迹速度不能超过设备速度声明。");
                var positions = points.Select(p => p.GetProperty("positions")[a].GetDouble()).ToArray();
                if (positions.Any(p => p < min || p > max)) Reject($"执行轴 {axisId} 的目标超出行程。");
                for (var p = 1; p < points.Length; p++)
                {
                    var duration = times[p] - times[p - 1]; var distance = Math.Abs(positions[p] - positions[p - 1]);
                    if (1.875 * distance / duration > velocity * (1 + 1e-10) || 10 / Math.Sqrt(3) * distance / Math.Pow(duration, 2) > acceleration * (1 + 1e-10) || 60 * distance / Math.Pow(duration, 3) > jerk * (1 + 1e-10)) Reject($"执行轴 {axisId} 第 {p} 段超过时间/轴约束。");
                }
            }
        }
    }

    /// <summary>比较全部声明依赖，JSON 属性顺序不影响往返判定。</summary>
    private static bool DependenciesMatch(JsonElement manifest, string snapshot)
    {
        try
        {
            var expected = new JsonObject();
            foreach (var pair in new[] { ("world", "world"), ("resources", "resources"), ("objects", "objects"), ("slots", "materialSlots"), ("tools", "toolFrames"), ("axes", "actuators"), ("routes", "routes"), ("bindings", "bindings"), ("interlocks", "interlocks") })
                if (manifest.TryGetProperty(pair.Item2, out var value)) expected[pair.Item1] = JsonNode.Parse(value.GetRawText());
            return JsonNode.DeepEquals(expected, JsonNode.Parse(snapshot));
        }
        catch (JsonException) { return false; }
    }
    private static IEnumerable<JsonElement> Items(JsonElement parent, string key) => parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : System.Array.Empty<JsonElement>();
    private static string Text(JsonElement parent, string key) => parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static bool Finite(JsonElement value, out double number) { number = 0; return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out number) && double.IsFinite(number); }
    private static bool Number(JsonElement parent, string key, out double number) { number = 0; return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(key, out var value) && Finite(value, out number); }
}
