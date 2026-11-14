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
/// Real loopback Kestrel + JWT + actual PdmP2ReviewDecisionController.
/// No external SQL, no reviewer write DB, no real business approval.
/// </summary>
public sealed class NextIamP2ReviewHttpTests
{
    private static readonly byte[] TestKey=Encoding.UTF8.GetBytes(
        "pdm-p2-only-synthetic-isolated-test-key-2026-11-not-production");
    private const string Route="/api/pdm/p2/reviews/11111111-2222-3333-4444-555555555555/decision";
    private const string RequestJson=
        "{\"expectedRevision\":1,\"approveForPlanning\":true,\"reason\":\"isolated IAM test only\"}";

    private static string IssueToken(bool role,bool scope,bool validSignature=true)
    {
        var claims=new List<Claim> {
            new(ClaimTypes.NameIdentifier,Guid.NewGuid().ToString())
        };
        if(role)claims.Add(new Claim(ClaimTypes.Role,"PdmReviewApprover"));
        if(scope)
        {
            claims.Add(new Claim(IoTSharpClaimTypes.Tenant,Guid.NewGuid().ToString()));
            claims.Add(new Claim(IoTSharpClaimTypes.Customer,Guid.NewGuid().ToString()));
        }
        var key=validSignature?TestKey:
            Encoding.UTF8.GetBytes("an-independent-invalid-signature-key-for-tests-only-2026");
        var token=new JwtSecurityToken(
            issuer:"p2-acceptance",audience:"isolated-pdm",
            claims:claims,notBefore:DateTime.UtcNow.AddMinutes(-1),
            expires:DateTime.UtcNow.AddMinutes(5),
            signingCredentials:new SigningCredentials(
                new SymmetricSecurityKey(key),SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private sealed class Fixture: IAsyncDisposable
    {
        private readonly WebApplication _app;
        public HttpClient Client {get;}
        private Fixture(WebApplication app,HttpClient client)
        {
            _app=app;Client=client;
        }
        public static async Task<Fixture> Start(bool flags)
        {
            var builder=WebApplication.CreateBuilder(new WebApplicationOptions {
                EnvironmentName="Production",
                ApplicationName=typeof(PdmP2ReviewDecisionController).Assembly.FullName
            });
            builder.WebHost.ConfigureKestrel(o=>o.Listen(IPAddress.Loopback,0));
            if(flags)
            {
                foreach(var flag in new[]{
                    "Enabled","SchemaReady","SingleInstanceAcknowledged",
                    "PointMappingsApproved","HistoryQueryPlanApproved",
                    "HistoryUtcContractApproved"})
                    builder.Configuration["PredictiveMaintenance:"+flag]="true";
                foreach(var flag in new[]{
                    "ReadOnlyEnabled","ReviewReadEnabled","ReviewWriteEnabled",
                    "ReviewSchemaReady","IamMappingApproved"})
                    builder.Configuration["PredictiveMaintenance:P2:"+flag]="true";
            }
            builder.Services.AddControllers().AddApplicationPart(
                typeof(PdmP2ReviewDecisionController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(o=>o.TokenValidationParameters=new TokenValidationParameters {
                    IssuerSigningKey=new SymmetricSecurityKey(TestKey),
                    ValidateIssuerSigningKey=true,
                    ValidIssuer="p2-acceptance",ValidateIssuer=true,
                    ValidAudience="isolated-pdm",ValidateAudience=true,
                    ValidateLifetime=true,ClockSkew=TimeSpan.Zero
                });
            builder.Services.AddAuthorization();
            var app=builder.Build();
            app.UseAuthentication();app.UseAuthorization();app.MapControllers();
            await app.StartAsync();
            var url=app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .Single(x=>x.StartsWith("http://127.0.0.1:",StringComparison.OrdinalIgnoreCase));
            return new(app,new HttpClient{BaseAddress=new Uri(url)});
        }
        public async Task<HttpResponseMessage> Post(string? bearer)
        {
            Client.DefaultRequestHeaders.Authorization=bearer is null?null:
                new AuthenticationHeaderValue("Bearer",bearer);
            return await Client.PostAsync(Route,new StringContent(
                RequestJson,Encoding.UTF8,"application/json"));
        }
        public async ValueTask DisposeAsync()
        {
            Client.Dispose();await _app.StopAsync();await _app.DisposeAsync();
        }
    }

    [Fact]
    public async Task RealJwtMiddlewareReturns401ForAnonymousAndInvalidSignature()
    {
        await using var fixture=await Fixture.Start(true);
        using(var anonymous=await fixture.Post(null))
            Assert.Equal(HttpStatusCode.Unauthorized,anonymous.StatusCode);
        using(var forged=await fixture.Post(IssueToken(true,true,false)))
            Assert.Equal(HttpStatusCode.Unauthorized,forged.StatusCode);
    }

    [Fact]
    public async Task ValidJwtWithoutApproverRoleCannotPostReview()
    {
        await using var fixture=await Fixture.Start(true);
        using var response=await fixture.Post(IssueToken(false,true));
        Assert.Equal(HttpStatusCode.Forbidden,response.StatusCode);
    }

    [Fact]
    public async Task MissingTenantClaimsRejectedEvenWithApproverRole()
    {
        await using var fixture=await Fixture.Start(true);
        using var response=await fixture.Post(IssueToken(true,false));
        Assert.Equal(HttpStatusCode.Forbidden,response.StatusCode);
    }

    [Fact]
    public async Task DisabledApprovalFlagsRejectRealApproverBeforeDbResolution()
    {
        await using var fixture=await Fixture.Start(false);
        using var response=await fixture.Post(IssueToken(true,true));
        Assert.Equal(HttpStatusCode.ServiceUnavailable,response.StatusCode);
    }

    [Fact]
    public async Task ValidApproverIsStillBlockedWhenIndependentApprovalDbNotInstalled()
    {
        await using var fixture=await Fixture.Start(true);
        using var response=await fixture.Post(IssueToken(true,true));
        Assert.Equal(HttpStatusCode.ServiceUnavailable,response.StatusCode);
        Assert.DoesNotContain("created",await response.Content.ReadAsStringAsync(),
            StringComparison.OrdinalIgnoreCase);
    }
}

