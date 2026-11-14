using System;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Claims;
using System.Text;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Services.PredictiveMaintenance.P2;
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

namespace IoTSharp.PredictiveMaintenance.P2.Tests;

/// <summary>Actual HTTP/JWT/role authorization and SQLite, only 127.0.0.1 ephemeral port.</summary>
public sealed class PdmP2ReviewDecisionHttpTests
{
    private static readonly byte[] SigningKey = Encoding.UTF8.GetBytes(
        "IoTSharp-P2-Review-Test-Key-Not-Production-2026-11-13-Sufficiently-Long");

    [Fact]
    public async Task DecisionEndpoint_RequiresRealJwtRoleAndFeatureGate()
    {
        await using var fixture = await Fixture.StartAsync(enabled: true);
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var review = await fixture.SeedAsync(tenant, customer, Guid.NewGuid());
        var path = $"/api/pdm/p2/reviews/{review}/decision";
        var decision = new PdmP2ReviewDecisionRequest(1, true, "Verified in test");

        using (var anonymous = await fixture.Client.PostAsJsonAsync(path, decision))
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        fixture.Login(tenant, customer, Guid.NewGuid(), role: "NormalUser");
        using (var nonReviewer = await fixture.Client.PostAsJsonAsync(path, decision))
            Assert.Equal(HttpStatusCode.Forbidden, nonReviewer.StatusCode);

        fixture.Client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", "forged.invalid.jwt");
        using (var forged = await fixture.Client.PostAsJsonAsync(path, decision))
            Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);

        fixture.Login(tenant, customer, Guid.NewGuid(), role: "PdmReviewApprover");
        using (var allowed = await fixture.Client.PostAsJsonAsync(path, decision))
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Assert.Equal("ApprovedForPlanning", await fixture.StateAsync(review));
        Assert.Equal(2, await fixture.AuditCountAsync(review));

