using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>检查显式声明的槽位 TCP 候选；只验证合同，不执行运动学或授予运动权限。</summary>
internal static class TwinSlotToolTargetInspector
{
    /// <summary>为保存、发布检查追加与前端一致的声明诊断；没有新声明的旧场景不受影响。</summary>
    internal static void Inspect(JsonElement manifest, List<TwinValidationDiagnosticDto> diagnostics)
    {
        void Add(string kind, string message, string path) => diagnostics.Add(new TwinValidationDiagnosticDto
        {
            Severity = "error", Code = $"twin.motion.target.{kind}", Message = message, Path = path
        });
        var frames = Items(manifest, "toolFrames").Where(item => item.ValueKind == JsonValueKind.Object).ToArray();
        var slotIndex = -1;
        foreach (var slot in Items(manifest, "materialSlots"))
        {
            slotIndex++;
            if (slot.ValueKind == JsonValueKind.Object && slot.TryGetProperty("stackPattern", out var pattern) && pattern.ValueKind == JsonValueKind.Object && pattern.TryGetProperty("separatorMode", out _))
            {
                bool Numeric(string key, Func<double, bool> check) => pattern.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n) && double.IsFinite(n) && check(n);
                var mode = Text(pattern, "separatorMode");
                if (!(new[] { "none", "between-layers", "every-layer" }).Contains(mode) || (new[] { "rows", "columns", "layers" }).Any(k => !Numeric(k, n => n >= 1 && n == Math.Floor(n))) || !Numeric("layers", n => n <= 64) || (new[] { "spacingX", "spacingZ", "layerPitch" }).Any(k => !Numeric(k, n => n > 0)) || !Numeric("firstLayerY", _ => true) || (mode != "none" && (new[] { "separatorThickness", "layerMaterialOffsetY" }).Any(k => !Numeric(k, n => n >= 0))))
                    Add("stack.invalid", "码垛配方需要有效的层数、格位、间距、层高及显式隔板参数。", $"materialSlots[{slotIndex}].stackPattern");
            }
            if (slot.ValueKind != JsonValueKind.Object || !slot.TryGetProperty("toolTargets", out var targets)) continue;
            var path = $"materialSlots[{slotIndex}].toolTargets";
            if (targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() > 32)
            {
                Add("list.invalid", "取放候选必须是最多 32 项的数组。", path);
                continue;
            }
            if (targets.GetArrayLength() == 0) continue;
            if (!Direction(slot, "contactNormalLocal")) Add("normal.invalid", "自动派生需要有限且非零的槽位接触外法向。", $"materialSlots[{slotIndex}].contactNormalLocal");
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var index = -1;
            foreach (var target in targets.EnumerateArray())
            {
                var itemPath = $"{path}[{++index}]";
                if (target.ValueKind != JsonValueKind.Object) { Add("definition.invalid", "取放候选必须是对象。", itemPath); continue; }
                if (Text(target, "contractVersion") != "slot-tool-target/1") Add("version.invalid", "不支持的取放候选合同版本。", $"{itemPath}.contractVersion");
                var id = Text(target, "templateId");
                if (string.IsNullOrWhiteSpace(id) || !ids.Add(id)) Add("id.invalid", "同一槽位的候选标识必须非空且唯一。", $"{itemPath}.templateId");
                var frameId = Text(target, "toolFrameId");
                var matches = frames.Where(frame => Text(frame, "toolFrameId") == frameId).ToArray();
                var hasFrame = !string.IsNullOrWhiteSpace(frameId) && matches.Length == 1;
                if (!hasFrame) Add("tool.invalid", "取放候选必须引用唯一的工具 TCP。", $"{itemPath}.toolFrameId");
                else if (!Direction(matches[0], "approachDirectionLocal")) Add("approach.invalid", "自动派生需要有限且非零的工具接近方向。", $"{itemPath}.toolFrameId");
                var payload = Text(target, "payloadType");
                if (string.IsNullOrWhiteSpace(payload) || payload != Text(slot, "payloadType") || (hasFrame && !Items(matches[0], "payloadTypes").Any(value => value.ValueKind == JsonValueKind.String && value.GetString() == payload)))
                    Add("payload.invalid", "候选物料必须与槽位和工具显式允许的物料一致。", $"{itemPath}.payloadType");
                foreach (var key in new[] { "tcpOffset", "tcpRotation" })
                    if (!Vector(target, key, out _)) Add($"{key}.invalid", "TCP 位姿必须是三个有限数值。", $"{itemPath}.{key}");
                foreach (var key in new[] { "approachDistance", "retreatDistance" })
                    if (!target.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number) || number <= 0)
                        Add($"{key}.invalid", "接近和退出距离必须显式配置为正的有限米数。", $"{itemPath}.{key}");
            }
        }
    }

    /// <summary>读取数组；错误类型留给主合同校验器报告。</summary>
    private static IEnumerable<JsonElement> Items(JsonElement parent, string key) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : Array.Empty<JsonElement>();

    /// <summary>读取字符串，避免异常类型导致保存接口返回 500。</summary>
    private static string Text(JsonElement parent, string key) =>
        parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;

    /// <summary>读取严格的三个有限数值，禁止数字字符串和缺失坐标。</summary>
    private static bool Vector(JsonElement parent, string key, out double[] coordinates)
    {
        coordinates = Array.Empty<double>();
        if (!parent.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != 3) return false;
        var values = value.EnumerateArray().ToArray();
        if (values.Any(component => component.ValueKind != JsonValueKind.Number || !component.TryGetDouble(out var number) || !double.IsFinite(number))) return false;
        coordinates = values.Select(component => component.GetDouble()).ToArray();
        return true;
    }

    /// <summary>以缩放求范数避免中间平方溢出，与前端有限非零方向判定保持一致。</summary>
    private static bool Direction(JsonElement parent, string key)
    {
        if (!Vector(parent, key, out var values)) return false;
        var max = values.Max(value => Math.Abs(value));
        return max > 0 && double.IsFinite(max * Math.Sqrt(values.Sum(value => (value / max) * (value / max))));
    }
}
