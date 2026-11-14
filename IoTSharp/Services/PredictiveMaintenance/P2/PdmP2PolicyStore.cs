using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Data;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// Dedicated P2 policy catalog only. Never registered with IoTSharp's main
/// ApplicationDbContext / PdmDbContext; no automatic production migration.
/// </summary>
public sealed class PdmP2PolicyDbContext(DbContextOptions<PdmP2PolicyDbContext> options) : DbContext(options)
{
    public DbSet<PdmP2StoredPolicy> Policies => Set<PdmP2StoredPolicy>();
    public DbSet<PdmP2PolicyAudit> Audits => Set<PdmP2PolicyAudit>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        var p = b.Entity<PdmP2StoredPolicy>();
        p.ToTable("PdmP2PolicyRevision");
        p.HasKey(x => x.Id);
        p.Property(x => x.Status).HasMaxLength(32).IsRequired();
        p.Property(x => x.Revision).IsConcurrencyToken();
        p.Property(x => x.CreatedAtUtc).HasConversion(
            v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        p.Property(x => x.ReviewedAtUtc).HasConversion(
            v => v, v => v.HasValue ? DateTime.SpecifyKind(v.Value, DateTimeKind.Utc) : null);
        p.HasIndex(x => new
        {
            x.TenantId, x.CustomerId, x.ProfileId, x.ProfileVersion, x.PolicyVersion
        }).IsUnique();
        p.HasIndex(x => new { x.TenantId, x.CustomerId, x.Status });
        var a = b.Entity<PdmP2PolicyAudit>();
        a.ToTable("PdmP2PolicyAudit");
        a.HasKey(x => x.Id);
        a.Property(x => x.Action).HasMaxLength(32).IsRequired();
        a.Property(x => x.Reason).HasMaxLength(512).IsRequired();
        a.Property(x => x.AtUtc).HasConversion(
            v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        a.HasIndex(x => new { x.TenantId, x.CustomerId, x.PolicyId, x.AtUtc });
        a.HasOne<PdmP2StoredPolicy>().WithMany().HasForeignKey(x => x.PolicyId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PdmP2StoredPolicy
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid ProfileId { get; set; }
    public int ProfileVersion { get; set; }
    public int PolicyVersion { get; set; }
    public PdmRiskLevel MinimumRisk { get; set; }
    public int MinimumOccurrences { get; set; }
    public int CooldownMinutes { get; set; }
    public bool RequireGoodQuality { get; set; }
    public string Status { get; set; } = "Draft";
    public int Revision { get; set; } = 1;
    public Guid CreatedBy { get; set; }
    public Guid? ReviewedBy { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime? ReviewedAtUtc { get; set; }
    public bool ProductionEnabled { get; set; } = false;
}

public sealed class PdmP2PolicyAudit
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid PolicyId { get; set; }
    public Guid ActorId { get; set; }
    public string Action { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTime AtUtc { get; set; }
}

/// <summary>
/// Separate, transactional test-ready persistence implementation.
/// The actor is trusted only when created by an authenticated, role-checked host.
/// ReviewedForShadow is not production activation or alert delivery.
/// </summary>
public sealed class PdmP2PolicyStore(PdmP2PolicyDbContext db)
{
    private static void Authorize(PdmP2TrustedActor actor, Guid tenant, Guid customer, bool reviewer)
    {
        if (!actor.IsAuthenticated || actor.UserId == Guid.Empty ||
            actor.TenantId == Guid.Empty || actor.CustomerId == Guid.Empty ||
            actor.TenantId != tenant || actor.CustomerId != customer ||
            (reviewer ? !actor.CanReview : !actor.CanSubmitDraft))
            throw new UnauthorizedAccessException("P2 policy action scope or role mismatch");
    }

    public async Task<PdmP2StoredPolicy> CreateAsync(PdmDeviceProfile profile,
        PdmAlertPolicy policy, int policyVersion, PdmP2TrustedActor actor,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        Authorize(actor, profile.TenantId, profile.CustomerId, false);
        var validated = PdmP2PolicyCatalog.Draft(
            profile, policy, policyVersion, actor.TenantId, actor.CustomerId,
            actor.UserId, DateTime.UtcNow);
        var previous = await db.Policies.AsNoTracking().SingleOrDefaultAsync(x =>
            x.TenantId == actor.TenantId && x.CustomerId == actor.CustomerId &&
            x.ProfileId == profile.Id && x.ProfileVersion == profile.Version &&
            x.PolicyVersion == policyVersion, ct);
        if (previous is not null)
            throw new InvalidOperationException("Version already exists; policy versions are immutable");
        var item = new PdmP2StoredPolicy
        {
            TenantId = validated.TenantId, CustomerId = validated.CustomerId,
            ProfileId = validated.ProfileId, ProfileVersion = validated.ProfileVersion,
            PolicyVersion = validated.PolicyVersion,
            MinimumRisk = policy.MinimumRisk,
            MinimumOccurrences = policy.MinimumOccurrences,
            CooldownMinutes = policy.CooldownMinutes,
            RequireGoodQuality = policy.RequireGoodQuality,
            CreatedBy = actor.UserId, CreatedAtUtc = validated.CreatedAtUtc,
            Status = "Draft"
        };
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.Policies.Add(item);
        db.Audits.Add(new PdmP2PolicyAudit
        {
            TenantId = item.TenantId, CustomerId = item.CustomerId,
            PolicyId = item.Id, ActorId = actor.UserId, Action = "DraftCreated",
            Reason = "仅 Shadow 草稿", AtUtc = item.CreatedAtUtc
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return item;
    }

    public async Task<PdmP2StoredPolicy> ReviewAsync(
        Guid id, int expectedRevision, bool accept, string reason,
        PdmP2TrustedActor actor, CancellationToken ct = default)
    {
        Authorize(actor, actor.TenantId, actor.CustomerId, true);
        if (id == Guid.Empty || expectedRevision < 1 ||
            string.IsNullOrWhiteSpace(reason) || reason.Length > 512)
            throw new ArgumentException("Reason and expected revision are required");
        var item = await db.Policies.SingleOrDefaultAsync(x =>
            x.Id == id && x.TenantId == actor.TenantId &&
            x.CustomerId == actor.CustomerId, ct)
            ?? throw new UnauthorizedAccessException("Policy not found in actor scope");
        if (item.Revision != expectedRevision || item.Status != "Draft")
            throw new DbUpdateConcurrencyException("Policy revision already decided or changed");
        if (item.CreatedBy == actor.UserId || item.ProductionEnabled)
            throw new UnauthorizedAccessException("Author cannot review own policy");
        item.Status = accept ? "ReviewedForShadow" : "Withdrawn";
        item.ReviewedBy = actor.UserId;
        item.ReviewedAtUtc = DateTime.UtcNow;
        item.Revision++;
        db.Audits.Add(new PdmP2PolicyAudit
        {
            TenantId = item.TenantId, CustomerId = item.CustomerId,
            PolicyId = item.Id, ActorId = actor.UserId,
            Action = item.Status, Reason = reason, AtUtc = item.ReviewedAtUtc.Value
        });
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return item;
    }

    public async Task<PdmAlertPolicy?> ResolveShadowAsync(
        PdmDeviceProfile profile, PdmP2TrustedActor actor, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        Authorize(actor, profile.TenantId, profile.CustomerId, false);
        var matches = await db.Policies.AsNoTracking().Where(p =>
            p.TenantId == actor.TenantId && p.CustomerId == actor.CustomerId &&
            p.ProfileId == profile.Id && p.ProfileVersion == profile.Version &&
            p.Status == "ReviewedForShadow" && !p.ProductionEnabled)
            .OrderByDescending(p => p.PolicyVersion).Take(1).ToListAsync(ct);
        if (matches.Count == 0) return null;
        var p = matches[0];
        return new PdmAlertPolicy(p.MinimumRisk, p.MinimumOccurrences,
            p.CooldownMinutes, p.RequireGoodQuality);
    }
}

