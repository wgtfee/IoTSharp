using System.Security.Claims;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3ShadowApiTests
{
    private static readonly Guid Tenant=Guid.NewGuid();
    private static readonly Guid Customer=Guid.NewGuid();

    private sealed class FakeSource : IPdmP3VerifiedShadowReadStore
    {
        public int Calls;
        public PdmP3StoredShadowEvidence? Evidence;
        public Task<PdmP3StoredShadowEvidence?> FetchAsync(
            Guid tenant,Guid customer,Guid device,Guid profile,int version,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult(Evidence);
        }
    }
    private static IConfiguration Config(bool enabled)
    {
        var keys=new[] {
            "Enabled","SchemaReady","SingleInstanceAcknowledged",
            "PointMappingsApproved","HistoryQueryPlanApproved",
            "HistoryUtcContractApproved"
        };
        var items=keys.ToDictionary(k=>"PredictiveMaintenance:"+k,
            _=>(string?)enabled.ToString());
        items["PredictiveMaintenance:P2:ReadOnlyEnabled"]=enabled.ToString();
        items["PredictiveMaintenance:P3:ReadOnlyEnabled"]=enabled.ToString();
        items["PredictiveMaintenance:P3:OfflineEvidenceSourceApproved"]=enabled.ToString();
        return new ConfigurationBuilder().AddInMemoryCollection(items).Build();
    }
    private static PdmP3ShadowReadController Controller(IServiceProvider provider,
        bool enabled,Guid tenant,Guid customer,bool authenticated=true)
    {
        var identity=new ClaimsIdentity(new[] {
            new Claim(IoTSharpClaimTypes.Tenant,tenant.ToString()),
            new Claim(IoTSharpClaimTypes.Customer,customer.ToString())
        },authenticated?"SignedSyntheticJwt":null);
        return new PdmP3ShadowReadController(provider,Config(enabled)) {
            ControllerContext=new ControllerContext {
                HttpContext=new DefaultHttpContext {User=new ClaimsPrincipal(identity)}
            }
        };
    }
    private static async Task<(SqliteConnection,ServiceProvider)> Open(FakeSource fake)
    {
        var connection=new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var services=new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IPdmP3VerifiedShadowReadStore>(fake);
        services.AddDbContext<PdmDbContext>(o=>o.UseSqlite(connection));
        var provider=services.BuildServiceProvider(validateScopes:true);
        await using(var scope=provider.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<PdmDbContext>()
                .Database.EnsureCreatedAsync();
        return(connection,provider);
    }
    private static async Task<PdmDeviceProfile> Seed(ServiceProvider provider,
        Guid tenant,Guid customer,Guid device)
    {
        await using var scope=provider.CreateAsyncScope();
        var db=scope.ServiceProvider.GetRequiredService<PdmDbContext>();
        var profile=new PdmDeviceProfile {
            TenantId=tenant,CustomerId=customer,DeviceId=device,
            Version=3,Enabled=true,PointMappingsVerified=true,RunStateVerified=true
        };
        db.DeviceProfiles.Add(profile);
        await db.SaveChangesAsync();
        return profile;
    }
    private static PdmP3StoredShadowEvidence Trustworthy(PdmDeviceProfile p)
    {
        var timestamp=DateTimeOffset.UtcNow.AddMinutes(-2);
        var scope=new PdmP3SeriesScope(p.TenantId,p.CustomerId,p.DeviceId,
            p.Id,p.Version,"bearing.rms","mm/s","Running",true,true,true);
        var finding=new PdmP3AnomalyFinding(scope,timestamp,
            PdmP3AnomalyState.Anomalous,9,1,0.1,5,8,
            "Synthetic verified evidence for isolated API test only");
        return new(p.TenantId,p.CustomerId,p.DeviceId,p.Id,p.Version,timestamp,
            timestamp.AddSeconds(1),true,true,new string('a',64),
            new PdmP3ShadowReport(PdmP3ShadowState.ExplainableBaseline,
                finding,"only offline synthetic evidence"));
    }

    [Fact]
    public void ControllerHasAuthenticatedGetOnlyContract()
    {
        Assert.Contains(typeof(PdmP3ShadowReadController).GetCustomAttributes(true),
            x=>x is AuthorizeAttribute);
        Assert.Contains(typeof(PdmP3ShadowReadController)
            .GetMethod(nameof(PdmP3ShadowReadController.GetShadow))!
            .GetCustomAttributes(true),x=>x is HttpGetAttribute);
    }

    [Fact]
    public async Task DisabledGateReturns503WithoutResolvingAnyDb()
    {
        using var service=new ServiceCollection().BuildServiceProvider();
        var result=await Controller(service,false,Tenant,Customer).GetShadow(Guid.NewGuid());
        Assert.Equal(503,Assert.IsType<ObjectResult>(result).StatusCode);
    }

    [Fact]
    public async Task AnonymousAndBadScopesAreRejectedBeforeSourceRead()
    {
        using var service=new ServiceCollection().BuildServiceProvider();
        var anon=Controller(service,true,Tenant,Customer,authenticated:false);
        Assert.Equal(403,Assert.IsType<ObjectResult>(
            await anon.GetShadow(Guid.NewGuid())).StatusCode);
        var invalid=Controller(service,true,Guid.Empty,Customer);
        Assert.Equal(403,Assert.IsType<ObjectResult>(
            await invalid.GetShadow(Guid.NewGuid())).StatusCode);
        Assert.IsType<BadRequestObjectResult>(
            await Controller(service,true,Tenant,Customer).GetShadow(Guid.Empty));
    }

    [Fact]
    public async Task CrossTenantAndCrossCustomerDevicesAreNotDiscoverable()
    {
        var fake=new FakeSource();
        var(con,provider)=await Open(fake);
        await using(con) using(provider)
        {
            var foreign=Guid.NewGuid();
            await Seed(provider,Guid.NewGuid(),Customer,foreign);
            var differentCustomer=Guid.NewGuid();
            await Seed(provider,Tenant,Guid.NewGuid(),differentCustomer);
            await using var scope=provider.CreateAsyncScope();
            var controller=Controller(scope.ServiceProvider,true,Tenant,Customer);
            Assert.IsType<NotFoundResult>(await controller.GetShadow(foreign));
            Assert.IsType<NotFoundResult>(await controller.GetShadow(differentCustomer));
            Assert.Equal(0,fake.Calls);
        }
    }

    [Fact]
    public async Task TrustedScopedOfflineEvidenceShowsStatisticsOnlyNotFailurePrediction()
    {
        var fake=new FakeSource();
        var(con,provider)=await Open(fake);
        await using(con) using(provider)
        {
            var device=Guid.NewGuid();
            var profile=await Seed(provider,Tenant,Customer,device);
            fake.Evidence=Trustworthy(profile);
            await using var scope=provider.CreateAsyncScope();
            var result=await Controller(scope.ServiceProvider,true,Tenant,Customer)
                .GetShadow(device);
            var dto=Assert.IsType<ApiResult<PdmP3ShadowReadDto>>(
                Assert.IsType<OkObjectResult>(result).Value)!.Data!;
            Assert.Equal("StatisticsOnly",dto.State);
            Assert.Equal(9,dto.RobustDeviationScore);
            Assert.True(dto.ReadOnly);
            Assert.Null(dto.FailureProbability);
            Assert.Null(dto.RemainingUsefulLifeHours);
            Assert.False(dto.IsAlertDelivered);
            Assert.False(dto.IsWorkOrderCreated);
            Assert.Equal(1,fake.Calls);
        }
    }

    [Fact]
    public async Task FalsifiedScopeOrProbabilityCannotLeakThroughApprovedReadStore()
    {
        var fake=new FakeSource();
        var(con,provider)=await Open(fake);
        await using(con) using(provider)
        {
            var device=Guid.NewGuid();
            var profile=await Seed(provider,Tenant,Customer,device);
            var evidence=Trustworthy(profile);
            fake.Evidence=evidence with { TenantId=Guid.NewGuid() };
            await using var scope=provider.CreateAsyncScope();
            var ctl=Controller(scope.ServiceProvider,true,Tenant,Customer);
            var data=Assert.IsType<ApiResult<PdmP3ShadowReadDto>>(
                Assert.IsType<OkObjectResult>(await ctl.GetShadow(device)).Value)!.Data!;
            Assert.Equal("Unverified",data.State);
            fake.Evidence=evidence with {
                Report=evidence.Report with {FailureProbability=0.95}
            };
            data=Assert.IsType<ApiResult<PdmP3ShadowReadDto>>(
                Assert.IsType<OkObjectResult>(await ctl.GetShadow(device)).Value)!.Data!;
            Assert.Equal("Unverified",data.State);
        }
    }

    [Fact]
    public async Task MissingRealEvidenceIsUnknownNeverSyntheticSuccess()
    {
        var fake=new FakeSource();
        var(con,provider)=await Open(fake);
        await using(con) using(provider)
        {
            var device=Guid.NewGuid();
            var profile=await Seed(provider,Tenant,Customer,device);
            await using var scope=provider.CreateAsyncScope();
            var result=await Controller(scope.ServiceProvider,true,Tenant,Customer)
                .GetShadow(device);
            var dto=Assert.IsType<ApiResult<PdmP3ShadowReadDto>>(
                Assert.IsType<OkObjectResult>(result).Value)!.Data!;
            Assert.Equal("Unverified",dto.State);
            Assert.Null(dto.RobustDeviationScore);
            Assert.Null(dto.ExperimentSha256);
        }
    }
}

