using System;
using System.Data;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance;

public sealed record PdmCycleResult(
    bool Committed, bool DuplicateWindow, PdmRiskTransitionKind RiskTransition,
    string DataQuality, PdmRiskLevel Risk, string? Message);

/// <summary>
/// 单设备单窗口：历史只读 -> 规则评估 -> 同一事务持久化快照/风险转换。
/// 不注册到采集热路径；跨进程并发需独立分布式 lease，默认绝不启用多实例。
/// </summary>
public sealed class PdmCycleProcessor
{
    private readonly PdmDbContext _db;
    private readonly IPdmHistoryReader _history;
    private readonly PdmHealthEvaluator _evaluator;
    private readonly bool _mesIntegrationEnabled;

    public PdmCycleProcessor(PdmDbContext db, IPdmHistoryReader history,
        PdmHealthEvaluator evaluator, IOptions<PdmMesIntegrationOptions>? integration = null)
    {
        _db = db;
        _history = history;
        _evaluator = evaluator;
        _mesIntegrationEnabled = integration?.Value.Enabled == true && integration.Value.SchemaReady;
    }

    public async Task<PdmCycleResult> ProcessAsync(
        Guid profileId, DateTimeOffset endUtc,
        int maxPoints, int maxRows, int recoveryWindows,
        CancellationToken token = default)
    {
        if (endUtc.Offset != TimeSpan.Zero)
            throw new ArgumentException("Worker window must be expressed in UTC", nameof(endUtc));
        if (maxPoints is < 1 or > 32 || maxRows is < 1 or > 100_000)
            throw new ArgumentOutOfRangeException(nameof(maxRows));
        if (recoveryWindows is < 1 or > 100)
            throw new ArgumentOutOfRangeException(nameof(recoveryWindows));

        var profile = await _db.DeviceProfiles.AsNoTracking().SingleOrDefaultAsync(
            p => p.Id == profileId && p.Enabled, token);
        if (profile == null)
            return new PdmCycleResult(false, false, PdmRiskTransitionKind.NoChange,
                "Unknown", PdmRiskLevel.Unknown, "配置不存在或未启用");

        if (!profile.PointMappingsVerified || !profile.RunStateVerified ||
            string.IsNullOrWhiteSpace(profile.RunStateTelemetryKey) ||
            profile.WindowMinutes is <= 0 or > 60)
            return new PdmCycleResult(false, false, PdmRiskTransitionKind.NoChange,
                "Unknown", PdmRiskLevel.Unknown, "真实点位/运行工况尚未核验");

        var end = endUtc.UtcDateTime;
        var start = endUtc.AddMinutes(-profile.WindowMinutes).UtcDateTime;
        if (await _db.HealthSnapshots.AsNoTracking().AnyAsync(
                x => x.ProfileId == profile.Id && x.ProfileVersion == profile.Version
                  && x.WindowStartUtc == start && x.WindowEndUtc == end, token))
            return new PdmCycleResult(false, true, PdmRiskTransitionKind.IgnoredDuplicate,
                "Duplicate", PdmRiskLevel.Unknown, "窗口已经持久化");

        var policies = await _db.PointPolicies.AsNoTracking()
            .Where(p => p.ProfileId == profile.Id && p.Enabled)
            .OrderBy(p => p.TelemetryKey).Take(maxPoints + 1).ToListAsync(token);
        if (policies.Count is 0 || policies.Count > maxPoints || policies.All(p => !p.Required))
            return new PdmCycleResult(false, false, PdmRiskTransitionKind.NoChange,
                "Unknown", PdmRiskLevel.Unknown, "必需点位未配置或超出上限");

        var history = await _history.ReadAsync(profile, policies, endUtc, maxRows, token);
        // Read failure does not mean a healthy device; persist Unknown snapshot for diagnostics.
        var eval = _evaluator.Evaluate(profile, policies, history.Samples, endUtc,
            history.Failure != null ? PdmOperatingState.Unknown : history.OperatingState);

        await using var transaction = await _db.Database.BeginTransactionAsync(
            IsolationLevel.Serializable, token);
        // Read again inside the transaction: repeat attempts for the same window cannot increment an event twice.
        if (await _db.HealthSnapshots.AsNoTracking().AnyAsync(
                x => x.ProfileId == profile.Id && x.ProfileVersion == profile.Version
                  && x.WindowStartUtc == start && x.WindowEndUtc == end, token))
        {
            await transaction.RollbackAsync(token);
            return new PdmCycleResult(false, true, PdmRiskTransitionKind.IgnoredDuplicate,
                "Duplicate", PdmRiskLevel.Unknown, "并发或重试窗口已经持久化");
        }

        // Fail closed on out-of-order replay: never rewind risk state or score history.
        var later = await _db.HealthSnapshots.AsNoTracking().AnyAsync(
            x => x.ProfileId == profile.Id && x.ProfileVersion == profile.Version &&
                 x.WindowEndUtc > end, token);
        if (later)
        {
            await transaction.RollbackAsync(token);
            return new PdmCycleResult(false, false, PdmRiskTransitionKind.NoChange,
                "Unknown", PdmRiskLevel.Unknown, "存在更新窗口，不允许倒序恢复旧窗口");
        }

        _db.HealthSnapshots.Add(eval.ToSnapshot(profile));
        var active = await _db.RiskEvents.SingleOrDefaultAsync(
            x => x.TenantId == profile.TenantId && x.CustomerId == profile.CustomerId &&
                 x.DeviceId == profile.DeviceId && x.ProfileId == profile.Id &&
                 x.ProfileVersion == profile.Version &&
                 x.RiskType == PdmRiskEventTransitions.HealthRiskType && x.Status == "Open",
            token);
        var previousRiskLevel = active?.RiskLevel;
        var action = PdmRiskEventTransitions.Apply(active, eval, profile,
            recoveryWindows, out var changed);
        if (action == PdmRiskTransitionKind.Opened && changed != null)
            _db.RiskEvents.Add(changed);

        if (_mesIntegrationEnabled)
            await PdmMesEventProjector.TryAppendAsync(_db, profile, changed, eval, action, previousRiskLevel, token);

        await _db.SaveChangesAsync(token);
        await transaction.CommitAsync(token);
        return new PdmCycleResult(true, false, action,
            eval.DataQuality, eval.Risk, history.Failure);
    }
}

