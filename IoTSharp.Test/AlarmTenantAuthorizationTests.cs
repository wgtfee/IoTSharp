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
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.Test;

// P0: direct controller/EF InMemory tests, isolated from production databases.
// These do not test actual JWT HTTP middleware; endpoint E2E is a separate gate.
public sealed class AlarmTenantAuthorizationTests
{
    [Theory]
    [InlineData(nameof(AlarmController.AckAlarm))]
    [InlineData(nameof(AlarmController.ClearAlarm))]
    public void AlarmWriteRoute_RequiresAuthorizeAttribute(string action)
    {
        var method = typeof(AlarmController).GetMethod(action);
        Assert.NotNull(method);
        Assert.True(method!.GetCustomAttributes(typeof(AuthorizeAttribute), true).Any(),
            action + " must require authorization");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ForeignTenantAndCustomer_CannotAcknowledgeOrClear(bool acknowledge)
    {
        using var provider = BuildServices();
        await using var scope = provider.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var ownerTenant = new Tenant { Name = "Synthetic owner tenant" };
        var foreignTenant = new Tenant { Name = "Synthetic foreign tenant" };
        var ownerCustomer = new Customer { Name = "Synthetic owner customer", Tenant = ownerTenant };
        var foreignCustomer = new Customer { Name = "Synthetic foreign customer", Tenant = ownerTenant };
        context.Tenant.AddRange(ownerTenant, foreignTenant);
        context.Customer.AddRange(ownerCustomer, foreignCustomer);

        var startingStatus = acknowledge ? AlarmStatus.Active_UnAck : AlarmStatus.Active_Ack;
        var own = new Alarm { Id = Guid.NewGuid(), Tenant = ownerTenant, Customer = ownerCustomer, AlarmStatus = startingStatus };
        var otherTenant = new Alarm { Id = Guid.NewGuid(), Tenant = foreignTenant, Customer = ownerCustomer, AlarmStatus = startingStatus };
        var otherCustomer = new Alarm { Id = Guid.NewGuid(), Tenant = ownerTenant, Customer = foreignCustomer, AlarmStatus = startingStatus };
        context.Alarms.AddRange(own, otherTenant, otherCustomer);
        await context.SaveChangesAsync();

        var controller = CreateController(context, ownerTenant.Id, ownerCustomer.Id);
        async Task<ApiResult<bool>> Act(Guid id) => acknowledge
            ? await controller.AckAlarm(new AlarmStatusDto { Id = id })
            : await controller.ClearAlarm(new AlarmStatusDto { Id = id });

        Assert.Equal((int)ApiCode.CantFindObject, (await Act(otherTenant.Id)).Code);
        Assert.Equal((int)ApiCode.CantFindObject, (await Act(otherCustomer.Id)).Code);
        Assert.Equal(startingStatus, (await context.Alarms.FindAsync(otherTenant.Id))!.AlarmStatus);
        Assert.Equal(startingStatus, (await context.Alarms.FindAsync(otherCustomer.Id))!.AlarmStatus);

        Assert.Equal((int)ApiCode.Success, (await Act(own.Id)).Code);
        var changed = (await context.Alarms.FindAsync(own.Id))!;
        Assert.Equal(acknowledge ? AlarmStatus.Active_Ack : AlarmStatus.Cleared_Act, changed.AlarmStatus);
        Assert.Equal(startingStatus, (await context.Alarms.FindAsync(otherTenant.Id))!.AlarmStatus);
        Assert.Equal(startingStatus, (await context.Alarms.FindAsync(otherCustomer.Id))!.AlarmStatus);
    }

    private static AlarmController CreateController(ApplicationDbContext context, Guid tenant, Guid customer)
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString()),
            new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
            new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
        }, "SyntheticAuthenticatedUser");
        return new AlarmController(context)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) }
            }
        };
    }

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddEntityFrameworkInMemoryDatabase();
        services.AddSingleton<IDataBaseModelBuilderOptions, StubModelBuilderOptions>();
        services.AddDbContext<ApplicationDbContext>((provider, options) =>
        {
            options.UseInMemoryDatabase(Guid.NewGuid().ToString("N"));
            options.UseInternalServiceProvider(provider);
        });
        return services.BuildServiceProvider(validateScopes: true);
    }

    private sealed class StubModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}
