#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Models;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin;

/// <summary>
/// 按已发布版本中的数据库绑定批量读取 Device 最新遥测、属性、在线状态和告警。
/// </summary>
public sealed class TwinRuntimeSnapshotService
{
    private readonly ApplicationDbContext _context;

    public TwinRuntimeSnapshotService(ApplicationDbContext context) => _context = context;

    /// <summary>
    /// 获取场景绑定快照。草稿绑定不会进入运行态，指定版本时读取对应不可变绑定副本。
    /// </summary>
    public async Task<TwinRuntimeSnapshotDto> SnapshotAsync(TwinRuntimeSnapshotRequestDto request, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await _context.DigitalTwinScenes.AsNoTracking().FirstOrDefaultAsync(item =>
            item.Id == request.SceneId && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer,
            cancellationToken) ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");

        Guid versionId;
        if (request.Version.HasValue)
        {
            versionId = await _context.DigitalTwinSceneVersions.AsNoTracking()
                .Where(item => item.SceneId == scene.Id && item.Version == request.Version && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer)
                .Select(item => item.Id)
                .FirstOrDefaultAsync(cancellationToken);
        }
        else
        {
            versionId = scene.PublishedVersionId ?? Guid.Empty;
        }
        if (versionId == Guid.Empty) throw new TwinOperationException(ApiCode.CantFindObject, "场景尚未发布或版本不存在。");

        var bindings = await _context.TwinObjectBindings.AsNoTracking()
            .Where(item => !item.Deleted && item.Enabled && item.SceneId == scene.Id && item.SceneVersionId == versionId &&
                           item.TenantId == profile.Tenant && item.CustomerId == profile.Customer &&
                           item.SourceKind != TwinBindingSourceKind.Resource)
            .OrderBy(item => item.Priority)
            .ToListAsync(cancellationToken);
        var now = DateTime.UtcNow;
        var updates = new List<TwinDataUpdateDto>(bindings.Count);

        var telemetryBindings = bindings.Where(item => item.SourceKind == TwinBindingSourceKind.Telemetry && item.DeviceId.HasValue).ToList();
        var attributeBindings = bindings.Where(item => item.SourceKind is TwinBindingSourceKind.Attribute or TwinBindingSourceKind.Connectivity && item.DeviceId.HasValue).ToList();
        var telemetryValues = await LoadLatestAsync(_context.TelemetryLatest, telemetryBindings, cancellationToken);
        var attributeValues = await LoadLatestAsync(_context.AttributeLatest, attributeBindings, cancellationToken);

        foreach (var binding in bindings)
        {
            switch (binding.SourceKind)
            {
                case TwinBindingSourceKind.Telemetry:
                    updates.Add(ToDataUpdate(binding, FindValue(telemetryValues, binding.DeviceId, binding.SourceKey), now));
                    break;
                case TwinBindingSourceKind.Attribute:
                    updates.Add(ToDataUpdate(binding, FindValue(attributeValues, binding.DeviceId, binding.SourceKey), now));
                    break;
                case TwinBindingSourceKind.Connectivity:
                    updates.Add(ToDataUpdate(binding, FindValue(attributeValues, binding.DeviceId, Constants._Active), now));
                    break;
                case TwinBindingSourceKind.Alarm:
                    updates.Add(await LoadAlarmUpdateAsync(binding, profile, now, cancellationToken));
                    break;
                case TwinBindingSourceKind.Constant:
                    updates.Add(ToSyntheticUpdate(binding, binding.SourceKey, now));
                    break;
                case TwinBindingSourceKind.Simulation:
                    updates.Add(ToSyntheticUpdate(binding, true, now));
                    break;
                default:
                    updates.Add(ToMissingUpdate(binding));
                    break;
            }
        }

        return new TwinRuntimeSnapshotDto { SceneId = scene.Id, ServerTimestamp = now, Updates = updates };
    }

    private static async Task<Dictionary<(Guid DeviceId, string Key), DataStorage>> LoadLatestAsync<T>(
        DbSet<T> set,
        List<TwinObjectBinding> bindings,
        CancellationToken cancellationToken) where T : DataStorage
    {
        if (bindings.Count == 0) return [];
        var deviceIds = bindings.Select(item => item.DeviceId!.Value).Distinct().ToList();
        var keys = bindings.Select(item => item.SourceKind == TwinBindingSourceKind.Connectivity ? Constants._Active : item.SourceKey)
            .Where(item => !string.IsNullOrWhiteSpace(item)).Distinct().ToList();
        if (keys.Count == 0) return [];
        var values = await set.AsNoTracking()
            .Where(item => deviceIds.Contains(item.DeviceId) && keys.Contains(item.KeyName))
            .ToListAsync(cancellationToken);
        return values.GroupBy(item => (item.DeviceId, item.KeyName))
            .ToDictionary(group => group.Key, group => (DataStorage)group.OrderByDescending(item => item.DateTime).First());
    }

