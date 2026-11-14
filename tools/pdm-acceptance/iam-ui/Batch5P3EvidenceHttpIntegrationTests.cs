using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace IoTSharp.PdM.Acceptance.IamUi;

/// <summary>
/// Real loopback HTTP -> signed JWT -> scoped SQLite PdmDbContext ->
/// independently injected in-memory evidence store -> controller DTO.
/// No SQL Server, no external API, no production inference.
/// </summary>
public sealed class Batch5P3EvidenceHttpIntegrationTests
{
    private static readonly byte[] SigningKey=Encoding.UTF8.GetBytes(
        "pdm-batch5-isolated-p3-jwt-key-not-for-production-2026");
    private sealed class EvidenceSource:IPdmP3VerifiedShadowReadStore
    {
        public PdmP3StoredShadowEvidence? Evidence;
        public int Calls;
        public Task<PdmP3StoredShadowEvidence?> FetchAsync(
            Guid tenant,Guid customer,Guid device,Guid profile,int version,CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult(Evidence);
        }
    }

    private sealed class Fixture: IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly SqliteConnection _sql;
        public HttpClient Http {get;}
        public EvidenceSource Source {get;}
        private Fixture(WebApplication app,SqliteConnection sql, HttpClient http,EvidenceSource source)
        { _app=app;_sql=sql;Http=http;Source=source; }

