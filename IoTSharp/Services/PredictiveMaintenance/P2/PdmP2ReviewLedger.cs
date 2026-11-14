using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

// This DbContext is purposely separate from ApplicationDbContext and PdmDbContext.
// It is NOT registered in IoTSharp startup and has no automatic production migrations.
public sealed class PdmP2ReviewDbContext(DbContextOptions<PdmP2ReviewDbContext> options) : DbContext(options)
{
    public DbSet<PdmP2ReviewRecord> Reviews => Set<PdmP2ReviewRecord>();
    public DbSet<PdmP2ReviewAudit> Audits => Set<PdmP2ReviewAudit>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        var review = builder.Entity<PdmP2ReviewRecord>();
        review.ToTable("PdmP2Review");
        review.HasKey(x => x.Id);
        review.Property(x => x.Fingerprint).HasMaxLength(64).IsRequired();
        review.Property(x => x.Title).HasMaxLength(300).IsRequired();
        review.Property(x => x.State).HasMaxLength(32).IsRequired();
        review.Property(x => x.Revision).IsConcurrencyToken();
        // SQL/SQLite datetime does not preserve DateTime.Kind; persisted writes are UTC.
        review.Property(x => x.CreatedAtUtc).HasConversion(
            v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        review.Property(x => x.UpdatedAtUtc).HasConversion(
            v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        review.HasIndex(x => new { x.TenantId, x.CustomerId, x.Fingerprint }).IsUnique();
        review.HasIndex(x => new { x.TenantId, x.CustomerId, x.DeviceId, x.CreatedAtUtc });

        var audit = builder.Entity<PdmP2ReviewAudit>();
        audit.ToTable("PdmP2ReviewAudit");
        audit.HasKey(x => x.Id);
        audit.Property(x => x.Action).HasMaxLength(36).IsRequired();
        audit.Property(x => x.Reason).HasMaxLength(512).IsRequired();
        audit.Property(x => x.AtUtc).HasConversion(
            v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        audit.HasIndex(x => new { x.TenantId, x.CustomerId, x.ReviewId, x.AtUtc });
        audit.HasOne<PdmP2ReviewRecord>().WithMany().HasForeignKey(x => x.ReviewId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PdmP2ReviewRecord
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid ProfileId { get; set; }
    public int ProfileVersion { get; set; }
    public Guid RiskEventId { get; set; }
    public string Fingerprint { get; set; } = "";
    public string Title { get; set; } = "";
    public string State { get; set; } = "AwaitingHumanReview";
    public int Revision { get; set; } = 1;
    public DateTime CreatedAtUtc { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
}

public sealed class PdmP2ReviewAudit
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ReviewId { get; set; }
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid ActorId { get; set; }
    public string Action { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTime AtUtc { get; set; }
}

public sealed record PdmP2TrustedActor(
    Guid TenantId, Guid CustomerId, Guid UserId,
    bool IsAuthenticated, bool CanSubmitDraft, bool CanReview);

/// <summary>
/// Isolated persistent review/audit ledger. A trusted backend caller must construct
/// the actor; this service is NOT an HTTP endpoint and is NOT registered in production.
/// ApprovedForPlanning is NEVER an issued work order, alert or PLC command.
/// </summary>
public sealed class PdmP2ReviewLedger(PdmP2ReviewDbContext db)
{
    private static void Authorize(PdmP2TrustedActor actor,
        Guid tenant, Guid customer, bool reviewer)
    {
        if (!actor.IsAuthenticated || actor.UserId == Guid.Empty ||
            actor.TenantId == Guid.Empty || actor.CustomerId == Guid.Empty ||
            actor.TenantId != tenant || actor.CustomerId != customer ||
            (reviewer ? !actor.CanReview : !actor.CanSubmitDraft))
            throw new UnauthorizedAccessException("P2 review scope or role is not authorized");
    }

    public async Task<PdmP2ReviewRecord> CreateDraftAsync(
        PdmReviewPacket proposal, PdmP2TrustedActor actor,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(proposal);
        Authorize(actor, proposal.TenantId, proposal.CustomerId, false);
        if (proposal.State != PdmReviewPacketState.AwaitingHumanReview ||
            proposal.IsWorkOrderCreated || proposal.IsAlertDelivered ||
            proposal.IsAuthorizedToExecute ||
            proposal.TenantId == Guid.Empty || proposal.CustomerId == Guid.Empty ||
            proposal.DeviceId == Guid.Empty || proposal.ProfileId == Guid.Empty ||
            proposal.RiskEventId == Guid.Empty || proposal.ProfileVersion < 1 ||
            proposal.Fingerprint.Length != 64 ||
            !proposal.Fingerprint.All(char.IsAsciiHexDigit) ||
            string.IsNullOrWhiteSpace(proposal.Title))
            throw new InvalidOperationException("Only complete trusted review proposals can be recorded");

        // The unique (tenant,customer,fingerprint) index is a second guard for
        // concurrent workers. The calling app must retry on a unique constraint race.
        var normalizedFingerprint = proposal.Fingerprint.ToLowerInvariant();
        var existing = await db.Reviews.SingleOrDefaultAsync(r =>
            r.TenantId == actor.TenantId && r.CustomerId == actor.CustomerId &&
            r.Fingerprint == normalizedFingerprint, cancellationToken);
        if (existing is not null)
        {
            if (existing.DeviceId != proposal.DeviceId ||
                existing.ProfileId != proposal.ProfileId ||
                existing.ProfileVersion != proposal.ProfileVersion ||
                existing.RiskEventId != proposal.RiskEventId)
                throw new InvalidOperationException("Review fingerprint collision with conflicting scope");
            return existing;
        }

        var now = DateTime.UtcNow;
        var review = new PdmP2ReviewRecord
        {
            TenantId = actor.TenantId, CustomerId = actor.CustomerId,
            DeviceId = proposal.DeviceId, ProfileId = proposal.ProfileId,
            ProfileVersion = proposal.ProfileVersion,
            RiskEventId = proposal.RiskEventId,
            Fingerprint = normalizedFingerprint,
            Title = proposal.Title.Length <= 300 ? proposal.Title : proposal.Title[..300],
            CreatedAtUtc = now, UpdatedAtUtc = now
        };
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        db.Reviews.Add(review);
        db.Audits.Add(new PdmP2ReviewAudit
        {
            ReviewId = review.Id, TenantId = actor.TenantId,
            CustomerId = actor.CustomerId, ActorId = actor.UserId,
            Action = "DraftCreated", Reason = "待人工审核，未执行任何工单或告警", AtUtc = now
        });
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
        return review;
    }

    public async Task<PdmP2ReviewRecord> DecideAsync(
        Guid reviewId, int expectedRevision, bool approveForPlanning,
        string reason, PdmP2TrustedActor actor, CancellationToken cancellationToken = default)
    {
        if (reviewId == Guid.Empty || expectedRevision < 1 ||
            string.IsNullOrWhiteSpace(reason) || reason.Length > 512)
            throw new ArgumentException("Review decision requires an explicit version and reason");
        Authorize(actor, actor.TenantId, actor.CustomerId, true);
        var review = await db.Reviews.SingleOrDefaultAsync(r =>
            r.Id == reviewId && r.TenantId == actor.TenantId &&
            r.CustomerId == actor.CustomerId, cancellationToken)
            ?? throw new UnauthorizedAccessException("Review not found in actor scope");
        var authorId = await db.Audits.AsNoTracking()
            .Where(a => a.ReviewId == review.Id &&
                        a.TenantId == actor.TenantId &&
                        a.CustomerId == actor.CustomerId &&
                        a.Action == "DraftCreated")
            .Select(a => a.ActorId)
            .SingleOrDefaultAsync(cancellationToken);
        if (authorId == Guid.Empty || authorId == actor.UserId)
            throw new UnauthorizedAccessException("Reviewer must be different from the draft author");
        if (review.State != "AwaitingHumanReview" || review.Revision != expectedRevision)
            throw new DbUpdateConcurrencyException("Review already decided or modified");
        review.State = approveForPlanning ? "ApprovedForPlanning" : "Rejected";
        review.Revision++;
        review.UpdatedAtUtc = DateTime.UtcNow;
        db.Audits.Add(new PdmP2ReviewAudit
        {
            ReviewId = review.Id, TenantId = review.TenantId, CustomerId = review.CustomerId,
            ActorId = actor.UserId, Action = review.State, Reason = reason,
            AtUtc = review.UpdatedAtUtc
        });
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);
        return review;
    }
}

