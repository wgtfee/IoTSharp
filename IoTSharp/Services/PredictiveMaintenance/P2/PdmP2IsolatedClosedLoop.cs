using System;
using System.Data;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.Data.Sqlite;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// Database-backed *local sandbox* alert/work-order lifecycle.
/// This is a pure planning and manual simulation surface: NO notification sender,
/// work-order transport, PLC/MES command, production DI or background worker.
/// Never accept this ledger as evidence of actual alarm delivery or external dispatch.
/// </summary>
public sealed record PdmSandboxAlertRow(
    string Key, Guid TenantId, Guid CustomerId, Guid DeviceId, Guid RiskEventId,
    string EpisodeKey, PdmRiskLevel Level, DateTimeOffset AtUtc, string State,
    bool IsNotificationDelivered = false);

public sealed record PdmSandboxOrderRow(
    string Key, Guid TenantId, Guid CustomerId, Guid DeviceId, Guid RiskEventId,
    Guid ReviewId, string State, Guid PlanningReviewer, Guid? ManualOperator,
    bool IsExternalWorkOrderCreated = false);

public sealed record PdmSandboxAlertOutcome(
    PdmAlertDecisionKind Decision, string Reason, PdmSandboxAlertRow? Proposed,
    bool IsNotificationDelivered = false);

public sealed class PdmP2IsolatedClosedLoop(SqliteConnection db)
{
    private static string G(Guid id) => id.ToString("N");
    private static string Utc(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);