        public static async Task<Fixture> Create()
        {
            var sql=new SqliteConnection("Data Source=:memory:");
            await sql.OpenAsync();
            var builder=WebApplication.CreateBuilder(new WebApplicationOptions {
                EnvironmentName="Production",
                ApplicationName=typeof(PdmP3ShadowReadController).Assembly.FullName
            });
            builder.WebHost.ConfigureKestrel(x=>x.Listen(IPAddress.Loopback,0));
            foreach(var key in new[]{
                "Enabled","SchemaReady","SingleInstanceAcknowledged",
                "PointMappingsApproved","HistoryQueryPlanApproved",
                "HistoryUtcContractApproved"})
                builder.Configuration["PredictiveMaintenance:"+key]="true";
            builder.Configuration["PredictiveMaintenance:P2:ReadOnlyEnabled"]="true";
            builder.Configuration["PredictiveMaintenance:P3:ReadOnlyEnabled"]="true";
            builder.Configuration["PredictiveMaintenance:P3:OfflineEvidenceSourceApproved"]="true";
            var source=new EvidenceSource();
            builder.Services.AddSingleton<IPdmP3VerifiedShadowReadStore>(source);
            builder.Services.AddDbContext<PdmDbContext>(x=>x.UseSqlite(sql));
            builder.Services.AddControllers().AddApplicationPart(
                typeof(PdmP3ShadowReadController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(o=>o.TokenValidationParameters=new TokenValidationParameters {
                    IssuerSigningKey=new SymmetricSecurityKey(SigningKey),
                    ValidateIssuerSigningKey=true,ValidateIssuer=true,
                    ValidIssuer="batch5-p3-loopback",
                    ValidateAudience=true,ValidAudience="batch5-p3-read",
                    ValidateLifetime=true,ClockSkew=TimeSpan.Zero
                });
            builder.Services.AddAuthorization();
            var app=builder.Build();
            app.UseAuthentication();app.UseAuthorization();app.MapControllers();
            await app.StartAsync();
            using(var scope=app.Services.CreateScope())
                await scope.ServiceProvider.GetRequiredService<PdmDbContext>()
                    .Database.EnsureCreatedAsync();
            var address=app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .Single(a=>a.StartsWith("http://127.0.0.1:",StringComparison.OrdinalIgnoreCase));
            return new(app,sql,new HttpClient{BaseAddress=new Uri(address)},source);
        }

        public async Task<PdmDeviceProfile> Seed(Guid tenant,Guid customer,Guid device,
            bool mappings=true)
        {
            var profile=new PdmDeviceProfile {
                TenantId=tenant,CustomerId=customer,DeviceId=device,
                Enabled=true,Version=2,PointMappingsVerified=mappings,RunStateVerified=true
            };
            using var scope=_app.Services.CreateScope();
            var db=scope.ServiceProvider.GetRequiredService<PdmDbContext>();
            db.DeviceProfiles.Add(profile);
            await db.SaveChangesAsync();
            return profile;
        }

        public void Login(Guid tenant,Guid customer)
        {
            var jwt=new JwtSecurityToken(
                issuer:"batch5-p3-loopback",audience:"batch5-p3-read",
                claims:new[]{
                    new Claim(IoTSharpClaimTypes.Tenant,tenant.ToString()),
                    new Claim(IoTSharpClaimTypes.Customer,customer.ToString())},
                notBefore:DateTime.UtcNow.AddSeconds(-5),
                expires:DateTime.UtcNow.AddMinutes(5),
                signingCredentials:new SigningCredentials(
                    new SymmetricSecurityKey(SigningKey),SecurityAlgorithms.HmacSha256));
            Http.DefaultRequestHeaders.Authorization=
                new AuthenticationHeaderValue("Bearer",
                    new JwtSecurityTokenHandler().WriteToken(jwt));
        }
        public async Task<(HttpStatusCode status,string state,string body)> Read(Guid device)
        {
            using var resp=await Http.GetAsync("/api/pdm/p3/shadow?deviceId="+device);
            var body=await resp.Content.ReadAsStringAsync();
            using var json=JsonDocument.Parse(body);
            var state=resp.IsSuccessStatusCode
                ?json.RootElement.GetProperty("data").GetProperty("state").GetString()??""
                :"";
            return(resp.StatusCode,state,body);
        }
        public async ValueTask DisposeAsync()
        {
            Http.Dispose();await _app.StopAsync();await _app.DisposeAsync();
            await _sql.DisposeAsync();
        }
    }

    private static PdmP3StoredShadowEvidence Evidence(
        Guid tenant,Guid customer,PdmDeviceProfile profile,
        bool wrongTenant=false,bool failureProbability=false)
    {
        var now=DateTimeOffset.UtcNow.AddMinutes(-1);
        var scope=new PdmP3SeriesScope(tenant,customer,profile.DeviceId,
            profile.Id,profile.Version,"bearing.rms","mm/s","Running",
            true,true,true);
        var finding=new PdmP3AnomalyFinding(scope,now,
            PdmP3AnomalyState.Anomalous,5.5,1.2,0.2,2.0,8,
            "Isolated synthetic statistical deviation",failureProbability?0.8:null);
        var report=new PdmP3ShadowReport(PdmP3ShadowState.ExplainableBaseline,
            finding,"Synthetic test only");
        return new(wrongTenant?Guid.NewGuid():tenant,customer,profile.DeviceId,
            profile.Id,profile.Version,now,now.AddSeconds(5),
            true,true,new string('a',64),report);
    }

    [Fact]
    public async Task ScopedAndReviewedSyntheticStatisticsPassRealHttpPathWithoutForecast()
    {
        await using var fixture=await Fixture.Create();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();var device=Guid.NewGuid();
        var profile=await fixture.Seed(tenant,customer,device);
        fixture.Source.Evidence=Evidence(tenant,customer,profile);
        fixture.Login(tenant,customer);
        var response=await fixture.Read(device);
        Assert.Equal(HttpStatusCode.OK,response.status);
        Assert.Equal("StatisticsOnly",response.state);
        Assert.Contains("robustDeviationScore",response.body);
        Assert.DoesNotContain("\"failureProbability\":0.8",response.body);
        Assert.Equal(1,fixture.Source.Calls);
    }

    [Fact]
    public async Task ForgedTenantInStoredEvidenceIsOnlyUnverifiedNotStatistics()
    {
        await using var fixture=await Fixture.Create();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();var device=Guid.NewGuid();
        var profile=await fixture.Seed(tenant,customer,device);
        fixture.Source.Evidence=Evidence(tenant,customer,profile,wrongTenant:true);
        fixture.Login(tenant,customer);
        var response=await fixture.Read(device);
        Assert.Equal("Unverified",response.state);
        Assert.DoesNotContain("\"robustDeviationScore\":5.5",response.body);
    }

    [Fact]
    public async Task UnsupportedFailureProbabilityIsRejectedFromReadOnlyResponse()
    {
        await using var fixture=await Fixture.Create();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();var device=Guid.NewGuid();
        var profile=await fixture.Seed(tenant,customer,device);
        fixture.Source.Evidence=Evidence(tenant,customer,profile,failureProbability:true);
        fixture.Login(tenant,customer);
        var response=await fixture.Read(device);
        Assert.Equal("Unverified",response.state);
        Assert.DoesNotContain("\"failureProbability\":0.8",response.body);
    }

    [Fact]
    public async Task UnverifiedDeviceMappingNeverQueriesEvidenceStore()
    {
        await using var fixture=await Fixture.Create();
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();var device=Guid.NewGuid();
        var profile=await fixture.Seed(tenant,customer,device,mappings:false);
        fixture.Source.Evidence=Evidence(tenant,customer,profile);
        fixture.Login(tenant,customer);
        var response=await fixture.Read(device);
        Assert.Equal("Unverified",response.state);
        Assert.Equal(0,fixture.Source.Calls);
    }
}

