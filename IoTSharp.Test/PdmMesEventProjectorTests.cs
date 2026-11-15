using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.Integration;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.Test;

/// <summary>Pure in-memory lifecycle regression; no network, PLC, MES or production database.</summary>
public sealed class PdmMesEventProjectorTests
{
    [Fact]
    public async Task AlertEscalationAndRecovery_ProduceOneDurableEventEach_InOrder()
    {
        var options = new DbContextOptionsBuilder<PdmDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString("N")).Options;
        await using var db = new PdmDbContext(options);
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var device = Guid.NewGuid();
        var profile = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device,
            Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
            Version = 3
        };
        db.DeviceProfiles.Add(profile);
        var episode = new PdmRiskEvent
        {
            TenantId = tenant, CustomerId = customer, DeviceId = device,
            ProfileId = profile.Id, ProfileVersion = profile.Version,
            EventKey = "trusted-episode-123",
            Status = "Open", RiskType = "device-health", RiskLevel = "Warning",
            OccurrenceCount = 2
        };
        db.RiskEvents.Add(episode);
        await db.SaveChangesAsync();
        var first = new DateTimeOffset(2026, 11, 14, 8, 0, 0, TimeSpan.Zero);

        PdmHealthEvaluation Evaluation(DateTimeOffset end, PdmRiskLevel risk, string quality = "Good")
            => new(tenant, customer, device, end.AddMinutes(-15), end, quality, 75,
                risk, 1, Array.Empty<PdmPointAssessment>(), Array.Empty<string>());

        await PdmMesEventProjector.TryAppendAsync(db, profile, episode, Evaluation(first, PdmRiskLevel.Warning),
            PdmRiskTransitionKind.Updated, "Warning", default);
        await db.SaveChangesAsync();
        var open = await db.IntegrationOutbox.SingleAsync();
        Assert.Equal("ALARM_OPENED", open.EventType);
        Assert.Equal(1, open.SourceSequence);

        episode.OccurrenceCount = 3;
        episode.RiskLevel = "Critical";
        await PdmMesEventProjector.TryAppendAsync(db, profile, episode,
            Evaluation(first.AddMinutes(15), PdmRiskLevel.Critical),
            PdmRiskTransitionKind.Updated, "Warning", default);
        await db.SaveChangesAsync();

        episode.Status = "Cleared";
        await PdmMesEventProjector.TryAppendAsync(db, profile, episode,
            Evaluation(first.AddMinutes(30), PdmRiskLevel.Normal),
            PdmRiskTransitionKind.Cleared, "Critical", default);
        await db.SaveChangesAsync();

        var events = await db.IntegrationOutbox.OrderBy(x => x.SourceSequence).ToListAsync();
        Assert.Equal(3, events.Count);
        Assert.Equal(new[] { "ALARM_OPENED", "ALARM_ESCALATED", "ALARM_RECOVERED" },
            events.Select(x => x.EventType));
        Assert.Equal(new long[] { 1, 2, 3 }, events.Select(x => x.SourceSequence));
        Assert.Single(events.Select(x => x.SourceEventKey).Distinct());
        Assert.Equal(3, events.Select(x => x.EventId).Distinct().Count());

        using var recovered = JsonDocument.Parse(events[2].PayloadJson);
        Assert.Equal("ALARM_RECOVERED", recovered.RootElement.GetProperty("eventType").GetString());
        Assert.Equal("Normal", recovered.RootElement.GetProperty("riskLevel").GetString());
        Assert.Equal(false, recovered.RootElement.GetProperty("isSynthetic").GetBoolean());

        // Same recovered state cannot reopen the closed episode or duplicate the notice.
        await PdmMesEventProjector.TryAppendAsync(db, profile, episode,
            Evaluation(first.AddMinutes(45), PdmRiskLevel.Normal),
            PdmRiskTransitionKind.NoChange, "Normal", default);
        await db.SaveChangesAsync();
        Assert.Equal(3, await db.IntegrationOutbox.CountAsync());
    }

    [Fact]
    public async Task UnverifiedAndSingleWindowRisks_NeverEmitExternalAlarm()
    {
        var options = new DbContextOptionsBuilder<PdmDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString("N")).Options;
        await using var db = new PdmDbContext(options);
        var profile = new PdmDeviceProfile
        {
            TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
            Enabled = true, PointMappingsVerified = false, RunStateVerified = true
        };
        var episode = new PdmRiskEvent
        {
            TenantId = profile.TenantId, CustomerId = profile.CustomerId,
            DeviceId = profile.DeviceId, ProfileId = profile.Id,
            ProfileVersion = profile.Version, EventKey = "not-approved", Status = "Open",
            RiskLevel = "Critical", OccurrenceCount = 1
        };
        var end = new DateTimeOffset(2026, 11, 14, 9, 0, 0, TimeSpan.Zero);
        var evaluation = new PdmHealthEvaluation(profile.TenantId, profile.CustomerId,
            profile.DeviceId, end.AddMinutes(-15), end, "Good", 45,
            PdmRiskLevel.Critical, 1, Array.Empty<PdmPointAssessment>(), Array.Empty<string>());
        await PdmMesEventProjector.TryAppendAsync(db, profile, episode, evaluation,
            PdmRiskTransitionKind.Opened, null, default);
        await db.SaveChangesAsync();
        Assert.Empty(await db.IntegrationOutbox.ToListAsync());

        profile.PointMappingsVerified = true;
        await PdmMesEventProjector.TryAppendAsync(db, profile, episode, evaluation,
            PdmRiskTransitionKind.Opened, null, default);
        await db.SaveChangesAsync();
        Assert.Empty(await db.IntegrationOutbox.ToListAsync());
    }
}
