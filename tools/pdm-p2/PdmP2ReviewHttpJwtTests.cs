using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
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

public sealed class PdmP2ReviewHttpJwtTests
{
    private static readonly byte[] Key =
        Encoding.UTF8.GetBytes("P2-Review-Read-Loopback-Testing-Only-2026-11-13");

    [Fact]
    public async Task RealJwtHttpMiddleware_RejectsForeignReviewTrailsAndForgedTokens()
    {
        var tenant = Guid.NewGuid();
        var customer = Guid.NewGuid();
        var device = Guid.NewGuid();
        await using var con = new SqliteConnection("Data Source=:memory:");
        await con.OpenAsync();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Production",
            ApplicationName = typeof(PdmP2ReviewReadController).Assembly.FullName
        });
        builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
        foreach (var key in new[]
        {
            "Enabled", "SchemaReady", "SingleInstanceAcknowledged",
            "PointMappingsApproved", "HistoryQueryPlanApproved",
            "HistoryUtcContractApproved"
        })
            builder.Configuration["PredictiveMaintenance:" + key] = "true";
        builder.Configuration["PredictiveMaintenance:P2:ReadOnlyEnabled"] = "true";
        builder.Configuration["PredictiveMaintenance:P2:ReviewReadEnabled"] = "true";
        builder.Services.AddDbContext<PdmP2ReviewDbContext>(o => o.UseSqlite(con));
        builder.Services.AddControllers().AddApplicationPart(
            typeof(PdmP2ReviewReadController).Assembly);
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(o =>
            {
                o.TokenValidationParameters = new TokenValidationParameters
                {
                    IssuerSigningKey = new SymmetricSecurityKey(Key),
                    ValidateIssuerSigningKey = true,
                    ValidIssuer = "p2-review-loopback",
                    ValidateIssuer = true,
                    ValidAudience = "p2-review-tests",
                    ValidateAudience = true,
                    ValidateLifetime = true, ClockSkew = TimeSpan.Zero
                };
            });
        builder.Services.AddAuthorization();
        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        await app.StartAsync();

        try
        {
            using (var scope = app.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PdmP2ReviewDbContext>();
                await db.Database.EnsureCreatedAsync();
                db.Reviews.AddRange(
                    Record(tenant, customer, device),
                    Record(Guid.NewGuid(), customer, device),
                    Record(tenant, Guid.NewGuid(), device),
                    Record(tenant, customer, Guid.NewGuid()));
                await db.SaveChangesAsync();
            }

            var url = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses
                .First(s => s.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase));
            using var http = new HttpClient { BaseAddress = new Uri(url) };
            var path = "/api/pdm/p2/reviews?deviceId=" + device;
            using (var anonymous = await http.GetAsync(path))
                Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

            Login(http, tenant, customer);
            using (var result = await http.GetAsync(path))
            {
                Assert.Equal(HttpStatusCode.OK, result.StatusCode);
                using var doc = JsonDocument.Parse(await result.Content.ReadAsStringAsync());
                var data = doc.RootElement.GetProperty("data");
                Assert.Equal(1, data.GetProperty("total").GetInt32());
                Assert.Single(data.GetProperty("rows").EnumerateArray());
                Assert.Equal(device.ToString(),
                    data.GetProperty("rows")[0].GetProperty("deviceId").GetString());
            }

            Login(http, Guid.NewGuid(), customer);
            using (var other = await http.GetAsync(path))
            {
                Assert.Equal(HttpStatusCode.OK, other.StatusCode);
                using var doc = JsonDocument.Parse(await other.Content.ReadAsStringAsync());
                Assert.Equal(0, doc.RootElement.GetProperty("data").GetProperty("total").GetInt32());
            }

            http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", "forged.not.a.valid.jwt");
            using var forged = await http.GetAsync(path);
            Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static PdmP2ReviewRecord Record(Guid tenant, Guid customer, Guid device)
    {
        var id = Guid.NewGuid();
        return new()
        {
            Id = id, TenantId = tenant, CustomerId = customer, DeviceId = device,
            ProfileId = Guid.NewGuid(), ProfileVersion = 1, RiskEventId = Guid.NewGuid(),
            Fingerprint = id.ToString("N") + id.ToString("N"),
            Title = "仅用于隔离安全测试", State = "AwaitingHumanReview",
            CreatedAtUtc = DateTime.UtcNow, UpdatedAtUtc = DateTime.UtcNow
        };
    }

    private static void Login(HttpClient http, Guid tenant, Guid customer)
    {
        var now = DateTime.UtcNow;
        var token = new JwtSecurityToken(
            issuer: "p2-review-loopback", audience: "p2-review-tests",
            claims: new[]
            {
                new Claim(IoTSharpClaimTypes.Tenant, tenant.ToString()),
                new Claim(IoTSharpClaimTypes.Customer, customer.ToString())
            },
            notBefore: now.AddSeconds(-5), expires: now.AddMinutes(5),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Key), SecurityAlgorithms.HmacSha256));
        http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer",
                new JwtSecurityTokenHandler().WriteToken(token));
    }
}

