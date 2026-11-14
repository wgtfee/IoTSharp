using System;
using IoTSharp.Data;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

public enum PdmP2PolicyStatus { Draft, ReviewedForShadow, Withdrawn }

/// <summary>
/// Immutable, scoped, versioned alert policy. ReviewedForShadow does not activate
/// notification delivery or enable the production PdM worker.
/// </summary>
public sealed record PdmP2PolicyRevision(
    Guid TenantId, Guid CustomerId, Guid ProfileId, int ProfileVersion,
    int PolicyVersion, PdmAlertPolicy Policy, PdmP2PolicyStatus Status,
    Guid CreatedBy, Guid? ReviewedBy, DateTime CreatedAtUtc,
    DateTime? ReviewedAtUtc, bool ProductionEnabled = false);

public static class PdmP2PolicyCatalog
{
    private static void Scope(Guid tenant, Guid customer, Guid actorTenant,
        Guid actorCustomer, Guid actorId)
    {
        if (tenant == Guid.Empty || customer == Guid.Empty || actorId == Guid.Empty ||
            tenant != actorTenant || customer != actorCustomer)
            throw new UnauthorizedAccessException("P2 policy actor scope does not match");
    }

    public static PdmP2PolicyRevision Draft(
        PdmDeviceProfile profile, PdmAlertPolicy policy, int nextVersion,
        Guid actorTenant, Guid actorCustomer, Guid authorId, DateTime nowUtc)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(policy);
        Scope(profile.TenantId, profile.CustomerId, actorTenant, actorCustomer, authorId);
        if (profile.Id == Guid.Empty || profile.Version < 1 ||
            nextVersion is < 1 or > 100_000 ||
            nowUtc.Kind != DateTimeKind.Utc ||
            policy.MinimumRisk is < PdmRiskLevel.Attention or > PdmRiskLevel.Critical ||
            policy.MinimumOccurrences is < 1 or > 100 ||
            policy.CooldownMinutes is < 0 or > 10080 ||
            !profile.PointMappingsVerified || !profile.RunStateVerified)
            throw new InvalidOperationException("PdM policy requires valid scope, version and approved point mappings");
        return new(profile.TenantId, profile.CustomerId, profile.Id, profile.Version,
            nextVersion, policy, PdmP2PolicyStatus.Draft, authorId, null, nowUtc, null);
    }

    public static PdmP2PolicyRevision ReviewForShadow(
        PdmP2PolicyRevision revision, Guid actorTenant, Guid actorCustomer,
        Guid reviewerId, bool canReview, DateTime reviewedUtc)
    {
        ArgumentNullException.ThrowIfNull(revision);
        Scope(revision.TenantId, revision.CustomerId, actorTenant, actorCustomer, reviewerId);
        if (!canReview || reviewerId == revision.CreatedBy ||
            revision.Status != PdmP2PolicyStatus.Draft ||
            revision.ProductionEnabled ||
            reviewedUtc.Kind != DateTimeKind.Utc ||
            reviewedUtc < revision.CreatedAtUtc)
            throw new InvalidOperationException("Separate authorized human review required for a shadow policy");
        return revision with
        {
            Status = PdmP2PolicyStatus.ReviewedForShadow,
            ReviewedBy = reviewerId, ReviewedAtUtc = reviewedUtc, ProductionEnabled = false
        };
    }

    public static PdmP2PolicyRevision Withdraw(
        PdmP2PolicyRevision revision, Guid actorTenant, Guid actorCustomer,
        Guid actorId, bool canReview)
    {
        ArgumentNullException.ThrowIfNull(revision);
        Scope(revision.TenantId, revision.CustomerId, actorTenant, actorCustomer, actorId);
        if (!canReview || revision.Status == PdmP2PolicyStatus.Withdrawn)
            throw new InvalidOperationException("Only authorized reviewers can withdraw active drafts");
        return revision with { Status = PdmP2PolicyStatus.Withdrawn, ProductionEnabled = false };
    }

    public static PdmAlertPolicy ResolveReadOnly(
        PdmP2PolicyRevision revision, PdmDeviceProfile profile)
    {
        if (revision.TenantId != profile.TenantId ||
            revision.CustomerId != profile.CustomerId ||
            revision.ProfileId != profile.Id ||
            revision.ProfileVersion != profile.Version ||
            revision.Status != PdmP2PolicyStatus.ReviewedForShadow ||
            revision.ProductionEnabled)
            throw new InvalidOperationException("P2 policy revision unavailable for this scoped shadow evaluation");
        return revision.Policy;
    }
}

