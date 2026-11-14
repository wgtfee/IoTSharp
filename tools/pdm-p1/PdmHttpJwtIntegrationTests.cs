using System;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Sockets;
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
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.Tests;

/// <summary>
/// Real loopback Kestrel/JwtBearer pipeline, not a direct Controller method call.
/// Uses only SQLite :memory:, synthetic tokens, a random ephemeral loopback port.
/// </summary>
public sealed class PdmHttpJwtIntegrationTests
{
    private static readonly byte[] TestSigningKey =
        Encoding.UTF8.GetBytes("Pdm-ReadOnly-Integration-Secret-Never-Production-2026-11");

    [Fact]
    public async Task RealHttpJwtRejectsAnonymousTamperingAndCrossTenantCrossCustomerAccess()
    {
        await using var fixture = await PdmHttpFixture.CreateAsync(enabled: true);
        var ownTenant = Guid.NewGuid();
        var ownCustomer = Guid.NewGuid();
        var otherTenant = Guid.NewGuid();
        var otherCustomer = Guid.NewGuid();
        var ownDevice = Guid.NewGuid();
        var foreignTenantDevice = Guid.NewGuid();
        var foreignCustomerDevice = Guid.NewGuid();

        await fixture.SeedAsync(ownTenant, ownCustomer, ownDevice);
        await fixture.SeedAsync(otherTenant, ownCustomer, foreignTenantDevice);
        await fixture.SeedAsync(ownTenant, otherCustomer, foreignCustomerDevice);

        // [Authorize] is enforced by actual ASP.NET Core middleware.
        using (var anonymous = await fixture.Client.GetAsync("/api/pdm/overview"))
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        fixture.Authenticate(ownTenant, ownCustomer);
        using (var status = await fixture.Client.GetAsync("/api/pdm/status"))
            Assert.Equal(HttpStatusCode.OK, status.StatusCode);

        using (var overviewResponse = await fixture.Client.GetAsync("/api/pdm/overview?page=1&pageSize=20"))
        {
            Assert.Equal(HttpStatusCode.OK, overviewResponse.StatusCode);
            using var json = JsonDocument.Parse(await overviewResponse.Content.ReadAsStringAsync());
            var rows = json.RootElement.GetProperty("data").GetProperty("rows");
            Assert.Single(rows.EnumerateArray());
            Assert.Equal(ownDevice.ToString(), rows[0].GetProperty("deviceId").GetString());
            Assert.Equal(1, json.RootElement.GetProperty("data").GetProperty("totalDevices").GetInt32());
        }
        using (var riskResponse = await fixture.Client.GetAsync("/api/pdm/risks?status=Open"))
        {
            Assert.Equal(HttpStatusCode.OK, riskResponse.StatusCode);
            using var json = JsonDocument.Parse(await riskResponse.Content.ReadAsStringAsync());
            Assert.Single(json.RootElement.GetProperty("data").GetProperty("rows").EnumerateArray());
            Assert.Equal(1, json.RootElement.GetProperty("data").GetProperty("total").GetInt32());
        }

        using (var otherTenantAccess =
               await fixture.Client.GetAsync($"/api/pdm/profile?deviceId={foreignTenantDevice}"))
            Assert.Equal(HttpStatusCode.NotFound, otherTenantAccess.StatusCode);
        using (var otherCustomerAccess =
               await fixture.Client.GetAsync($"/api/pdm/trend?deviceId={foreignCustomerDevice}"))
            Assert.Equal(HttpStatusCode.NotFound, otherCustomerAccess.StatusCode);

        fixture.Client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", "invalid.signature.token");
        using (var forged = await fixture.Client.GetAsync("/api/pdm/risks"))
            Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
    }

    [Fact]
    public async Task FeatureDisabled_AuthenticatesButReturns503ForAllBusinessQueries()
    {
        await using var fixture = await PdmHttpFixture.CreateAsync(enabled: false);
        fixture.Authenticate(Guid.NewGuid(), Guid.NewGuid());
        using var status = await fixture.Client.GetAsync("/api/pdm/status");
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        using var json = JsonDocument.Parse(await status.Content.ReadAsStringAsync());
        Assert.False(json.RootElement.GetProperty("data").GetProperty("configured").GetBoolean());

        foreach (var path in new[]
        {
            "/api/pdm/overview",
            "/api/pdm/risks",
            $"/api/pdm/profile?deviceId={Guid.NewGuid()}",
            $"/api/pdm/trend?deviceId={Guid.NewGuid()}"
        })
        {
            using var response = await fixture.Client.GetAsync(path);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        }
    }