    private static DataStorage? FindValue(Dictionary<(Guid DeviceId, string Key), DataStorage> values, Guid? deviceId, string? key)
    {
        if (!deviceId.HasValue || string.IsNullOrWhiteSpace(key)) return null;
        return values.GetValueOrDefault((deviceId.Value, key));
    }

    private static TwinDataUpdateDto ToDataUpdate(TwinObjectBinding binding, DataStorage? value, DateTime now)
    {
        if (value == null) return ToMissingUpdate(binding);
        var staleAfter = TimeSpan.FromMilliseconds(Math.Max(100, binding.StaleAfterMs));
        var stale = now - EnsureUtc(value.DateTime) > staleAfter;
        return new TwinDataUpdateDto
        {
            BindingId = binding.Id,
            BindingKey = binding.BindingKey,
            ObjectId = binding.ObjectId,
            DeviceId = binding.DeviceId,
            Kind = binding.SourceKind.ToString().ToLowerInvariant(),
            Key = binding.SourceKey ?? string.Empty,
            Value = value.ToObject(),
            SourceTimestamp = EnsureUtc(value.DateTime),
            Quality = stale ? "stale" : "good",
            Stale = stale
        };
    }

    private async Task<TwinDataUpdateDto> LoadAlarmUpdateAsync(TwinObjectBinding binding, UserProfile profile, DateTime now, CancellationToken cancellationToken)
    {
        var originatorId = binding.DeviceId ?? binding.AssetId;
        if (!originatorId.HasValue) return ToMissingUpdate(binding);
        var query = _context.Alarms.AsNoTracking().Where(item =>
            item.OriginatorId == originatorId.Value && item.Tenant.Id == profile.Tenant && item.Customer.Id == profile.Customer);
        if (!string.IsNullOrWhiteSpace(binding.SourceKey)) query = query.Where(item => item.AlarmType == binding.SourceKey);
        var alarm = await query.OrderByDescending(item => item.StartDateTime).FirstOrDefaultAsync(cancellationToken);
        if (alarm == null) return ToMissingUpdate(binding);
        var sourceTimestamp = EnsureUtc(alarm.StartDateTime);
        var stale = now - sourceTimestamp > TimeSpan.FromMilliseconds(Math.Max(100, binding.StaleAfterMs));
        return new TwinDataUpdateDto
        {
            BindingId = binding.Id,
            BindingKey = binding.BindingKey,
            ObjectId = binding.ObjectId,
            DeviceId = binding.DeviceId,
            Kind = "alarm",
            Key = binding.SourceKey ?? alarm.AlarmType,
            Value = new { status = alarm.AlarmStatus.ToString(), severity = alarm.Serverity.ToString(), detail = alarm.AlarmDetail },
            SourceTimestamp = sourceTimestamp,
            Quality = stale ? "stale" : "good",
            Stale = stale
        };
    }

    private static TwinDataUpdateDto ToSyntheticUpdate(TwinObjectBinding binding, object? value, DateTime now) => new()
    {
        BindingId = binding.Id,
        BindingKey = binding.BindingKey,
        ObjectId = binding.ObjectId,
        DeviceId = binding.DeviceId,
        Kind = binding.SourceKind.ToString().ToLowerInvariant(),
        Key = binding.SourceKey ?? string.Empty,
        Value = value,
        SourceTimestamp = now,
        Quality = "good",
        Stale = false
    };

    private static TwinDataUpdateDto ToMissingUpdate(TwinObjectBinding binding) => new()
    {
        BindingId = binding.Id,
        BindingKey = binding.BindingKey,
        ObjectId = binding.ObjectId,
        DeviceId = binding.DeviceId,
        Kind = binding.SourceKind.ToString().ToLowerInvariant(),
        Key = binding.SourceKey ?? string.Empty,
        Value = null,
        SourceTimestamp = DateTime.UnixEpoch,
        Quality = "missing",
        Stale = true
    };

    private static DateTime EnsureUtc(DateTime value) => value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
}