    private void EnsureIsolatedFile()
    {
        // A non-memory SQLite file under the OS temp directory, with an explicit
        // sandbox-specific name, is the ONLY persistence destination.
        var path = Path.GetFullPath(db.DataSource);
        var temp = Path.GetFullPath(Path.GetTempPath());
        if (db.State != ConnectionState.Open ||
            !path.StartsWith(temp, StringComparison.OrdinalIgnoreCase) ||
            Path.GetDirectoryName(path)?.TrimEnd(Path.DirectorySeparatorChar)
                != temp.TrimEnd(Path.DirectorySeparatorChar) ||
            !Path.GetFileName(path).StartsWith("pdm-closedloop-sandbox-", StringComparison.Ordinal) ||
            !path.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Closed-loop writes require an isolated OS-temp sandbox SQLite file.");
    }

    /// <summary>
    /// Sandbox-only DDL. No production database migration or main DbContext changes.
    /// </summary>
    public async Task InitializeSandboxAsync(CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        await using var command = db.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS PdmSandboxAlertProposal(
              Key TEXT PRIMARY KEY,
              Tenant TEXT NOT NULL, Customer TEXT NOT NULL, Device TEXT NOT NULL,
              RiskEvent TEXT NOT NULL, Profile TEXT NOT NULL, ProfileVersion INTEGER NOT NULL,
              EpisodeKey TEXT NOT NULL, Level INTEGER NOT NULL,
              AtUtc TEXT NOT NULL, State TEXT NOT NULL
                 CHECK(State IN ('ProposalOpen','ResolvedInSandbox')),
              UNIQUE(Tenant,Customer,Profile,ProfileVersion,EpisodeKey,AtUtc)
            );
            CREATE INDEX IF NOT EXISTS IX_PdmSandboxAlert_Episode
              ON PdmSandboxAlertProposal(Tenant,Customer,Device,RiskEvent,AtUtc);
            CREATE TABLE IF NOT EXISTS PdmSandboxOrderLifecycle(
              Key TEXT PRIMARY KEY,
              Tenant TEXT NOT NULL, Customer TEXT NOT NULL, Device TEXT NOT NULL,
              RiskEvent TEXT NOT NULL, EpisodeKey TEXT NOT NULL,
              Review TEXT NOT NULL, PlanningReviewer TEXT NOT NULL,
              State TEXT NOT NULL
                 CHECK(State IN ('DraftAwaitingManualDispatch','StartedInSandbox','ClosedInSandbox')),
              ManualOperator TEXT NULL, Title TEXT NOT NULL,
              UNIQUE(Tenant,Customer,Device,RiskEvent)
            );
            CREATE INDEX IF NOT EXISTS IX_PdmSandboxOrder_Scope
              ON PdmSandboxOrderLifecycle(Tenant,Customer,Device,RiskEvent);
            """;
        await command.ExecuteNonQueryAsync(ct);
    }

    private static void Authorize(PdmP2TrustedActor actor, Guid tenant, Guid customer)
    {
        if (actor is null || !actor.IsAuthenticated || !actor.CanReview ||
            actor.UserId == Guid.Empty || tenant == Guid.Empty || customer == Guid.Empty ||
            actor.TenantId != tenant || actor.CustomerId != customer)
            throw new UnauthorizedAccessException("Closed-loop manual action requires a scoped, authenticated reviewer.");
    }

    private static void ValidateEpisode(PdmDeviceProfile profile, PdmRiskEvent episode)
    {
        if (profile is null || episode is null ||
            profile.Id == Guid.Empty || episode.Id == Guid.Empty ||
            profile.TenantId == Guid.Empty || profile.CustomerId == Guid.Empty ||
            profile.DeviceId == Guid.Empty || profile.Version < 1 ||
            episode.TenantId != profile.TenantId ||
            episode.CustomerId != profile.CustomerId ||
            episode.DeviceId != profile.DeviceId ||
            episode.ProfileId != profile.Id ||
            episode.ProfileVersion != profile.Version ||
            episode.RiskType != PdmRiskEventTransitions.HealthRiskType ||
            string.IsNullOrWhiteSpace(episode.EventKey) ||
            episode.EventKey.Length > 128)
            throw new InvalidOperationException("Untrusted profile or risk episode scope.");
    }

    /// <summary>
    /// Converts an existing P1 event and P2 policy verdict to an idempotent,
    /// durable *proposal*. Cooldowns refer to preceding proposals, not delivery.
    /// Only controlled offline invokers may use this service.
    /// </summary>
    public async Task<PdmSandboxAlertOutcome> ObserveAsync(
        PdmDeviceProfile profile, PdmRiskEvent episode,
        PdmHealthEvaluation evaluation, PdmAlertPolicy policy,
        CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        ct.ThrowIfCancellationRequested();
        ValidateEpisode(profile, episode);
        ArgumentNullException.ThrowIfNull(evaluation);
        ArgumentNullException.ThrowIfNull(policy);
        if (episode.Status != "Open" ||
            evaluation.WindowEnd.Offset != TimeSpan.Zero ||
            evaluation.WindowStart.Offset != TimeSpan.Zero)
            return new(PdmAlertDecisionKind.Held, "Only open, UTC risk episodes can be proposed.", null);

        await using var tx = await db.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        // The previous proposal is read WITHIN the same write transaction to
        // serialize cool-down checks across independent coordinator instances.
        PdmSandboxAlertRow? latest = null;
        await using (var lookup = db.CreateCommand())
        {
            lookup.Transaction = (SqliteTransaction)tx;
            lookup.CommandText = """
                SELECT Key,Tenant,Customer,Device,RiskEvent,EpisodeKey,Level,AtUtc,State
                FROM PdmSandboxAlertProposal
                WHERE Tenant=$tenant AND Customer=$customer AND Device=$device
                  AND RiskEvent=$event AND Profile=$profile AND ProfileVersion=$version
                  AND EpisodeKey=$episode
                ORDER BY AtUtc DESC LIMIT 1
                """;
            lookup.Parameters.AddWithValue("$tenant", G(profile.TenantId));
            lookup.Parameters.AddWithValue("$customer", G(profile.CustomerId));
            lookup.Parameters.AddWithValue("$device", G(profile.DeviceId));
            lookup.Parameters.AddWithValue("$event", G(episode.Id));
            lookup.Parameters.AddWithValue("$profile", G(profile.Id));
            lookup.Parameters.AddWithValue("$version", profile.Version);
            lookup.Parameters.AddWithValue("$episode", episode.EventKey);
            await using var reader = await lookup.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct)) latest = MapAlert(reader);
        }
        var lastAt = latest?.AtUtc;
        var lastLevel = latest?.Level ?? PdmRiskLevel.Unknown;
        var decision = PdmAlertPolicyEngine.Decide(
            profile, episode, evaluation, policy, lastAt, lastLevel);
        if (!decision.RequiresNotificationProposal)
        {
            await tx.CommitAsync(ct);
            return new(decision.Kind, decision.Reason, null);
        }
        if (decision.IdempotencyKey is not { Length: 64 } key)
            throw new InvalidOperationException("P2 alert policy returned an invalid proposal key.");
        await using (var insert = db.CreateCommand())
        {
            insert.Transaction = (SqliteTransaction)tx;
            insert.CommandText = """
                INSERT OR IGNORE INTO PdmSandboxAlertProposal
                  (Key,Tenant,Customer,Device,RiskEvent,Profile,ProfileVersion,
                   EpisodeKey,Level,AtUtc,State)
                VALUES ($key,$tenant,$customer,$device,$event,$profile,$version,
                        $episode,$level,$at,'ProposalOpen')
                """;
            insert.Parameters.AddWithValue("$key", key);
            insert.Parameters.AddWithValue("$tenant", G(profile.TenantId));
            insert.Parameters.AddWithValue("$customer", G(profile.CustomerId));
            insert.Parameters.AddWithValue("$device", G(profile.DeviceId));
            insert.Parameters.AddWithValue("$event", G(episode.Id));
            insert.Parameters.AddWithValue("$profile", G(profile.Id));
            insert.Parameters.AddWithValue("$version", profile.Version);
            insert.Parameters.AddWithValue("$episode", episode.EventKey);
            insert.Parameters.AddWithValue("$level", (int)evaluation.Risk);
            insert.Parameters.AddWithValue("$at", Utc(evaluation.WindowEnd));
            if (await insert.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("Alert key/window collision: refusing duplicate or conflicting proposal.");
        }
        await tx.CommitAsync(ct);
        return new(decision.Kind, decision.Reason, new(
            key, profile.TenantId, profile.CustomerId, profile.DeviceId,
            episode.Id, episode.EventKey, evaluation.Risk, evaluation.WindowEnd, "ProposalOpen"));
    }

    /// <summary>
    /// Requires the existing P1 event to have been fully cleared by its
    /// consecutive-good-window rule. Does NOT automatically close a work order.
    /// </summary>
    public async Task<int> RecordRecoveryAsync(
        PdmDeviceProfile profile, PdmRiskEvent clearedEpisode,
        CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        ValidateEpisode(profile, clearedEpisode);
        if (clearedEpisode.Status != "Cleared" ||
            clearedEpisode.RecoveryStreak < 1 ||
            !clearedEpisode.ClearedAtUtc.HasValue ||
            clearedEpisode.ClearedAtUtc.Value.Kind != DateTimeKind.Utc ||
            clearedEpisode.ClearedAtUtc.Value < clearedEpisode.LastObservedUtc)
            throw new InvalidOperationException("Risk must first be confirmed cleared by P1.");
        await using var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE PdmSandboxAlertProposal SET State='ResolvedInSandbox'
            WHERE Tenant=$tenant AND Customer=$customer AND Device=$device
              AND RiskEvent=$event AND Profile=$profile AND ProfileVersion=$version
              AND EpisodeKey=$episode AND State='ProposalOpen' AND AtUtc<=$cleared
            """;
        cmd.Parameters.AddWithValue("$tenant", G(profile.TenantId));
        cmd.Parameters.AddWithValue("$customer", G(profile.CustomerId));
        cmd.Parameters.AddWithValue("$device", G(profile.DeviceId));
        cmd.Parameters.AddWithValue("$event", G(clearedEpisode.Id));
        cmd.Parameters.AddWithValue("$profile", G(profile.Id));
        cmd.Parameters.AddWithValue("$version", profile.Version);
        cmd.Parameters.AddWithValue("$episode", clearedEpisode.EventKey);
        cmd.Parameters.AddWithValue("$cleared", clearedEpisode.ClearedAtUtc.Value.ToString("O", CultureInfo.InvariantCulture));
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// ONLY a scoped, separately reviewed, persisted P2 planning record may
    /// generate one sandbox draft per risk episode. No dispatch occurs here.
    /// </summary>
    public async Task<PdmSandboxOrderRow> PrepareOrderDraftAsync(
        PdmRiskEvent episode, PdmP2ReviewRecord record,
        PdmP2ReviewAudit creationAudit, PdmP2ReviewAudit approvalAudit,
        PdmP2TrustedActor actor, CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        ct.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(episode);
        ArgumentNullException.ThrowIfNull(record);
        ArgumentNullException.ThrowIfNull(creationAudit);
        ArgumentNullException.ThrowIfNull(approvalAudit);
        Authorize(actor, record.TenantId, record.CustomerId);
        if (episode.Status != "Open" || episode.Id != record.RiskEventId ||
            episode.TenantId != record.TenantId ||
            episode.CustomerId != record.CustomerId ||
            episode.DeviceId != record.DeviceId ||
            episode.ProfileId != record.ProfileId ||
            episode.ProfileVersion != record.ProfileVersion ||
            episode.RiskType != PdmRiskEventTransitions.HealthRiskType ||
            string.IsNullOrWhiteSpace(episode.EventKey) ||
            creationAudit.Action != "DraftCreated" ||
            creationAudit.ReviewId != record.Id ||
            creationAudit.TenantId != record.TenantId ||
            creationAudit.CustomerId != record.CustomerId ||
            creationAudit.ActorId == Guid.Empty ||
            creationAudit.ActorId == approvalAudit.ActorId ||
            approvalAudit.ActorId == Guid.Empty ||
            approvalAudit.ActorId == actor.UserId)
            throw new UnauthorizedAccessException("Independent planning and dispatch reviewers required.");
        var draft = PdmWorkOrderDraftFactory.Prepare(record, approvalAudit, actor);
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        await using (var check = db.CreateCommand())
        {
            check.Transaction = (SqliteTransaction)tx;
            check.CommandText = """
                SELECT COUNT(*) FROM PdmSandboxAlertProposal
                WHERE Tenant=$tenant AND Customer=$customer AND Device=$device
                  AND RiskEvent=$event AND EpisodeKey=$episode
                """;
            check.Parameters.AddWithValue("$tenant", G(record.TenantId));
            check.Parameters.AddWithValue("$customer", G(record.CustomerId));
            check.Parameters.AddWithValue("$device", G(record.DeviceId));
            check.Parameters.AddWithValue("$event", G(episode.Id));
            check.Parameters.AddWithValue("$episode", episode.EventKey);
            if (Convert.ToInt64(await check.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) < 1)
                throw new InvalidOperationException("No persisted P2 alert proposal for this risk episode.");
        }
        await using (var insert = db.CreateCommand())
        {
            insert.Transaction = (SqliteTransaction)tx;
            insert.CommandText = """
                INSERT OR IGNORE INTO PdmSandboxOrderLifecycle
                  (Key,Tenant,Customer,Device,RiskEvent,EpisodeKey,Review,
                   PlanningReviewer,State,ManualOperator,Title)
                VALUES ($key,$tenant,$customer,$device,$event,$episode,$review,
                        $planner,'DraftAwaitingManualDispatch',NULL,$title)
                """;
            insert.Parameters.AddWithValue("$key", draft.CorrelationKey);
            insert.Parameters.AddWithValue("$tenant", G(record.TenantId));
            insert.Parameters.AddWithValue("$customer", G(record.CustomerId));
            insert.Parameters.AddWithValue("$device", G(record.DeviceId));
            insert.Parameters.AddWithValue("$event", G(episode.Id));
            insert.Parameters.AddWithValue("$episode", episode.EventKey);
            insert.Parameters.AddWithValue("$review", G(record.Id));
            insert.Parameters.AddWithValue("$planner", G(approvalAudit.ActorId));
            insert.Parameters.AddWithValue("$title", draft.Title.Length <= 300
                ? draft.Title : draft.Title[..300]);
            await insert.ExecuteNonQueryAsync(ct);
        }
        var persisted = await GetOrderInternalAsync(draft.CorrelationKey,
            record.TenantId, record.CustomerId, (SqliteTransaction)tx, ct)
            ?? throw new InvalidOperationException("Sandbox draft failed to persist.");
        if (persisted.RiskEventId != episode.Id ||
            persisted.DeviceId != record.DeviceId ||
            persisted.ReviewId != record.Id ||
            persisted.PlanningReviewer != approvalAudit.ActorId)
            throw new InvalidOperationException("Idempotency collision across approval/risk scopes.");
        await tx.CommitAsync(ct);
        return persisted;
    }

    public async Task<bool> ManualTransitionAsync(
        string key, string expectedState, bool close,
        PdmP2TrustedActor actor, CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        ArgumentNullException.ThrowIfNull(actor);
        Authorize(actor, actor.TenantId, actor.CustomerId);
        if (string.IsNullOrWhiteSpace(key) || key.Length != 64 ||
            key.Any(c => !char.IsAsciiHexDigit(c)) ||
            expectedState != (close ? "StartedInSandbox" : "DraftAwaitingManualDispatch"))
            throw new ArgumentException("Invalid manual workflow transition.");
        await using var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE PdmSandboxOrderLifecycle
            SET State=$next, ManualOperator=$actor
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
              AND State=$expected AND PlanningReviewer<>$actor
            """;
        cmd.Parameters.AddWithValue("$next", close ? "ClosedInSandbox" : "StartedInSandbox");
        cmd.Parameters.AddWithValue("$actor", G(actor.UserId));
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$tenant", G(actor.TenantId));
        cmd.Parameters.AddWithValue("$customer", G(actor.CustomerId));
        cmd.Parameters.AddWithValue("$expected", expectedState);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }

    public async Task<int> CountAlertsAsync(Guid tenant, Guid customer,
        Guid device, CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        await using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT COUNT(*) FROM PdmSandboxAlertProposal
            WHERE Tenant=$tenant AND Customer=$customer AND Device=$device
            """;
        cmd.Parameters.AddWithValue("$tenant", G(tenant));
        cmd.Parameters.AddWithValue("$customer", G(customer));
        cmd.Parameters.AddWithValue("$device", G(device));
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
    }

    public async Task<PdmSandboxAlertRow?> ReadAlertAsync(
        string key, Guid tenant, Guid customer, CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        await using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT Key,Tenant,Customer,Device,RiskEvent,EpisodeKey,Level,AtUtc,State
            FROM PdmSandboxAlertProposal
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
            """;
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$tenant", G(tenant));
        cmd.Parameters.AddWithValue("$customer", G(customer));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? MapAlert(r) : null;
    }

    public async Task<PdmSandboxOrderRow?> ReadOrderAsync(
        string key, PdmP2TrustedActor actor, CancellationToken ct = default)
    {
        EnsureIsolatedFile();
        ArgumentNullException.ThrowIfNull(actor);
        Authorize(actor, actor.TenantId, actor.CustomerId);
        return await GetOrderInternalAsync(key, actor.TenantId, actor.CustomerId, null, ct);
    }

    private async Task<PdmSandboxOrderRow?> GetOrderInternalAsync(
        string key, Guid tenant, Guid customer, SqliteTransaction? tx, CancellationToken ct)
    {
        await using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            SELECT Key,Tenant,Customer,Device,RiskEvent,Review,State,PlanningReviewer,ManualOperator
            FROM PdmSandboxOrderLifecycle
            WHERE Key=$key AND Tenant=$tenant AND Customer=$customer
            """;
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$tenant", G(tenant));
        cmd.Parameters.AddWithValue("$customer", G(customer));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new(r.GetString(0), Guid.ParseExact(r.GetString(1), "N"),
            Guid.ParseExact(r.GetString(2), "N"), Guid.ParseExact(r.GetString(3), "N"),
            Guid.ParseExact(r.GetString(4), "N"), Guid.ParseExact(r.GetString(5), "N"),
            r.GetString(6), Guid.ParseExact(r.GetString(7), "N"),
            r.IsDBNull(8) ? null : Guid.ParseExact(r.GetString(8), "N"));
    }

    private static PdmSandboxAlertRow MapAlert(SqliteDataReader r) =>
        new(r.GetString(0), Guid.ParseExact(r.GetString(1), "N"),
            Guid.ParseExact(r.GetString(2), "N"), Guid.ParseExact(r.GetString(3), "N"),
            Guid.ParseExact(r.GetString(4), "N"), r.GetString(5),
            (PdmRiskLevel)r.GetInt32(6),
            DateTimeOffset.Parse(r.GetString(7), CultureInfo.InvariantCulture),
            r.GetString(8));
}
