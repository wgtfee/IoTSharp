using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmPolicyCatalogTests
{
    private static PdmDeviceProfile Profile() => new()
    {
        TenantId = Guid.NewGuid(), CustomerId = Guid.NewGuid(),
        Version = 2, Enabled = true, PointMappingsVerified = true, RunStateVerified = true
    };

    [Fact]
    public void DraftAndIndependentReview_AreVersionedAndShadowOnly()
    {
        var p = Profile();
        var author = Guid.NewGuid();
        var reviewer = Guid.NewGuid();
        var now = DateTime.UtcNow;
        var draft = PdmP2PolicyCatalog.Draft(
            p, new PdmAlertPolicy(MinimumOccurrences: 3, CooldownMinutes: 90),
            7, p.TenantId, p.CustomerId, author, now);
        Assert.Equal(PdmP2PolicyStatus.Draft, draft.Status);
        Assert.False(draft.ProductionEnabled);
        var approved = PdmP2PolicyCatalog.ReviewForShadow(
            draft, p.TenantId, p.CustomerId, reviewer, true, now.AddSeconds(1));
        Assert.Equal(PdmP2PolicyStatus.ReviewedForShadow, approved.Status);
        Assert.False(approved.ProductionEnabled);
        Assert.Equal(7, approved.PolicyVersion);
        Assert.Equal(3, PdmP2PolicyCatalog.ResolveReadOnly(approved, p).MinimumOccurrences);
        Assert.Equal(PdmP2PolicyStatus.Draft, draft.Status);
    }

    [Fact]
    public void UnknownOrInvalidAlertLimits_AreRejected()
    {
        var p = Profile();
        var author = Guid.NewGuid();
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.Draft(p, new PdmAlertPolicy(CooldownMinutes: -1),
                1, p.TenantId, p.CustomerId, author, DateTime.UtcNow));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.Draft(p, new PdmAlertPolicy(MinimumOccurrences: 0),
                1, p.TenantId, p.CustomerId, author, DateTime.UtcNow));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.Draft(p, new PdmAlertPolicy(), 0,
                p.TenantId, p.CustomerId, author, DateTime.UtcNow));
    }

    [Fact]
    public void CrossTenantAndUnsignedApprovalCannotPublishPolicy()
    {
        var p = Profile();
        var author = Guid.NewGuid();
        var draft = PdmP2PolicyCatalog.Draft(
            p, new PdmAlertPolicy(), 1,
            p.TenantId, p.CustomerId, author, DateTime.UtcNow);
        Assert.Throws<UnauthorizedAccessException>(() =>
            PdmP2PolicyCatalog.ReviewForShadow(
                draft, Guid.NewGuid(), p.CustomerId, Guid.NewGuid(), true, DateTime.UtcNow));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.ReviewForShadow(
                draft, p.TenantId, p.CustomerId, author, true, DateTime.UtcNow));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.ReviewForShadow(
                draft, p.TenantId, p.CustomerId, Guid.NewGuid(), false, DateTime.UtcNow));
        Assert.Throws<InvalidOperationException>(() =>
            PdmP2PolicyCatalog.ResolveReadOnly(draft, p));
    }

    [Fact]
    public void WithdrawnAndChangedProfileVersion_FailClosed()
    {
        var p = Profile();
        var author = Guid.NewGuid();
        var draft = PdmP2PolicyCatalog.Draft(p, new(), 3,
            p.TenantId, p.CustomerId, author, DateTime.UtcNow);
        var signed = PdmP2PolicyCatalog.ReviewForShadow(draft, p.TenantId, p.CustomerId,
            Guid.NewGuid(), true, DateTime.UtcNow.AddSeconds(5));
        p.Version++;
        Assert.Throws<InvalidOperationException>(() => PdmP2PolicyCatalog.ResolveReadOnly(signed, p));
        p.Version--;
        var withdrawn = PdmP2PolicyCatalog.Withdraw(signed, p.TenantId, p.CustomerId,
            Guid.NewGuid(), true);
        Assert.Equal(PdmP2PolicyStatus.Withdrawn, withdrawn.Status);
        Assert.Throws<InvalidOperationException>(() => PdmP2PolicyCatalog.ResolveReadOnly(withdrawn, p));
    }
}

