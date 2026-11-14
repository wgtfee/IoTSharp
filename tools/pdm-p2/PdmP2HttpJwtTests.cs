using System;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Controllers;
using IoTSharp.Data;
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

/// <summary>Real Kestrel + JWT Bearer middleware; only loopback port and in-memory SQLite.</summary>
public sealed class PdmP2HttpJwtTests
{
    private static readonly byte[] Secret =
        Encoding.UTF8.GetBytes("Pdm-P2-Synthetic-Integration-Key-Do-Not-Use-In-Production-2026");

    [Fact]
    public async Task AnonymousForgedAndCrossScopeRequestsAreRejectedByRealHttpPipeline()
    {
        await using var test = await Fixture.Start(enabled: true);
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var own = Guid.NewGuid();
        var foreign = Guid.NewGuid();
        await test.Seed(tenant, customer, own);
        await test.Seed(Guid.NewGuid(), customer, foreign);

        using (var unauthenticated = await test.Client.GetAsync("/api/pdm/p2/shadow?deviceId=" + own))
            Assert.Equal(HttpStatusCode.Unauthorized, unauthenticated.StatusCode);

        test.Login(tenant, customer);
        using (var ownResult = await test.Client.GetAsync("/api/pdm/p2/shadow?deviceId=" + own))
        {
            Assert.Equal(HttpStatusCode.OK, ownResult.StatusCode);
            var content = await ownResult.Content.ReadAsStringAsync();
            using var json = JsonDocument.Parse(content);
            var data = json.RootElement.GetProperty("data");
            Assert.Equal("Unknown", data.GetProperty("state").GetString());
            Assert.True(data.GetProperty("readOnly").GetBoolean());
        }
        using (var foreignResult = await test.Client.GetAsync("/api/pdm/p2/shadow?deviceId=" + foreign))
            Assert.Equal(HttpStatusCode.NotFound, foreignResult.StatusCode);

        test.Client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", "not.a.trusted.jwt");
        using var forged = await test.Client.GetAsync("/api/pdm/p2/shadow?deviceId=" + own);
        Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
    }

    [Fact]
    public async Task P2Disabled_AuthenticatedQueryReturns503WithoutDbMigration()
    {
        await using var test = await Fixture.Start(enabled: false);
        test.Login(Guid.NewGuid(), Guid.NewGuid());
        using var response = await test.Client.GetAsync("/api/pdm/p2/shadow?deviceId=" + Guid.NewGuid());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly SqliteConnection _con;
        public HttpClient Client { get; }

        private Fixture(WebApplication app, SqliteConnection con, HttpClient client)
        {
            _app = app; _con = con; Client = client;
        }

        public static async Task<Fixture> Start(bool enabled)
        {
            var con = new SqliteConnection("Data Source=:memory:");
            await con.OpenAsync();
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                ApplicationName = typeof(PdmP2ShadowController).Assembly.FullName,
                EnvironmentName = "Production"
            });
            builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
            foreach (var key in new[]
            {
                "Enabled", "SchemaReady", "SingleInstanceAcknowledged",
                "PointMappingsApproved", "HistoryQueryPlanApproved", "HistoryUtcContractApproved"
            })
                builder.Configuration["PredictiveMaintenance:" + key] = enabled.ToString();
            builder.Configuration["PredictiveMaintenance:P2:ReadOnlyEnabled"] = enabled.ToString();
            builder.Services.AddDbContext<PdmDbContext>(o => o.UseSqlite(con));
            builder.Services.AddControllers().AddApplicationPart(typeof(PdmP2ShadowController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
            {
                o.TokenValidationParameters = new TokenValidationParameters
                {
                    IssuerSigningKey = new SymmetricSecurityKey(Secret),
                    ValidateIssuerSigningKey = true,
                    ValidIssuer = "p2-loopback", ValidateIssuer = true,
                    ValidAudience = "p2-test", ValidateAudience = true,
                    ValidateLifetime = true, ClockSkew = TimeSpan.Zero
                };
            });
            builder.Services.AddAuthorization();
            var app = builder.Build();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapControllers();
            await app.StartAsync();
            var url = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .First(a => a.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase));
            var client = new HttpClient { BaseAddress = new Uri(url), Timeout = TimeSpan.FromSeconds(8) };
            if (enabled)
            {
                using var scope = app.Services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<PdmDbContext>().Database.EnsureCreatedAsync();
            }
            return new Fixture(app, con, client);
        }

        public void Login(Guid tenant, Guid customer)
        {
            var now = DateTime.UtcNow;
            var jwt = new JwtSecurityToken(
                issuer: "p2-loopback", audience: "p2-test",
                claims: new[]
                {
                    new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
                    new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
                },
                notBefore: now.AddSeconds(-5), expires: now.AddMinutes(5),
                signingCredentials: new SigningCredentials(
                    new SymmetricSecurityKey(Secret), SecurityAlgorithms.HmacSha256));
            Client.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(jwt));
        }

        public async Task Seed(Guid tenant, Guid customer, Guid device)
        {
            using var scope = _app.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
            db.DeviceProfiles.Add(new PdmDeviceProfile
            {
                TenantId = tenant, CustomerId = customer, DeviceId = device,
                Enabled = true, PointMappingsVerified = true, RunStateVerified = true
            });
            await db.SaveChangesAsync();
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
            await _con.DisposeAsync();
        }
    }
}

