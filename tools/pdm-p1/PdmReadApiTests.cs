using System;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

public sealed class PdmReadApiTests
{
    private static readonly Guid TenantA = Guid.NewGuid();
    private static readonly Guid CustomerA = Guid.NewGuid();
    private static readonly Guid TenantB = Guid.NewGuid();
    private static readonly Guid CustomerB = Guid.NewGuid();

    private static IConfiguration Configuration(bool enabled) =>
        new ConfigurationBuilder().AddInMemoryCollection(new System.Collections.Generic.Dictionary<string,string?>
        {
            ["PredictiveMaintenance:Enabled"] = enabled.ToString(),
            ["PredictiveMaintenance:SchemaReady"] = enabled.ToString(),
            ["PredictiveMaintenance:SingleInstanceAcknowledged"] = enabled.ToString(),
            ["PredictiveMaintenance:PointMappingsApproved"] = enabled.ToString(),
            ["PredictiveMaintenance:HistoryQueryPlanApproved"] = enabled.ToString(),
            ["PredictiveMaintenance:HistoryUtcContractApproved"] = enabled.ToString()
        }).Build();

    private static PdmReadController Controller(IServiceProvider provider, bool enabled,
        Guid tenant, Guid customer, bool authenticated = true)
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
            new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
        }, authenticated ? "PdmTestJwt" : null);
        return new PdmReadController(provider, Configuration(enabled))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) }
            }
        };
    }

    [Fact]
    public async Task DisabledFeature_ExposesOnlyStatusWithoutResolvingDatabase()
    {
        using var provider = new ServiceCollection().BuildServiceProvider();
        var ctrl = Controller(provider, false, TenantA, CustomerA);
        Assert.False(ctrl.GetStatus().Value!.Data!.Configured);
        var res = await ctrl.GetOverview();
        Assert.Equal(503, Assert.IsType<ObjectResult>(res).StatusCode);
    }

    [Fact]
    public void EveryDataEndpoint_RequiresAuthorization()
    {
        Assert.NotEmpty(typeof(PdmReadController).GetCustomAttributes(typeof(AuthorizeAttribute), true));
        var methods = typeof(PdmReadController).GetMethods(System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.DeclaredOnly);
        foreach (var name in new[] { "GetStatus", "GetOverview", "GetRisks", "GetTrend", "GetProfile" })
        {
            var method = Assert.Single(methods, m => m.Name == name);
            Assert.NotEmpty(method.GetCustomAttributes(typeof(HttpGetAttribute), true));
        }
    }

    [Fact]
    public async Task MissingOrUnauthenticatedScope_IsForbiddenBeforeDatabaseLookup()
    {
        using var provider = new ServiceCollection().BuildServiceProvider();
        var ctrl = Controller(provider, true, Guid.Empty, CustomerA);
        var response = await ctrl.GetOverview();
        Assert.Equal(403, Assert.IsType<ObjectResult>(response).StatusCode);
        ctrl = Controller(provider, true, TenantA, CustomerA, false);
        response = await ctrl.GetOverview();
        Assert.Equal(403, Assert.IsType<ObjectResult>(response).StatusCode);
    }

    [Fact]
    public async Task OverviewRisksAndDetail_AreScopedToBothTenantAndCustomer()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        using var provider = Build(connection);
        var now = DateTime.UtcNow;
        var own = Guid.NewGuid();
        var sameCustomerOtherTenant = Guid.NewGuid();
        var sameTenantOtherCustomer = Guid.NewGuid();
        await using (var seedScope = provider.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<PdmDbContext>();
            await db.Database.EnsureCreatedAsync();
            Add(db, own, TenantA, CustomerA, now);
            Add(db, sameCustomerOtherTenant, TenantB, CustomerA, now);
            Add(db, sameTenantOtherCustomer, TenantA, CustomerB, now);
            await db.SaveChangesAsync();
        }
        await using var scope = provider.CreateAsyncScope();
        var controller = Controller(scope.ServiceProvider, true, TenantA, CustomerA);
        var overviewAction = await controller.GetOverview();
        var overview = Assert.IsType<ApiResult<PdmOverviewDto>>(Assert.IsType<OkObjectResult>(overviewAction).Value)!.Data!;
        Assert.Equal(1, overview.TotalDevices);
        Assert.Equal(1, overview.ActiveRisks);
        Assert.Single(overview.Rows);
        Assert.Equal(own, overview.Rows[0].DeviceId);
        Assert.Equal(77.7, overview.Rows[0].HealthIndex);

        var riskAction = await controller.GetRisks();
        var risks = Assert.IsType<ApiResult<PdmRiskPageDto>>(Assert.IsType<OkObjectResult>(riskAction).Value)!.Data!;
        Assert.Single(risks.Rows);
        Assert.Equal(own, risks.Rows[0].DeviceId);
        Assert.Equal(1, risks.Total);
        Assert.Equal(404, Assert.IsType<NotFoundResult>(
            await controller.GetProfile(sameCustomerOtherTenant)).StatusCode);
        Assert.Equal(404, Assert.IsType<NotFoundResult>(
            await controller.GetTrend(sameTenantOtherCustomer)).StatusCode);

        var detailAction = await controller.GetProfile(own);
        var detail = Assert.IsType<ApiResult<PdmProfileDetailsDto>>(
            Assert.IsType<OkObjectResult>(detailAction).Value)!.Data!;
        Assert.Equal(own, detail.DeviceId);
        Assert.Single(detail.Points);

        var trendAction = await controller.GetTrend(own);
        var points = Assert.IsAssignableFrom<ApiResult<System.Collections.Generic.IReadOnlyList<PdmTrendItemDto>>>(
            Assert.IsType<OkObjectResult>(trendAction).Value).Data!;
        Assert.Single(points);
        Assert.Equal(77.7, points[0].HealthIndex);
    }

    [Fact]
    public async Task BadPaginationAndStatus_DoNotIssueUnboundedQueries()
    {
        using var provider = new ServiceCollection().BuildServiceProvider();
        var ctrl = Controller(provider, true, TenantA, CustomerA);
        Assert.IsType<BadRequestObjectResult>(await ctrl.GetOverview(0, 20));
        Assert.IsType<BadRequestObjectResult>(await ctrl.GetOverview(1, 1000));
        Assert.IsType<BadRequestObjectResult>(await ctrl.GetRisks("anything"));
        Assert.IsType<BadRequestObjectResult>(await ctrl.GetTrend(Guid.NewGuid(), 365));
    }

    [Fact]
    public async Task NewProfileVersion_DoesNotShowOldHealthAsCurrent()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        using var provider = Build(connection);
        var device = Guid.NewGuid();
        await using (var seedScope = provider.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<PdmDbContext>();
            await db.Database.EnsureCreatedAsync();
            Add(db, device, TenantA, CustomerA, DateTime.UtcNow);
            await db.SaveChangesAsync();
            var entity = await db.DeviceProfiles.SingleAsync();
            entity.Version = 2;
            await db.SaveChangesAsync();
        }
        await using var scope = provider.CreateAsyncScope();
        var controller = Controller(scope.ServiceProvider, true, TenantA, CustomerA);
        var action = await controller.GetOverview();
        var overview = Assert.IsType<ApiResult<PdmOverviewDto>>(Assert.IsType<OkObjectResult>(action).Value)!.Data!;
        Assert.Single(overview.Rows);
        Assert.Null(overview.Rows[0].HealthIndex);
        Assert.Equal("Unknown", overview.Rows[0].RiskLevel);

        var trendAction = await controller.GetTrend(device);
        var trend = Assert.IsType<ApiResult<System.Collections.Generic.IReadOnlyList<PdmTrendItemDto>>>(
            Assert.IsType<OkObjectResult>(trendAction).Value).Data!;
        Assert.Empty(trend);
    }
    private static ServiceProvider Build(SqliteConnection connection)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDbContext<PdmDbContext>(options => options.UseSqlite(connection));
        return services.BuildServiceProvider(validateScopes: true);
    }

    private static void Add(PdmDbContext db, Guid deviceId, Guid tenant, Guid customer, DateTime now)
    {
        var profile = new PdmDeviceProfile
        {
            DeviceId = deviceId, TenantId = tenant, CustomerId = customer,
            Enabled = true, WindowMinutes = 15,
            PointMappingsVerified = true, RunStateVerified = true
        };
        db.DeviceProfiles.Add(profile);
        db.PointPolicies.Add(new PdmPointPolicy
        {
            ProfileId = profile.Id, TelemetryKey = "temp", Unit = "°C",
            ExpectedIntervalSeconds = 60, MinValidValue = 0, MaxValidValue = 120
        });
        db.HealthSnapshots.Add(new PdmHealthSnapshot
        {
            ProfileId = profile.Id, TenantId = tenant, CustomerId = customer,
            DeviceId = deviceId, ProfileVersion = 1,
            WindowStartUtc = now.AddMinutes(-15),
            WindowEndUtc = now, HealthIndex = 77.7,
            DataQuality = "Good", RiskLevel = "Attention"
        });
        db.RiskEvents.Add(new PdmRiskEvent
        {
            ProfileId = profile.Id, DeviceId = deviceId, TenantId = tenant, CustomerId = customer,
            RiskLevel = "Attention", Status = "Open", RiskType = "device-health",
            EventKey = "test-" + deviceId.ToString("N"), FirstObservedUtc = now, LastObservedUtc = now,
            LastEvaluatedWindowEndUtc = now
        });
    }
}