    private sealed class PdmHttpFixture : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly SqliteConnection _dbConnection;
        public HttpClient Client { get; }

        private PdmHttpFixture(WebApplication app, SqliteConnection connection, HttpClient client)
        {
            _app = app;
            _dbConnection = connection;
            Client = client;
        }

        public static async Task<PdmHttpFixture> CreateAsync(bool enabled)
        {
            var dbConnection = new SqliteConnection("Data Source=:memory:");
            await dbConnection.OpenAsync();
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Production",
                ApplicationName = typeof(PdmReadController).Assembly.FullName
            });
            builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
            var enabledText = enabled ? "true" : "false";
            builder.Configuration.AddInMemoryCollection(new System.Collections.Generic.Dictionary<string, string?>
            {
                ["PredictiveMaintenance:Enabled"] = enabledText,
                ["PredictiveMaintenance:SchemaReady"] = enabledText,
                ["PredictiveMaintenance:SingleInstanceAcknowledged"] = enabledText,
                ["PredictiveMaintenance:PointMappingsApproved"] = enabledText,
                ["PredictiveMaintenance:HistoryQueryPlanApproved"] = enabledText,
                ["PredictiveMaintenance:HistoryUtcContractApproved"] = enabledText
            });
            builder.Services.AddDbContext<PdmDbContext>(options => options.UseSqlite(dbConnection));
            builder.Services.AddControllers().AddApplicationPart(typeof(PdmReadController).Assembly);
            builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
            {
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = new SymmetricSecurityKey(TestSigningKey),
                    ValidateIssuer = true,
                    ValidIssuer = "pdm-test-issued",
                    ValidateAudience = true,
                    ValidAudience = "pdm-test-client",
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.Zero
                };
            });
            builder.Services.AddAuthorization();
            var app = builder.Build();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapControllers();
            await app.StartAsync();
            var feature = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>();
            var url = feature?.Addresses.FirstOrDefault(address =>
                address.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase));
            if (url is null)
                throw new InvalidOperationException("No isolated dynamic loopback address for JWT integration");
            var client = new HttpClient { BaseAddress = new Uri(url), Timeout = TimeSpan.FromSeconds(8) };

            if (enabled)
            {
                using var scope = app.Services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<PdmDbContext>().Database.EnsureCreatedAsync();
            }
            return new PdmHttpFixture(app, dbConnection, client);
        }

        public void Authenticate(Guid tenant, Guid customer)
        {
            var now = DateTime.UtcNow;
            var jwt = new JwtSecurityToken(
                issuer: "pdm-test-issued",
                audience: "pdm-test-client",
                claims: [
                    new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
                    new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
                ],
                notBefore: now.AddSeconds(-5),
                expires: now.AddMinutes(4),
                signingCredentials: new SigningCredentials(
                    new SymmetricSecurityKey(TestSigningKey), SecurityAlgorithms.HmacSha256));
            var value = new JwtSecurityTokenHandler().WriteToken(jwt);
            Client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", value);
        }

        public async Task SeedAsync(Guid tenant, Guid customer, Guid device)
        {
            using var scope = _app.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PdmDbContext>();
            var profile = new PdmDeviceProfile
            {
                TenantId = tenant, CustomerId = customer, DeviceId = device,
                Enabled = true, PointMappingsVerified = true, RunStateVerified = true
            };
            db.DeviceProfiles.Add(profile);
            db.HealthSnapshots.Add(new PdmHealthSnapshot
            {
                TenantId = tenant, CustomerId = customer, DeviceId = device,
                ProfileId = profile.Id, ProfileVersion = 1,
                WindowStartUtc = DateTime.UtcNow.AddMinutes(-15),
                WindowEndUtc = DateTime.UtcNow,
                HealthIndex = 42, DataQuality = "Good", RiskLevel = "Warning"
            });
            db.RiskEvents.Add(new PdmRiskEvent
            {
                TenantId = tenant, CustomerId = customer, DeviceId = device,
                ProfileId = profile.Id, EventKey = device.ToString("N"),
                RiskType = "device-health", RiskLevel = "Warning",
                FirstObservedUtc = DateTime.UtcNow.AddMinutes(-15),
                LastObservedUtc = DateTime.UtcNow
            });
            await db.SaveChangesAsync();
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
            await _dbConnection.DisposeAsync();
        }
    }
}

