using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.Data.Sqlite;
using Xunit;

namespace IoTSharp.PdM.Acceptance.ClosedLoop;

public sealed class Batch7PdmClosedLoopIntegrationTests
{
    private static readonly DateTimeOffset Clock = new(2026, 11, 14, 5, 0, 0, TimeSpan.Zero);

    private sealed class Sandbox : IAsyncDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            "pdm-closedloop-sandbox-" + Guid.NewGuid().ToString("N") + ".sqlite");
        private readonly List<SqliteConnection> _connections = [];

        public async Task<(SqliteConnection Db, PdmP2IsolatedClosedLoop Loop)> OpenAsync(bool initialize = true)
        {
            var db = new SqliteConnection("Data Source=" + Path + ";Pooling=False");
            await db.OpenAsync();
            _connections.Add(db);
            var loop = new PdmP2IsolatedClosedLoop(db);
            if (initialize) await loop.InitializeSandboxAsync();
            return (db, loop);
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var db in _connections)
                await db.DisposeAsync();
            if (File.Exists(Path)) File.Delete(Path);
        }
    }

    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(), DeviceId = Guid.NewGuid(),
        Enabled = true, PointMappingsVerified = true, RunStateVerified = true,
        Version = 7
    };

    private static PdmRiskEvent Episode(PdmDeviceProfile p) => new()
    {
        TenantId = p.TenantId, CustomerId = p.CustomerId,
        DeviceId = p.DeviceId, ProfileId = p.Id, ProfileVersion = p.Version,
        EventKey = Guid.NewGuid().ToString("N"), RiskType = "device-health",
        RiskLevel = "Warning", Status = "Open",
        LastEvaluatedWindowEndUtc = Clock.UtcDateTime,
        FirstObservedUtc = Clock.UtcDateTime, LastObservedUtc = Clock.UtcDateTime,
        OccurrenceCount = 2, EvidenceJson = "{\"origin\":\"isolated-rule-test\"}"
    };

    private static PdmHealthEvaluation Evaluation(
        PdmDeviceProfile p, DateTimeOffset end, PdmRiskLevel risk = PdmRiskLevel.Warning,
        string quality = "Good") => new(
        p.TenantId, p.CustomerId, p.DeviceId, end.AddMinutes(-15), end,
        quality, risk == PdmRiskLevel.Unknown ? null : 45,
        risk, .99, Array.Empty<PdmPointAssessment>(), Array.Empty<string>());

    private static (PdmP2ReviewRecord Record, PdmP2ReviewAudit Creation,
        PdmP2ReviewAudit Approval, PdmP2TrustedActor Operator) Reviewed(
        PdmDeviceProfile p, PdmRiskEvent e)
    {
        var created = DateTime.UtcNow.AddMinutes(-10);
        var approved = DateTime.UtcNow.AddMinutes(-5);
        var author = Guid.NewGuid();
        var planner = Guid.NewGuid();
        var record = new PdmP2ReviewRecord
        {
            TenantId = p.TenantId, CustomerId = p.CustomerId,
            DeviceId = p.DeviceId, ProfileId = p.Id, ProfileVersion = p.Version,
            RiskEventId = e.Id, State = "ApprovedForPlanning", Title = "Sandbox manual repair",
            Fingerprint = new string('b', 64), CreatedAtUtc = created, UpdatedAtUtc = approved
        };
        var creation = new PdmP2ReviewAudit
        {
            ReviewId = record.Id, TenantId = p.TenantId, CustomerId = p.CustomerId,
            ActorId = author, Action = "DraftCreated", AtUtc = created
        };
        var approval = new PdmP2ReviewAudit
        {
            ReviewId = record.Id, TenantId = p.TenantId, CustomerId = p.CustomerId,
            ActorId = planner, Action = "ApprovedForPlanning",
            AtUtc = approved, Reason = "Independent sandbox approval"
        };
        var actor = new PdmP2TrustedActor(
            p.TenantId, p.CustomerId, Guid.NewGuid(), true, false, true);
        return (record, creation, approval, actor);
    }

    [Fact]
    public async Task PersistentAlertDeduplicatesSameWindowAndCooldownOnFreshConnection()
    {
        await using var sandbox = new Sandbox();
        var p = Profile(); var e = Episode(p);
        var (_, first) = await sandbox.OpenAsync();
        var result = await first.ObserveAsync(p, e, Evaluation(p, Clock), new());
        Assert.Equal(PdmAlertDecisionKind.Notify, result.Decision);
        Assert.NotNull(result.Proposed);
        Assert.False(result.IsNotificationDelivered);
        var again = await first.ObserveAsync(p, e, Evaluation(p, Clock), new());
        Assert.Equal(PdmAlertDecisionKind.Suppressed, again.Decision);
        var (_, restarted) = await sandbox.OpenAsync(initialize: false);
        Assert.Equal(1, await restarted.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));
        e.LastEvaluatedWindowEndUtc = Clock.AddMinutes(15).UtcDateTime;
        e.OccurrenceCount++;
        var cooled = await restarted.ObserveAsync(p, e, Evaluation(p, Clock.AddMinutes(15)), new());
        Assert.Equal(PdmAlertDecisionKind.Suppressed, cooled.Decision);
        Assert.Equal(1, await restarted.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));
    }

    [Fact]
    public async Task PolicyRequiresSustainedGoodQualityAnomalyAndEscalationBypassesCooldown()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        e.OccurrenceCount = 1;
        Assert.Equal(PdmAlertDecisionKind.BelowThreshold,
            (await loop.ObserveAsync(p, e, Evaluation(p, Clock), new())).Decision);
        e.OccurrenceCount = 2;
        Assert.Equal(PdmAlertDecisionKind.Held,
            (await loop.ObserveAsync(p, e, Evaluation(p, Clock, quality: "Partial"), new())).Decision);
        Assert.Equal(PdmAlertDecisionKind.Notify,
            (await loop.ObserveAsync(p, e, Evaluation(p, Clock), new())).Decision);
        e.LastEvaluatedWindowEndUtc = Clock.AddMinutes(15).UtcDateTime;
        e.RiskLevel = "Critical";
        Assert.Equal(PdmAlertDecisionKind.Escalate,
            (await loop.ObserveAsync(p, e,
                Evaluation(p, Clock.AddMinutes(15), PdmRiskLevel.Critical), new())).Decision);
        Assert.Equal(2, await loop.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));
    }

    [Fact]
    public async Task P1TwoConsecutiveRecoveryWindowsResolveAlertsNotMaintenanceWorkOrders()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        var alert = await loop.ObserveAsync(p, e, Evaluation(p, Clock), new());
        var review = Reviewed(p, e);
        var draft = await loop.PrepareOrderDraftAsync(e,
            review.Record, review.Creation, review.Approval, review.Operator);
        var firstNormal = Evaluation(p, Clock.AddMinutes(15), PdmRiskLevel.Normal);
        Assert.Equal(PdmRiskTransitionKind.RecoveryPending,
            PdmRiskEventTransitions.Apply(e, firstNormal, p, 2, out _));
        await Assert.ThrowsAsync<InvalidOperationException>(() => loop.RecordRecoveryAsync(p, e));
        var secondNormal = Evaluation(p, Clock.AddMinutes(30), PdmRiskLevel.Normal);
        Assert.Equal(PdmRiskTransitionKind.Cleared,
            PdmRiskEventTransitions.Apply(e, secondNormal, p, 2, out _));
        Assert.Equal(1, await loop.RecordRecoveryAsync(p, e));
        Assert.Equal(0, await loop.RecordRecoveryAsync(p, e));
        var recovered = await loop.ReadAlertAsync(
            alert.Proposed!.Key, p.TenantId, p.CustomerId);
        Assert.Equal("ResolvedInSandbox", recovered!.State);
        Assert.Equal("DraftAwaitingManualDispatch",
            (await loop.ReadOrderAsync(draft.Key, review.Operator))!.State);
    }

    [Fact]
    public async Task IndependentlyApprovedEpisodeOnlyCreatesOneLocalDraftAcrossRestart()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        await loop.ObserveAsync(p, e, Evaluation(p, Clock), new());
        var review = Reviewed(p, e);
        var a = await loop.PrepareOrderDraftAsync(
            e, review.Record, review.Creation, review.Approval, review.Operator);
        Assert.Equal("DraftAwaitingManualDispatch", a.State);
        Assert.False(a.IsExternalWorkOrderCreated);
        var (_, restarted) = await sandbox.OpenAsync(initialize: false);
        var b = await restarted.PrepareOrderDraftAsync(
            e, review.Record, review.Creation, review.Approval, review.Operator);
        Assert.Equal(a, b);
        Assert.Equal(a, await restarted.ReadOrderAsync(a.Key, review.Operator));
    }

    [Fact]
    public async Task HumanStartAndCloseRequireIndependentPlanningReviewerAndAreAtomic()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        await loop.ObserveAsync(p, e, Evaluation(p, Clock), new());
        var review = Reviewed(p, e);
        var order = await loop.PrepareOrderDraftAsync(
            e, review.Record, review.Creation, review.Approval, review.Operator);
        var planner = review.Operator with { UserId = review.Approval.ActorId };
        Assert.False(await loop.ManualTransitionAsync(
            order.Key, "DraftAwaitingManualDispatch", false, planner));
        Assert.False(await loop.ManualTransitionAsync(
            order.Key, "DraftAwaitingManualDispatch", false,
            review.Operator with { TenantId = Guid.NewGuid() }));
        Assert.True(await loop.ManualTransitionAsync(
            order.Key, "DraftAwaitingManualDispatch", false, review.Operator));
        Assert.False(await loop.ManualTransitionAsync(
            order.Key, "DraftAwaitingManualDispatch", false, review.Operator));
        Assert.True(await loop.ManualTransitionAsync(
            order.Key, "StartedInSandbox", true, review.Operator));
        Assert.False(await loop.ManualTransitionAsync(
            order.Key, "StartedInSandbox", true, review.Operator));
        Assert.Equal("ClosedInSandbox", (await loop.ReadOrderAsync(order.Key, review.Operator))!.State);
    }

    [Fact]
    public async Task NoAlertAndUnreviewedOrSelfReviewedOrdersAreRejected()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        var review = Reviewed(p, e);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            loop.PrepareOrderDraftAsync(e,
                review.Record, review.Creation, review.Approval, review.Operator));
        await loop.ObserveAsync(p, e, Evaluation(p, Clock), new());
        var previousPlanner = review.Approval.ActorId;
        review.Approval.ActorId = review.Creation.ActorId;
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            loop.PrepareOrderDraftAsync(e,
                review.Record, review.Creation, review.Approval, review.Operator));
        review.Approval.ActorId = previousPlanner;
        review.Record.State = "AwaitingHumanReview";
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            loop.PrepareOrderDraftAsync(e,
                review.Record, review.Creation, review.Approval, review.Operator));
        review.Record.State = "ApprovedForPlanning";
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            loop.PrepareOrderDraftAsync(e,
                review.Record, review.Creation, review.Approval,
                review.Operator with { CustomerId = Guid.NewGuid() }));
    }

    [Fact]
    public async Task TenantCustomerSeparationAppliesToReadAndMutation()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        var proposal = await loop.ObserveAsync(p, e, Evaluation(p, Clock), new());
        Assert.Null(await loop.ReadAlertAsync(
            proposal.Proposed!.Key, Guid.NewGuid(), p.CustomerId));
        var review = Reviewed(p, e);
        var order = await loop.PrepareOrderDraftAsync(
            e, review.Record, review.Creation, review.Approval, review.Operator);
        var outsider = new PdmP2TrustedActor(
            Guid.NewGuid(), p.CustomerId, Guid.NewGuid(), true, false, true);
        Assert.Null(await loop.ReadOrderAsync(order.Key, outsider));
        Assert.False(await loop.ManualTransitionAsync(
            order.Key, "DraftAwaitingManualDispatch", false, outsider));
    }

    [Fact]
    public async Task UnknownQualityAndUntrustedProfileCannotProduceAnyAlertOrOrder()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        Assert.Equal(PdmAlertDecisionKind.Held,
            (await loop.ObserveAsync(p, e,
                Evaluation(p, Clock, PdmRiskLevel.Unknown, "Unknown"), new())).Decision);
        Assert.Equal(0, await loop.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));
        Assert.Equal(PdmAlertDecisionKind.Held,
            (await loop.ObserveAsync(withProfileUnverified(), e,
                Evaluation(p, Clock), new())).Decision);
        Assert.Equal(0, await loop.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));

        PdmDeviceProfile withProfileUnverified() => new()
        {
            Id = p.Id, TenantId = p.TenantId, CustomerId = p.CustomerId, DeviceId = p.DeviceId,
            Version = p.Version, Enabled = true, PointMappingsVerified = false,
            RunStateVerified = true
        };
    }

    [Fact]
    public async Task OutOfScopeRiskEpisodeAndReplayedExpiredCancellationAreFailClosed()
    {
        await using var sandbox = new Sandbox();
        var (_, loop) = await sandbox.OpenAsync();
        var p = Profile(); var e = Episode(p);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            loop.ObserveAsync(p, withWrongTenant(), Evaluation(p, Clock), new()));
        using var cancel = new CancellationTokenSource();
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            loop.ObserveAsync(p, e, Evaluation(p, Clock), new(), cancel.Token));
        Assert.Equal(0, await loop.CountAlertsAsync(p.TenantId, p.CustomerId, p.DeviceId));

        PdmRiskEvent withWrongTenant() => new()
        {
            Id = e.Id, TenantId = Guid.NewGuid(), CustomerId = e.CustomerId,
            DeviceId = e.DeviceId, ProfileId = e.ProfileId, ProfileVersion = e.ProfileVersion,
            EventKey = e.EventKey, RiskType = e.RiskType, Status = "Open"
        };
    }

    [Fact]
    public async Task ArbitraryDatabaseCannotBeInitializedAsSandboxClosedLoop()
    {
        var path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "pdm-real-business-" + Guid.NewGuid().ToString("N") + ".sqlite");
        try
        {
            await using var db = new SqliteConnection("Data Source=" + path + ";Pooling=False");
            await db.OpenAsync();
            var loop = new PdmP2IsolatedClosedLoop(db);
            await Assert.ThrowsAsync<InvalidOperationException>(() => loop.InitializeSandboxAsync());
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }
}
