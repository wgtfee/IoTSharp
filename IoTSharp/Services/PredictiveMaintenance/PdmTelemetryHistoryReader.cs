using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Storage;
using Microsoft.Extensions.Options;

namespace IoTSharp.Services.PredictiveMaintenance;

public sealed record PdmHistoryWindow(
    IReadOnlyList<PdmTelemetrySample> Samples,
    PdmOperatingState OperatingState,
    string? Failure)
{
    public static PdmHistoryWindow Reject(string message) =>
        new(Array.Empty<PdmTelemetrySample>(), PdmOperatingState.Unknown, message);
}

public interface IPdmHistoryReader
{
    Task<PdmHistoryWindow> ReadAsync(
        PdmDeviceProfile profile, IReadOnlyList<PdmPointPolicy> policies,
        DateTimeOffset windowEndUtc, int maximumRows, CancellationToken cancellationToken);
}

/// <summary>
/// 只读 IStorage 的 History 数据。历史 DTO 不携带单位，因此仅可基于现场核验后的
/// PdmPointPolicy.Unit 解释数据；没有 PointMappingsVerified 时拒绝读取。
/// 数据读取必须实现 IBoundedTelemetryHistoryStorage，不允许无界回退。
/// </summary>
public sealed class PdmTelemetryHistoryReader : IPdmHistoryReader
{
    private readonly IStorage _storage;
    private readonly bool _allowUnspecifiedUtc;

    public PdmTelemetryHistoryReader(IStorage storage, IOptions<PdmWorkerOptions>? options = null)
    {
        _storage = storage;
        // SQL datetime loses DateTime.Kind. Only a separately audited UTC storage contract may restore Kind.
        _allowUnspecifiedUtc = options?.Value.HistoryUtcContractApproved == true;
    }

    public async Task<PdmHistoryWindow> ReadAsync(
        PdmDeviceProfile profile, IReadOnlyList<PdmPointPolicy> policies,
        DateTimeOffset windowEndUtc, int maximumRows, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(policies);
        if (!profile.PointMappingsVerified || !profile.RunStateVerified ||
            string.IsNullOrWhiteSpace(profile.RunStateTelemetryKey) ||
            profile.RunStateIntervalSeconds is <= 0 or > 86400 ||
            !double.IsFinite(profile.RunStateRunningValue))
            return PdmHistoryWindow.Reject("尚未现场核实单位、设备点位和运行状态");
        if (profile.WindowMinutes is <= 0 or > 60 ||
            maximumRows is < 1 or > 100_000 ||
            policies.Count is < 1 or > 32)
            return PdmHistoryWindow.Reject("时间窗口/点位数/行数限额无效");

        var enabled = policies.Where(p => p.Enabled).ToArray();
        if (enabled.Length == 0 || enabled.Any(p =>
                p.ProfileId != profile.Id ||
                string.IsNullOrWhiteSpace(p.TelemetryKey) ||
                p.TelemetryKey.Contains(',') ||
                p.TelemetryKey.Contains(';') ||
                p.TelemetryKey.Any(char.IsWhiteSpace) ||
                string.Equals(p.TelemetryKey, profile.RunStateTelemetryKey, StringComparison.Ordinal)))
            return PdmHistoryWindow.Reject("点位映射缺失、非法或与运行状态冲突");
        if (profile.RunStateTelemetryKey.Contains(',') ||
            profile.RunStateTelemetryKey.Contains(';') ||
            profile.RunStateTelemetryKey.Any(char.IsWhiteSpace))
            return PdmHistoryWindow.Reject("运行状态点位 Key 不合法");

        cancellationToken.ThrowIfCancellationRequested();
        var end = windowEndUtc.ToUniversalTime();
        var begin = end.AddMinutes(-profile.WindowMinutes);
        var keys = enabled.Select(p => p.TelemetryKey)
            .Append(profile.RunStateTelemetryKey).Distinct(StringComparer.Ordinal).ToArray();
        if (_storage is not IBoundedTelemetryHistoryStorage bounded)
            return PdmHistoryWindow.Reject("Provider 无法保证数据库端限量与取消，禁止评估");

        // 只读、半开 UTC 窗口；不接入 MQTT/规则链/历史写入热路径。
        List<TelemetryDataDto> records;
        try
        {
            records = await bounded.LoadTelemetryBoundedAsync(profile.DeviceId, keys,
                begin.UtcDateTime, end.UtcDateTime, maximumRows, cancellationToken);
        }
        catch (TelemetryHistoryLimitExceededException)
        {
            return PdmHistoryWindow.Reject("数据库侧最大行数已超过上限；拒绝将截断窗口用于预测");
        }
        catch (NotSupportedException)
        {
            return PdmHistoryWindow.Reject("当前历史 Provider 不提供安全的有界读取；拒绝评估");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (records == null || records.Count > maximumRows)
            return PdmHistoryWindow.Reject("历史查询结果超出单设备评估上限");

        var map = enabled.ToDictionary(x => x.TelemetryKey, StringComparer.Ordinal);
        var samples = new List<PdmTelemetrySample>(records.Count);
        TelemetryDataDto? lastState = null;
        DateTimeOffset lastStateUtc = default;
        foreach (var record in records)
        {
            if (record.KeyName == null ||
                (record.DateTime.Kind != DateTimeKind.Utc &&
                 !(record.DateTime.Kind == DateTimeKind.Unspecified && _allowUnspecifiedUtc)))
                return PdmHistoryWindow.Reject("历史时间并非已核验的 UTC；拒绝按本地时区猜测");
            var trustedUtc = record.DateTime.Kind == DateTimeKind.Unspecified
                ? DateTime.SpecifyKind(record.DateTime, DateTimeKind.Utc)
                : record.DateTime;
            var at = new DateTimeOffset(trustedUtc, TimeSpan.Zero);
            if (at < begin || at >= end)
                return PdmHistoryWindow.Reject("历史 Provider 返回窗口外数据");

            if (string.Equals(record.KeyName, profile.RunStateTelemetryKey, StringComparison.Ordinal))
            {
                if (lastState == null || at > lastStateUtc)
                {
                    lastState = record;
                    lastStateUtc = at;
                }
                continue;
            }
            if (!map.TryGetValue(record.KeyName, out var point))
                return PdmHistoryWindow.Reject("历史 Provider 返回未经授权的点位");
            if (!TryDouble(record.Value, out var numeric))
                return PdmHistoryWindow.Reject("历史遥测包含无法解析的值");

            samples.Add(new PdmTelemetrySample(profile.TenantId, profile.CustomerId,
                profile.DeviceId, record.KeyName, at, numeric, point.Unit));
        }

        if (lastState == null ||
            (end - lastStateUtc).TotalSeconds > profile.RunStateIntervalSeconds * 2.5 ||
            !TryDouble(lastState.Value, out var stateValue))
            return new PdmHistoryWindow(samples, PdmOperatingState.Unknown, "运行状态数据缺失或过期");
        return new PdmHistoryWindow(samples,
            stateValue == profile.RunStateRunningValue ? PdmOperatingState.Running : PdmOperatingState.Stopped,
            null);
    }

    private static bool TryDouble(object? value, out double number)
    {
        number = default;
        switch (value)
        {
            case double v: number = v; break;
            case float v: number = v; break;
            case int v: number = v; break;
            case long v: number = v; break;
            case short v: number = v; break;
            case byte v: number = v; break;
            case bool v: number = v ? 1 : 0; break;
            case decimal v: number = (double)v; break;
            default: return false;
        }
        return double.IsFinite(number);
    }
}

