using IoTSharp.Services.PredictiveMaintenance.P2;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmWorkOrderSandboxIntegrationTests
{
    private const string TestBearer = "only-synthetic-sandbox-token";
    private sealed class TokenValidator : IPdmSandboxWorkOrderTokenValidator
    {
        public bool IsValid(string token, PdmP2TrustedActor actor) =>
            token == TestBearer && actor.IsAuthenticated && actor.UserId != Guid.Empty;
    }
    private sealed class FakeTransport(int transientFailures = 0, bool alwaysFail = false)
        : IPdmSandboxWorkOrderTransport
    {
        public int Calls { get; private set; }
        public async Task<bool> SimulateSendAsync(
            PdmWorkOrderDraft draft, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Yield();
            Calls++;
            if (alwaysFail) throw new InvalidOperationException("fake transport offline");
            if (Calls <= transientFailures) return false;
            return true;
        }
    }

    private static (PdmWorkOrderDraft Draft, PdmP2TrustedActor Actor) Fixture()
    {
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var actor = new PdmP2TrustedActor(
            tenant, customer, Guid.NewGuid(), true, false, true);
        var draft = new PdmWorkOrderDraft(
            tenant, customer, Guid.NewGuid(), Guid.NewGuid(),
            new string('a', 64), "设备复核", "审批仅供规划");
        return (draft, actor);
    }

    [Fact]
    public async Task SyntheticTokenAndScopedIdempotencyAllowOnlyInMemoryReceipt()
    {
        var (draft, actor) = Fixture();
        var fake = new FakeTransport();
        var service = new PdmSandboxWorkOrderCoordinator(new TokenValidator(), fake);
        var first = await service.PreviewAsync(draft, actor, TestBearer);
        var again = await service.PreviewAsync(draft, actor, TestBearer);
        Assert.Equal(first, again);
        Assert.Equal(1, fake.Calls);
        Assert.Equal(PdmSandboxWorkOrderState.AcceptedForSimulation, first.State);
        Assert.False(first.IsExternalOrderCreated);
        Assert.False(first.IsProductionNotificationSent);
    }

    [Fact]
    public async Task SyntheticTransientFailureRetriesWithinFixedBudget()
    {
        var (draft, actor) = Fixture();
        var fake = new FakeTransport(transientFailures: 2);
        var service = new PdmSandboxWorkOrderCoordinator(new TokenValidator(), fake);
        var receipt = await service.PreviewAsync(draft, actor, TestBearer);
        Assert.Equal(3, receipt.Attempts);
        Assert.Equal(3, fake.Calls);
        Assert.Equal(PdmSandboxWorkOrderState.AcceptedForSimulation, receipt.State);
    }

    [Fact]
    public async Task ExhaustionCompensatesInMemoryNeverClaimsExternalSuccess()
    {
        var (draft, actor) = Fixture();
        var fake = new FakeTransport(alwaysFail: true);
        var service = new PdmSandboxWorkOrderCoordinator(new TokenValidator(), fake);
        var receipt = await service.PreviewAsync(draft, actor, TestBearer);
        var again = await service.PreviewAsync(draft, actor, TestBearer);
        Assert.Equal(PdmSandboxWorkOrderState.CompensatedInMemory, receipt.State);
        Assert.False(receipt.IsExternalOrderCreated);
        Assert.Equal(3, fake.Calls);
        Assert.Equal(receipt, again);
    }

    [Fact]
    public async Task ForgedTokenAndForeignTenantCannotDispatch()
    {
        var (draft, actor) = Fixture();
        var service = new PdmSandboxWorkOrderCoordinator(
            new TokenValidator(), new FakeTransport());
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            service.PreviewAsync(draft, actor, "forged"));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            service.PreviewAsync(draft, actor with { TenantId = Guid.NewGuid() }, TestBearer));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            service.PreviewAsync(draft, actor with { CanReview = false }, TestBearer));
    }

    [Fact]
    public async Task CancellationNeverProducesCompensatedOrSuccessReceipt()
    {
        var (draft, actor) = Fixture();
        var fake = new FakeTransport();
        var service = new PdmSandboxWorkOrderCoordinator(new TokenValidator(), fake);
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            service.PreviewAsync(draft, actor, TestBearer, cts.Token));
        Assert.Equal(0, fake.Calls);
    }

    [Fact]
    public async Task SameSyntheticCorrelationFromDifferentTenantCannotShareReceipt()
    {
        var (draft, actor) = Fixture();
        var fake = new FakeTransport();
        var service = new PdmSandboxWorkOrderCoordinator(new TokenValidator(), fake);
        var own = await service.PreviewAsync(draft, actor, TestBearer);
        var foreignDraft = draft with { TenantId = Guid.NewGuid() };
        var foreignActor = actor with { TenantId = foreignDraft.TenantId };
        var other = await service.PreviewAsync(foreignDraft, foreignActor, TestBearer);
        Assert.Equal(2, fake.Calls);
        Assert.Equal(own.CorrelationKey, other.CorrelationKey);
        Assert.NotEqual(own.TenantId, other.TenantId);
        Assert.False(other.IsExternalOrderCreated);
    }
}

