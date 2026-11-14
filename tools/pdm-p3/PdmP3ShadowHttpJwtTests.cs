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

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

/// <summary>Real local Kestrel/JWT pipeline, in-memory SQLite and no external IO.</summary>
public sealed class PdmP3ShadowHttpJwtTests
{
    private static readonly byte[] Key=Encoding.UTF8.GetBytes(
        "Pdm-P3-Synthetic-Test-Bearer-Key-Not-Production-2026-11-13");

    private sealed class FakeSource : IPdmP3VerifiedShadowReadStore
    {
        public int Calls;
        // No real P3 evidence is configured in this HTTP safety fixture.
        public Task<PdmP3StoredShadowEvidence?> FetchAsync(
            Guid tenant,Guid customer,Guid device,Guid profile,int version,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult<PdmP3StoredShadowEvidence?>(null);
        }
    }

    [Fact]
    public async Task RealSignedJwtEnforcesTenantIsolationAndRejectsForgedToken()
    {
        await using var fixture=await Fixture.Start(true);
        var tenant=Guid.NewGuid();var customer=Guid.NewGuid();
        var device=Guid.NewGuid();var foreign=Guid.NewGuid();
        await fixture.Seed(tenant,customer,device);
        await fixture.Seed(Guid.NewGuid(),customer,foreign);
        var route="/api/pdm/p3/shadow?deviceId="+device;

        using(var anon=await fixture.Client.GetAsync(route))
            Assert.Equal(HttpStatusCode.Unauthorized,anon.StatusCode);
        fixture.Login(tenant,customer);
        using(var missing=await fixture.Client.GetAsync(route))
        {
            Assert.Equal(HttpStatusCode.OK,missing.StatusCode);
            using var doc=JsonDocument.Parse(await missing.Content.ReadAsStringAsync());
            Assert.Equal("Unverified",doc.RootElement.GetProperty("data")
                .GetProperty("state").GetString());
        }
        using(var cross=await fixture.Client.GetAsync(
            "/api/pdm/p3/shadow?deviceId="+foreign))
            Assert.Equal(HttpStatusCode.NotFound,cross.StatusCode);

        fixture.Client.DefaultRequestHeaders.Authorization=
            new AuthenticationHeaderValue("Bearer","bad.forged.jwt");
        using(var forged=await fixture.Client.GetAsync(route))
            Assert.Equal(HttpStatusCode.Unauthorized,forged.StatusCode);
        Assert.Equal(1,fixture.Source.Calls);
    }

    [Fact]
    public async Task DisabledP3ReadGateReturns503BeforeResolvingHistoricalEvidence()
    {
        await using var fixture=await Fixture.Start(false);
        fixture.Login(Guid.NewGuid(),Guid.NewGuid());
        using var response=await fixture.Client.GetAsync(
            "/api/pdm/p3/shadow?deviceId="+Guid.NewGuid());
        Assert.Equal(HttpStatusCode.ServiceUnavailable,response.StatusCode);
        Assert.Equal(0,fixture.Source.Calls);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly SqliteConnection _connection;
        public readonly FakeSource Source;
        public HttpClient Client {get;}
        private Fixture(WebApplication app,SqliteConnection connection,
            FakeSource source,HttpClient client)
        {
            _app=app;_connection=connection;Source=source;Client=client;
        }

        public static async Task<Fixture> Start(bool enabled)
        {
            var connection=new SqliteConnection("Data Source=:memory:");
            await connection.OpenAsync();
            var builder=WebApplication.CreateBuilder(new WebApplicationOptions {
                EnvironmentName="Production",
                ApplicationName=typeof(PdmP3ShadowReadController).Assembly.FullName
            });
            builder.WebHost.ConfigureKestrel(x=>x.Listen(IPAddress.Loopback,0));
            foreach(var key in new[]{
                "Enabled","SchemaReady","SingleInstanceAcknowledged",
                "PointMappingsApproved","HistoryQueryPlanApproved",
                "HistoryUtcContractApproved"
            }) builder.Configuration["PredictiveMaintenance:"+key]=enabled.ToString();
            builder.Configuration["PredictiveMaintenance:P2:ReadOnlyEnabled"]=enabled.ToString();
            builder.Configuration["PredictiveMaintenance:P3:ReadOnlyEnabled"]=enabled.ToString();
            builder.Configuration["PredictiveMaintenance:P3:OfflineEvidenceSourceApproved"]=enabled.ToString();
            var source=new FakeSource();
            builder.Services.AddSingleton<IPdmP3VerifiedShadowReadStore>(source);
            builder.Services.AddDbContext<PdmDbContext>(o=>o.UseSqlite(connection));
            builder.Services.AddControllers().AddApplicationPart(
                typeof(PdmP3ShadowReadController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(o=> {
                    o.TokenValidationParameters=new TokenValidationParameters {
                        IssuerSigningKey=new SymmetricSecurityKey(Key),
                        ValidateIssuerSigningKey=true,
                        ValidIssuer="p3-loopback",ValidateIssuer=true,
                        ValidAudience="p3-test",ValidateAudience=true,
                        ValidateLifetime=true,ClockSkew=TimeSpan.Zero
                    };
                });
            builder.Services.AddAuthorization();
            var app=builder.Build();
            app.UseAuthentication();app.UseAuthorization();app.MapControllers();
            await app.StartAsync();
            if(enabled) {
                using var scope=app.Services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<PdmDbContext>()
                    .Database.EnsureCreatedAsync();
            }
            var address=app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .First(a=>a.StartsWith("http://127.0.0.1:",StringComparison.OrdinalIgnoreCase));
            return new(app,connection,source,new HttpClient {
                BaseAddress=new Uri(address),Timeout=TimeSpan.FromSeconds(8)
            });
        }

        public async Task Seed(Guid tenant,Guid customer,Guid device)
        {
            using var scope=_app.Services.CreateScope();
            var db=scope.ServiceProvider.GetRequiredService<PdmDbContext>();
            db.DeviceProfiles.Add(new PdmDeviceProfile {
                TenantId=tenant,CustomerId=customer,DeviceId=device,
                Version=2,Enabled=true,PointMappingsVerified=true,
                RunStateVerified=true
            });
            await db.SaveChangesAsync();
        }
        public void Login(Guid tenant,Guid customer)
        {
            var now=DateTime.UtcNow;
            var jwt=new JwtSecurityToken(issuer:"p3-loopback",audience:"p3-test",
                claims:new[] {
                    new Claim(IoTSharpClaimTypes.Tenant,tenant.ToString()),
                    new Claim(IoTSharpClaimTypes.Customer,customer.ToString())
                },notBefore:now.AddSeconds(-5),expires:now.AddMinutes(5),
                signingCredentials:new SigningCredentials(
                    new SymmetricSecurityKey(Key),SecurityAlgorithms.HmacSha256));
            Client.DefaultRequestHeaders.Authorization=
                new AuthenticationHeaderValue("Bearer",
                    new JwtSecurityTokenHandler().WriteToken(jwt));
        }
        public async ValueTask DisposeAsync()
        {
            Client.Dispose();await _app.StopAsync();await _app.DisposeAsync();
            await _connection.DisposeAsync();
        }
    }
}