        using (var repeat = await fixture.Client.PostAsJsonAsync(path, decision))
            Assert.Equal(HttpStatusCode.Conflict, repeat.StatusCode);
        Assert.Equal(2, await fixture.AuditCountAsync(review));
    }

    [Fact]
    public async Task ReviewerCannotApproveOwnDraftOrAnotherTenant()
    {
        await using var fixture = await Fixture.StartAsync(enabled: true);
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var author = Guid.NewGuid();
        var own = await fixture.SeedAsync(tenant, customer, author);
        var foreign = await fixture.SeedAsync(Guid.NewGuid(), customer, Guid.NewGuid());

        fixture.Login(tenant, customer, author, "PdmReviewApprover");
        using (var self = await fixture.Client.PostAsJsonAsync(
            $"/api/pdm/p2/reviews/{own}/decision",
            new PdmP2ReviewDecisionRequest(1, true, "self review")))
            Assert.Equal(HttpStatusCode.NotFound, self.StatusCode);
        using (var other = await fixture.Client.PostAsJsonAsync(
            $"/api/pdm/p2/reviews/{foreign}/decision",
            new PdmP2ReviewDecisionRequest(1, true, "cross scope")))
            Assert.Equal(HttpStatusCode.NotFound, other.StatusCode);
        Assert.Equal("AwaitingHumanReview", await fixture.StateAsync(own));
        Assert.Equal(1, await fixture.AuditCountAsync(own));
        Assert.Equal(1, await fixture.AuditCountAsync(foreign));
    }

    [Fact]
    public async Task DisabledWriteGateReturns503WithoutResolvingDatabase()
    {
        await using var fixture = await Fixture.StartAsync(enabled: false);
        fixture.Login(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "PdmReviewApprover");
        using var response = await fixture.Client.PostAsJsonAsync(
            $"/api/pdm/p2/reviews/{Guid.NewGuid()}/decision",
            new PdmP2ReviewDecisionRequest(1, true, "not enabled"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly SqliteConnection _connection;
        public HttpClient Client { get; }

        private Fixture(WebApplication app, SqliteConnection connection, HttpClient client)
        {
            _app = app;
            _connection = connection;
            Client = client;
        }

        public static async Task<Fixture> StartAsync(bool enabled)
        {
            var con = new SqliteConnection("Data Source=:memory:");
            await con.OpenAsync();
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Production",
                ApplicationName = typeof(PdmP2ReviewDecisionController).Assembly.FullName
            });
            builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
            foreach (var key in new[]
            {
                "Enabled", "SchemaReady", "SingleInstanceAcknowledged",
                "PointMappingsApproved", "HistoryQueryPlanApproved",
                "HistoryUtcContractApproved"
            })
                builder.Configuration["PredictiveMaintenance:" + key] = enabled.ToString();
            foreach (var key in new[]
            {
                "ReadOnlyEnabled", "ReviewReadEnabled",
                "ReviewWriteEnabled", "ReviewSchemaReady", "IamMappingApproved"
            })
                builder.Configuration["PredictiveMaintenance:P2:" + key] = enabled.ToString();
            builder.Services.AddDbContext<PdmP2ReviewDbContext>(o => o.UseSqlite(con));
            builder.Services.AddControllers().AddApplicationPart(
                typeof(PdmP2ReviewDecisionController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
                .AddJwtBearer(o =>
                {
                    o.TokenValidationParameters = new TokenValidationParameters
                    {
                        IssuerSigningKey = new SymmetricSecurityKey(SigningKey),
                        ValidateIssuerSigningKey = true,
                        ValidIssuer = "p2-decision-tests",
                        ValidateIssuer = true,
                        ValidAudience = "p2-decision-client",
                        ValidateAudience = true,
                        ValidateLifetime = true,
                        ClockSkew = TimeSpan.Zero,
                        RoleClaimType = ClaimTypes.Role,
                        NameClaimType = ClaimTypes.NameIdentifier
                    };
                });
            builder.Services.AddAuthorization();
            var app = builder.Build();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapControllers();
            await app.StartAsync();
            if (enabled)
            {
                using var scope = app.Services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>()
                    .Database.EnsureCreatedAsync();
            }
            var url = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .First(x => x.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase));
            return new Fixture(app, con, new HttpClient
            {
                BaseAddress = new Uri(url),
                Timeout = TimeSpan.FromSeconds(10)
            });
        }

        public void Login(Guid tenant, Guid customer, Guid user, string role)
        {
            var now = DateTime.UtcNow;
            var token = new JwtSecurityToken(
                issuer: "p2-decision-tests", audience: "p2-decision-client",
                claims: new[]
                {
                    new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
                    new Claim(IoTSharpClaimTypes.Customer, customer.ToString()),
                    new Claim(ClaimTypes.NameIdentifier, user.ToString()),
                    new Claim(ClaimTypes.Role, role)
                },
                notBefore: now.AddSeconds(-5),
                expires: now.AddMinutes(5),
                signingCredentials: new SigningCredentials(
                    new SymmetricSecurityKey(SigningKey), SecurityAlgorithms.HmacSha256));
            Client.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer",
                    new JwtSecurityTokenHandler().WriteToken(token));
        }

        public async Task<Guid> SeedAsync(Guid tenant, Guid customer, Guid authorId)
        {
            using var scope = _app.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>();
            var item = new PdmP2ReviewRecord
            {
                TenantId = tenant, CustomerId = customer, DeviceId = Guid.NewGuid(),
                ProfileId = Guid.NewGuid(), ProfileVersion = 2, RiskEventId = Guid.NewGuid(),
                Fingerprint = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"),
                Title = "Synthetic review", State = "AwaitingHumanReview",
                Revision = 1, CreatedAtUtc = DateTime.UtcNow, UpdatedAtUtc = DateTime.UtcNow
            };
            db.Reviews.Add(item);
            db.Audits.Add(new PdmP2ReviewAudit
            {
                ReviewId = item.Id, TenantId = tenant, CustomerId = customer,
                ActorId = authorId, Action = "DraftCreated", Reason = "Synthetic",
                AtUtc = DateTime.UtcNow
            });
            await db.SaveChangesAsync();
            return item.Id;
        }

        public async Task<string> StateAsync(Guid id)
        {
            using var scope = _app.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>();
            return (await db.Reviews.AsNoTracking().SingleAsync(r => r.Id == id)).State;
        }

        public async Task<int> AuditCountAsync(Guid id)
        {
            using var scope = _app.Services.CreateScope();
            return await scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>()
                .Audits.CountAsync(a => a.ReviewId == id);
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
            await _connection.DisposeAsync();
        }
    }
}

