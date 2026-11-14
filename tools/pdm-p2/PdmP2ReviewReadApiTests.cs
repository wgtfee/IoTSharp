using System.Security.Claims;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmP2ReviewReadApiTests
{
    private static readonly Guid Tenant = Guid.NewGuid();
    private static readonly Guid Customer = Guid.NewGuid();

    private static IConfiguration Settings(bool active) =>
        new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["PredictiveMaintenance:Enabled"] = active.ToString(),
                ["PredictiveMaintenance:SchemaReady"] = active.ToString(),
                ["PredictiveMaintenance:SingleInstanceAcknowledged"] = active.ToString(),
                ["PredictiveMaintenance:PointMappingsApproved"] = active.ToString(),
                ["PredictiveMaintenance:HistoryQueryPlanApproved"] = active.ToString(),
                ["PredictiveMaintenance:HistoryUtcContractApproved"] = active.ToString(),
                ["PredictiveMaintenance:P2:ReadOnlyEnabled"] = active.ToString(),
                ["PredictiveMaintenance:P2:ReviewReadEnabled"] = active.ToString()
            }).Build();

    private static PdmP2ReviewReadController Controller(
        IServiceProvider provider, bool active, Guid tenant, Guid customer,
        bool authenticated = true)
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
            new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
        }, authenticated ? "SyntheticJwt" : null);
        return new PdmP2ReviewReadController(provider, Settings(active))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) }
            }
        };
    }

    [Fact]
    public void ControllerIsAuthorizeAndContainsOnlyHttpGet()
    {
        Assert.Contains(typeof(PdmP2ReviewReadController).GetCustomAttributes(true),
            x => x is AuthorizeAttribute);
        var methods = typeof(PdmP2ReviewReadController)
            .GetMethods(System.Reflection.BindingFlags.Public |
                        System.Reflection.BindingFlags.Instance)
            .Where(m => m.GetCustomAttributes(true).Any(a => a is HttpMethodAttribute))
            .ToArray();
        Assert.Single(methods);
        Assert.Contains(methods[0].GetCustomAttributes(true), a => a is HttpGetAttribute);
    }

    [Fact]
    public async Task DisabledReviewReadNeverResolvesDatabase()
    {
        using var empty = new ServiceCollection().BuildServiceProvider();
        var result = await Controller(empty, false, Tenant, Customer).GetReviews(Guid.NewGuid());
        Assert.Equal(503, Assert.IsType<ObjectResult>(result).StatusCode);
        var configuredButNoDb = await Controller(empty, true, Tenant, Customer)
            .GetReviews(Guid.NewGuid());
        Assert.Equal(503, Assert.IsType<ObjectResult>(configuredButNoDb).StatusCode);
    }

    [Fact]
    public async Task BadClaimsAndPaginationFailBeforeDatabaseRead()
    {
        using var empty = new ServiceCollection().BuildServiceProvider();
        var invalid = Controller(empty, true, Guid.Empty, Customer);
        Assert.Equal(403, Assert.IsType<ObjectResult>(
            await invalid.GetReviews(Guid.NewGuid())).StatusCode);
        var unauthenticated = Controller(empty, true, Tenant, Customer, false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(
            await unauthenticated.GetReviews(Guid.NewGuid())).StatusCode);
        var valid = Controller(empty, true, Tenant, Customer);
        Assert.IsType<BadRequestObjectResult>(
            await valid.GetReviews(Guid.Empty));
        Assert.IsType<BadRequestObjectResult>(
            await valid.GetReviews(Guid.NewGuid(), pageSize: 1000));
    }

    [Fact]
    public async Task ScopedReviewRowsAndAuditsNeverLeakForeignTenantOrDevice()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        var services = new ServiceCollection();
        services.AddDbContext<PdmP2ReviewDbContext>(o => o.UseSqlite(con));
        using var provider = services.BuildServiceProvider(validateScopes: true);
        var ownDevice = Guid.NewGuid();
        var otherDevice = Guid.NewGuid();
        await using (var scope = provider.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>();
            await db.Database.EnsureCreatedAsync();
            var ownId = Guid.NewGuid();
            db.Reviews.AddRange(
                Record(ownId, Tenant, Customer, ownDevice),
                Record(Guid.NewGuid(), Guid.NewGuid(), Customer, ownDevice),
                Record(Guid.NewGuid(), Tenant, Guid.NewGuid(), ownDevice),
                Record(Guid.NewGuid(), Tenant, Customer, otherDevice));
            db.Audits.AddRange(
                Audit(ownId, Tenant, Customer),
                Audit(ownId, Guid.NewGuid(), Customer));
            await db.SaveChangesAsync();
        }
        await using var verify = provider.CreateAsyncScope();
        var controller = Controller(verify.ServiceProvider, true, Tenant, Customer);
        var action = await controller.GetReviews(ownDevice);
        var page = Assert.IsType<ApiResult<PdmP2ReviewPageDto>>(
            Assert.IsType<OkObjectResult>(action).Value)!.Data!;
        Assert.Equal(1, page.Total);
        Assert.Single(page.Rows);
        Assert.Single(page.Audits);
        Assert.Equal(ownDevice, page.Rows[0].DeviceId);
        Assert.NotEqual(Guid.Empty, page.Rows[0].ProfileId);

        var missing = Assert.IsType<ApiResult<PdmP2ReviewPageDto>>(
            Assert.IsType<OkObjectResult>(
                await controller.GetReviews(Guid.NewGuid())).Value)!.Data!;
        Assert.Equal(0, missing.Total);
        Assert.Empty(missing.Audits);
    }

    private static PdmP2ReviewRecord Record(Guid id, Guid tenant, Guid customer, Guid device) =>
        new()
        {
            Id = id, TenantId = tenant, CustomerId = customer,
            DeviceId = device, ProfileId = Guid.NewGuid(), ProfileVersion = 1,
            RiskEventId = Guid.NewGuid(), Fingerprint = id.ToString("N") + id.ToString("N"),
            Title = "隔离测试草稿", State = "AwaitingHumanReview",
            CreatedAtUtc = DateTime.UtcNow, UpdatedAtUtc = DateTime.UtcNow
        };

    private static PdmP2ReviewAudit Audit(Guid reviewId, Guid tenant, Guid customer) =>
        new()
        {
            ReviewId = reviewId, TenantId = tenant, CustomerId = customer,
            ActorId = Guid.NewGuid(), Action = "DraftCreated", Reason = "测试审计",
            AtUtc = DateTime.UtcNow
        };
}

