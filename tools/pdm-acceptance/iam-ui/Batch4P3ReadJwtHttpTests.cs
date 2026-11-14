using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace IoTSharp.PdM.Acceptance.IamUi;

/// <summary>
/// Actual P3 route over loopback Kestrel and signed JWT. Zero PdmDbContext
/// registrations: any successful statistics response is a serious regression.
/// </summary>
public sealed class Batch4P3ReadJwtHttpTests
{
    private static readonly byte[] SigningKey=Encoding.UTF8.GetBytes(
        "isolated-pdm-p3-loopback-only-jwt-signing-key-2026-11-not-production");
    private static readonly string Device=Guid.NewGuid().ToString();

    private static string Token(bool scoped,bool genuine=true)
    {
        var claims=new List<Claim> {new(ClaimTypes.NameIdentifier,Guid.NewGuid().ToString())};
        if(scoped)
        {
            claims.Add(new(IoTSharpClaimTypes.Tenant,Guid.NewGuid().ToString()));
            claims.Add(new(IoTSharpClaimTypes.Customer,Guid.NewGuid().ToString()));
        }
        var key=genuine?SigningKey:Encoding.UTF8.GetBytes(
            "untrusted-pdm-p3-jwt-only-for-negative-tests-2026-11");
        var jwt=new JwtSecurityToken(
            issuer:"isolated-pdm-p3",
            audience:"isolated-pdm-p3-read",
            claims:claims,
            notBefore:DateTime.UtcNow.AddSeconds(-5),
            expires:DateTime.UtcNow.AddMinutes(5),
            signingCredentials:new(new SymmetricSecurityKey(key),SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(jwt);
    }

    private sealed class Host(WebApplication app,HttpClient client):IAsyncDisposable
    {
        public HttpClient Client=>client;

        public static async Task<Host> StartAsync(bool gates)
        {
            var builder=WebApplication.CreateBuilder(new WebApplicationOptions {
                ApplicationName=typeof(PdmP3ShadowReadController).Assembly.FullName,
                EnvironmentName="Production"
            });
            builder.WebHost.ConfigureKestrel(o=>o.Listen(IPAddress.Loopback,0));
            if(gates)
            {
                foreach(var name in new[]{
                    "Enabled","SchemaReady","SingleInstanceAcknowledged",
                    "PointMappingsApproved","HistoryQueryPlanApproved",
                    "HistoryUtcContractApproved"})
                    builder.Configuration["PredictiveMaintenance:"+name]="true";
                builder.Configuration["PredictiveMaintenance:P2:ReadOnlyEnabled"]="true";
                builder.Configuration["PredictiveMaintenance:P3:ReadOnlyEnabled"]="true";
                builder.Configuration["PredictiveMaintenance:P3:OfflineEvidenceSourceApproved"]="true";
            }
            builder.Services.AddControllers().AddApplicationPart(
                typeof(PdmP3ShadowReadController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(o=>o.TokenValidationParameters=new TokenValidationParameters {
                    IssuerSigningKey=new SymmetricSecurityKey(SigningKey),
                    ValidateIssuerSigningKey=true,
                    ValidIssuer="isolated-pdm-p3",ValidateIssuer=true,
                    ValidAudience="isolated-pdm-p3-read",ValidateAudience=true,
                    ValidateLifetime=true,ClockSkew=TimeSpan.Zero
                });
            builder.Services.AddAuthorization();
            var app=builder.Build();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapControllers();
            await app.StartAsync();
            var address=app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .Single(x=>x.StartsWith("http://127.0.0.1:",StringComparison.OrdinalIgnoreCase));
            return new(app,new HttpClient {BaseAddress=new Uri(address)});
        }

        public async Task<HttpResponseMessage> Get(string? jwt,string device= "")
        {
            client.DefaultRequestHeaders.Authorization=jwt is null?null:
                new AuthenticationHeaderValue("Bearer",jwt);
            return await client.GetAsync("/api/pdm/p3/shadow?deviceId="+
                Uri.EscapeDataString(device.Length>0?device:Device));
        }

        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task AnonymousAndForgedSignedRequestsFailAuthentication()
    {
        await using var host=await Host.StartAsync(true);
        using(var anonymous=await host.Get(null))
            Assert.Equal(HttpStatusCode.Unauthorized,anonymous.StatusCode);
        using(var forged=await host.Get(Token(true,false)))
            Assert.Equal(HttpStatusCode.Unauthorized,forged.StatusCode);
    }

    [Fact]
    public async Task ValidJwtWithoutTenantAndCustomerCannotSeeP3()
    {
        await using var host=await Host.StartAsync(true);
        using var result=await host.Get(Token(false));
        Assert.Equal(HttpStatusCode.Forbidden,result.StatusCode);
    }

    [Fact]
    public async Task AllFlagsTrueButMissingTrustedDatabaseReturns503NotSyntheticMetrics()
    {
        await using var host=await Host.StartAsync(true);
        using var result=await host.Get(Token(true));
        Assert.Equal(HttpStatusCode.ServiceUnavailable,result.StatusCode);
        var response=await result.Content.ReadAsStringAsync();
        Assert.DoesNotContain("robustDeviationScore",response,StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("failureProbability",response,StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DisabledPublicationGateReturns503BeforeStoreIsResolved()
    {
        await using var host=await Host.StartAsync(false);
        using var result=await host.Get(Token(true));
        Assert.Equal(HttpStatusCode.ServiceUnavailable,result.StatusCode);
    }

    [Fact]
    public async Task InvalidDeviceIdFailsBeforeDatabaseAccessAfterJwtAndFeatureGates()
    {
        await using var host=await Host.StartAsync(true);
        using var result=await host.Get(Token(true),Guid.Empty.ToString());
        Assert.Equal(HttpStatusCode.BadRequest,result.StatusCode);
    }
}

