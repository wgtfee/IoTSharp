using System;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.Integration;

public sealed class PdmMesIntegrationOptions
{
    public bool Enabled { get; set; } = false;
    public bool SchemaReady { get; set; } = false;
    public string Endpoint { get; set; } = "";
    public string KeyId { get; set; } = "";
    // Inject via env/secret store: PredictiveMaintenance__MesIntegration__SharedSecret.
    public string SharedSecret { get; set; } = "";
    public int RequestTimeoutSeconds { get; set; } = 10;
    public int MaxAttempts { get; set; } = 20;
    public int BatchSize { get; set; } = 25;
    public bool AllowInsecureLoopbackForDevelopment { get; set; } = false;
}

public sealed record PdmMesEvent(
    string SchemaVersion, Guid EventId, string SourceSystem, string SourceEventKey,
    long SourceSequence, Guid TenantId, Guid CustomerId, Guid DeviceId,
    Guid ProfileId, int ProfileVersion, string EventType, string RiskLevel,
    DateTimeOffset OccurredAtUtc, DateTimeOffset WindowEndUtc, string DataQuality,
    string Summary, bool IsSynthetic, string CorrelationId, string EvidenceRef);

/// <summary>
/// Emits only on a committed P1 transaction. Both state and Outbox are saved
/// together by PdmCycleProcessor; this projector does NOT send HTTP.
/// </summary>
public static class PdmMesEventProjector
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static async Task TryAppendAsync(PdmDbContext db, PdmDeviceProfile profile,
        PdmRiskEvent? episode, PdmHealthEvaluation evaluation, PdmRiskTransitionKind transition,
        string? previousRiskLevel, CancellationToken ct, bool isSynthetic = false)
    {
        if (episode == null || string.IsNullOrWhiteSpace(episode.EventKey)) return;
        if (!profile.Enabled || !profile.PointMappingsVerified || !profile.RunStateVerified)
            return;
        var last = await db.IntegrationOutbox.AsNoTracking()
            .Where(x => x.TenantId == profile.TenantId && x.CustomerId == profile.CustomerId
                     && x.SourceEventKey == episode.EventKey)
            .OrderByDescending(x => x.SourceSequence).FirstOrDefaultAsync(ct);

        string? kind = null;
        if (last == null && episode.Status == "Open"
            && episode.OccurrenceCount >= 2 && evaluation.DataQuality == "Good"
            && evaluation.Risk is PdmRiskLevel.Warning or PdmRiskLevel.Critical)
        {
            // The first weak window creates an internal risk, not yet an external alert.
            kind = "ALARM_OPENED";
        }
        else if (last != null && last.EventType != "ALARM_RECOVERED")
        {
            if (transition == PdmRiskTransitionKind.Cleared && evaluation.Risk == PdmRiskLevel.Normal
                && evaluation.DataQuality is "Good" or "Partial")
            {
                kind = "ALARM_RECOVERED";
            }
            else if (transition == PdmRiskTransitionKind.Updated
                && evaluation.Risk == PdmRiskLevel.Critical
                && Enum.TryParse<PdmRiskLevel>(previousRiskLevel, out var former)
                && former < evaluation.Risk && evaluation.DataQuality == "Good")
            {
                kind = "ALARM_ESCALATED";
            }
        }
        if (kind == null) return;

        var eventId = Guid.NewGuid();
        var sequence = (last?.SourceSequence ?? 0) + 1;
        var at = evaluation.WindowEnd;
        if (at.Offset != TimeSpan.Zero || at == default)
            throw new InvalidOperationException("PdM integration events require committed UTC windows.");
        var summary = kind switch
        {
            "ALARM_RECOVERED" => "经连续健康窗口核验，IoTSharp 已判定设备监测风险恢复正常；不代表维修完工",
            "ALARM_ESCALATED" => "设备监测风险已升级至严重等级，需尽快进行现场复核",
            _ => "设备健康异常持续达到核验门槛，请在 IoTSharp 中核对证据"
        };
        if (isSynthetic)
            summary = "[DEV联调模拟] " + summary;
        var payload = new PdmMesEvent(
            "1.0", eventId, "IoTSharp", episode.EventKey, sequence,
            profile.TenantId, profile.CustomerId, profile.DeviceId, profile.Id, profile.Version,
            kind, evaluation.Risk.ToString(), at, at, evaluation.DataQuality, summary,
            isSynthetic, "pdm:" + eventId.ToString("N"), "/pdm/risk-events/" + episode.EventKey);
        db.IntegrationOutbox.Add(new PdmIntegrationOutbox
        {
            EventId = eventId,
            TenantId = profile.TenantId,
            CustomerId = profile.CustomerId,
            SourceEventKey = episode.EventKey,
            SourceSequence = sequence,
            EventType = kind,
            PayloadJson = JsonSerializer.Serialize(payload, JsonOptions),
            DeliveryStatus = "Pending",
            NextAttemptAtUtc = DateTime.UtcNow
        });
    }
}
