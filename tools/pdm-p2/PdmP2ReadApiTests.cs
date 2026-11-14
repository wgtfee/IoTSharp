using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

public sealed class PdmP2ReadApiTests
{
    private static readonly Guid Tenant = Guid.NewGuid();
    private static readonly Guid Customer = Guid.NewGuid();

    private static IConfiguration Settings(bool enabled) =>
        new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["PredictiveMaintenance:Enabled"] = enabled.ToString(),
                ["PredictiveMaintenance:SchemaReady"] = enabled.ToString(),
                ["PredictiveMaintenance:SingleInstanceAcknowledged"] = enabled.ToString(),
                ["PredictiveMaintenance:PointMappingsApproved"] = enabled.ToString(),
                ["PredictiveMaintenance:HistoryQueryPlanApproved"] = enabled.ToString(),
                ["PredictiveMaintenance:HistoryUtcContractApproved"] = enabled.ToString(),
                ["PredictiveMaintenance:P2:ReadOnlyEnabled"] = enabled.ToString()
            }).Build();

    private static PdmP2ShadowController Controller(IServiceProvider provider, bool enabled,
        Guid tenant, Guid customer, bool authenticated = true)
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
            new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
        }, authenticated ? "TestJwt" : null);
        return new PdmP2ShadowController(provider, Settings(enabled))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) }
            }
        };
    }

    [Fact]
    public void DataEndpointRequiresAuthorization()
    {
        Assert.NotEmpty(typeof(PdmP2ShadowController)
            .GetCustomAttributes(typeof(AuthorizeAttribute), true));
        var action = typeof(PdmP2ShadowController).GetMethod(nameof(PdmP2ShadowController.GetShadow));
        Assert.NotNull(action);
        Assert.NotEmpty(action!.GetCustomAttributes(typeof(HttpGetAttribute), true));
    }

    [Fact]
    public async Task DisabledFeature_NeverResolvesDatabase()
    {
        using var provider = new ServiceCollection().BuildServiceProvider();
        var result = await Controller(provider, false, Tenant, Customer).GetShadow(Guid.NewGuid());
        Assert.Equal(503, Assert.IsType<ObjectResult>(result).StatusCode);
    }

    [Fact]
    public async Task BadScopeRejectedBeforeDbAccess()
    {
        using var provider = new ServiceCollection().BuildServiceProvider();
        var controller = Controller(provider, true, Guid.Empty, Customer);
        Assert.Equal(403, Assert.IsType<ObjectResult>(
            await controller.GetShadow(Guid.NewGuid())).StatusCode);
        controller = Controller(provider, true, Tenant, Customer, authenticated: false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(
            await controller.GetShadow(Guid.NewGuid())).StatusCode);
        controller = Controller(provider, true, Tenant, Customer);
        Assert.IsType<BadRequestObjectResult>(await controller.GetShadow(Guid.Empty));
    }

    [Fact]
    public async Task CrossTenantAndCrossCustomerDevicesAreNeverDiscoverable()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        using var provider = Build(con);
        var foreign = Guid.NewGuid();
        await Seed(provider, Guid.NewGuid(), Customer, foreign);
        var otherCustomer = Guid.NewGuid();
        var otherCustomerDevice = Guid.NewGuid();
        await Seed(provider, Tenant, otherCustomer, otherCustomerDevice);
        await using var scope = provider.CreateAsyncScope();
        var controller = Controller(scope.ServiceProvider, true, Tenant, Customer);
        Assert.IsType<NotFoundResult>(await controller.GetShadow(foreign));
        Assert.IsType<NotFoundResult>(await controller.GetShadow(otherCustomerDevice));
    }

    [Fact]
    public async Task FreshP1HistoryAndOpenRisk_GenerateOnlyUnsentReviewProposal()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        using var provider = Build(con);
        var ownDevice = Guid.NewGuid();
        await Seed(provider, Tenant, Customer, ownDevice);
        await using var scope = provider.CreateAsyncScope();
        var action = await Controller(scope.ServiceProvider, true, Tenant, Customer).GetShadow(ownDevice);
        var item = Assert.IsType<ApiResult<PdmP2ShadowDto>>(Assert.IsType<OkObjectResult>(action).Value)!.Data!;
        Assert.Equal(ownDevice, item.DeviceId);
        Assert.Equal(3, item.ProfileVersion);
        Assert.True(item.ReadOnly);
        Assert.Equal("ProposalOnly", item.State);
        Assert.Equal("Declining", item.Trend.Direction);
        Assert.Equal(5, item.Trend.ValidWindows);
        Assert.Equal("Notify", item.Alert.Kind);
        Assert.True(item.Alert.IsProposalOnly);
        Assert.False(item.Alert.IsDelivered);
        Assert.Equal(64, item.Alert.IdempotencyKey!.Length);
        Assert.Equal("NeedsDataVerification", item.Maintenance.State);
        Assert.False(item.Maintenance.IsWorkOrderIssued);
        Assert.Null(item.Maintenance.FailureProbability);
        Assert.Null(item.Maintenance.RemainingUsefulLifeHours);
    }

    [Fact]
    public async Task NoOpenEpisode_DoesNotFabricateRiskOrMaintenance()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        using var provider = Build(con);
        var ownDevice = Guid.NewGuid();
        await Seed(provider, Tenant, Customer, ownDevice, addRisk: false);
        await using var scope = provider.CreateAsyncScope();
        var action = await Controller(scope.ServiceProvider, true, Tenant, Customer).GetShadow(ownDevice);
        var item = Assert.IsType<ApiResult<PdmP2ShadowDto>>(Assert.IsType<OkObjectResult>(action).Value)!.Data!;
        Assert.Equal("NoOpenRisk", item.State);
        Assert.Equal("Held", item.Alert.Kind);
        Assert.Equal("NotApplicable", item.Maintenance.State);
    }

    [Fact]
    public async Task OldEvaluationWindowsAndProfileVersionNeverReturnActionable()
    {
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        using var provider = Build(con);
        var device = Guid.NewGuid();
        await Seed(provider, Tenant, Customer, device, shiftDays: 2);
        await using var scope = provider.CreateAsyncScope();
        var item = Assert.IsType<ApiResult<PdmP2ShadowDto>>(
            Assert.IsType<OkObjectResult>(
                await Controller(scope.ServiceProvider, true, Tenant, Customer).GetShadow(device)).Value)!.Data!;
        Assert.Equal("Unknown", item.State);
        Assert.Equal("Held", item.Alert.Kind);

        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        var profile = await db.DeviceProfiles.SingleAsync();
        profile.Version++;
        await db.SaveChangesAsync();
        item = Assert.IsType<ApiResult<PdmP2ShadowDto>>(
            Assert.IsType<OkObjectResult>(
                await Controller(scope.ServiceProvider, true, Tenant, Customer).GetShadow(device)).Value)!.Data!;
        Assert.Equal("Unknown", item.State);
        Assert.Equal("Held", item.Alert.Kind);
        Assert.Equal(4, item.ProfileVersion);
    }

    [Fact]
    public async Task P2ReadOnlyGateCanDisableShadowEvenWhenP1GatesAreApproved()
    {
        using var services = new ServiceCollection().BuildServiceProvider();
        var config = Settings(true);
        config["PredictiveMaintenance:P2:ReadOnlyEnabled"] = "false";
        var reference = Controller(services, true, Tenant, Customer);
        var endpoint = new PdmP2ShadowController(services, config)
        {
            ControllerContext = reference.ControllerContext
        };
        var result = await endpoint.GetShadow(Guid.NewGuid());
        Assert.Equal(503, Assert.IsType<ObjectResult>(result).StatusCode);
    }

    [Fact]
    public async Task MultipleOpenRiskEpisodes_ReturnUnknownInsteadOfChoosingOneArbitrarily()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        using var provider = Build(connection);
        var device = Guid.NewGuid();
        await Seed(provider, Tenant, Customer, device);
        await using var scope = provider.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        var episode = await db.RiskEvents.AsNoTracking().SingleAsync();
        db.RiskEvents.Add(new PdmRiskEvent
        {
            TenantId = episode.TenantId, CustomerId = episode.CustomerId,
            DeviceId = episode.DeviceId, ProfileId = episode.ProfileId,
            ProfileVersion = episode.ProfileVersion,
            RiskType = episode.RiskType, RiskLevel = episode.RiskLevel,
            Status = "Open", EventKey = "other-" + device.ToString("N"),
            FirstObservedUtc = episode.FirstObservedUtc,
            LastObservedUtc = episode.LastObservedUtc,
            LastEvaluatedWindowEndUtc = episode.LastEvaluatedWindowEndUtc,
            OccurrenceCount = 2
        });
        await db.SaveChangesAsync();
        var action = await Controller(scope.ServiceProvider, true, Tenant, Customer).GetShadow(device);
        var shadow = Assert.IsType<ApiResult<PdmP2ShadowDto>>(
            Assert.IsType<OkObjectResult>(action).Value)!.Data!;
        Assert.Equal("Unknown", shadow.State);
        Assert.Equal("Held", shadow.Alert.Kind);
        Assert.Null(shadow.Alert.IdempotencyKey);
        Assert.False(shadow.Maintenance.IsWorkOrderIssued);
    }
    private static ServiceProvider Build(SqliteConnection con)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDbContext<PdmDbContext>(o => o.UseSqlite(con));
        return services.BuildServiceProvider(validateScopes: true);
    }

    private static async Task Seed(IServiceProvider provider, Guid tenant,
        Guid customer, Guid deviceId, bool addRisk = true, int shiftDays = 0)
    {
        await using var scope = provider.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        await db.Database.EnsureCreatedAsync();
        var profile = new PdmDeviceProfile
        {
            TenantId = tenant, CustomerId = customer, DeviceId = deviceId,
            Version = 3, Enabled = true,
            PointMappingsVerified = true, RunStateVerified = true,
            WindowMinutes = 15, MinimumCoverageRatio = 0.8
        };
        db.DeviceProfiles.Add(profile);
        var end = DateTime.UtcNow.AddMinutes(-1).AddDays(-shiftDays);
        end = new DateTime(end.Year, end.Month, end.Day, end.Hour, end.Minute, 0, DateTimeKind.Utc);
        for (int i = 0; i < 5; i++)
        {
            var windowEnd = end.AddMinutes(-15 * (4 - i));
            db.HealthSnapshots.Add(new PdmHealthSnapshot
            {
                TenantId = tenant, CustomerId = customer, DeviceId = deviceId,
                ProfileId = profile.Id, ProfileVersion = 3,
                WindowStartUtc = windowEnd.AddMinutes(-15),
                WindowEndUtc = windowEnd,
                DataQuality = "Good", RiskLevel = "Warning",
                HealthIndex = 94 - i * 8, CoverageRatio = 0.96
            });
        }
        if (addRisk)
            db.RiskEvents.Add(new PdmRiskEvent
            {
                TenantId = tenant, CustomerId = customer, DeviceId = deviceId,
                ProfileId = profile.Id, ProfileVersion = 3,
                RiskType = PdmRiskEventTransitions.HealthRiskType,
                RiskLevel = "Warning", Status = "Open",
                EventKey = "p2-read-synthetic-" + deviceId.ToString("N"),
                FirstObservedUtc = end.AddHours(-1),
                LastObservedUtc = end,
                LastEvaluatedWindowEndUtc = end,
                OccurrenceCount = 3,
                EvidenceJson = "{\"reasons\":[\"verified warning\"]}"
            });
        await db.SaveChangesAsync();
    }
}

