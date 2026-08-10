using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Industrial.Security.Abstractions;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace IoTSharp.IndustrialSecurity;

/// <summary>
/// Generates the IAM permission manifest from the IotPermissionResource table
/// (the real permission catalog) instead of a hand-written static file. Mirrors
/// MOL's MesPermissionManifestHostedService: the shared Security SDK watches the
/// generated file and synchronizes it to IAM whenever the table changes.
/// </summary>
public sealed class IotPermissionManifestHostedService(
    IConfiguration configuration,
    ILogger<IotPermissionManifestHostedService> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var manifestPath = Path.Combine(AppContext.BaseDirectory, "permission-manifest.json");
        var refreshSeconds = Math.Max(15, configuration.GetValue("Security:ResourceSync:CatalogRefreshSeconds", 60));
        var delay = TimeSpan.FromSeconds(refreshSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var manifest = await BuildAsync(stoppingToken);
                await WriteIfChangedAsync(manifestPath, manifest, stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "Failed to generate IoTSharp permission manifest; the previous manifest is preserved.");
            }

            await Task.Delay(delay, stoppingToken);
        }
    }

    private async Task<PermissionManifestRequest> BuildAsync(CancellationToken ct)
    {
        var connectionString = configuration.GetConnectionString("IoTSharp");
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new InvalidOperationException("ConnectionStrings:IoTSharp is not configured.");

        var resources = new List<PermissionResourceDto>();
        await using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT Code, Name, Type, ParentCode, Route, Sort, Enabled FROM IotPermissionResource ORDER BY Sort, Code";
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            resources.Add(new PermissionResourceDto(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                ParentCode: reader.IsDBNull(3) ? null : reader.GetString(3),
                Route: reader.IsDBNull(4) ? null : reader.GetString(4),
                Sort: reader.GetInt32(5),
                Enabled: reader.GetBoolean(6),
                MetadataJson: JsonSerializer.Serialize(new { source = "IotPermissionResource" }, JsonOptions)));
        }

        var ordered = resources.OrderBy(x => x.Code, StringComparer.OrdinalIgnoreCase).ToArray();
        var sourceBytes = JsonSerializer.SerializeToUtf8Bytes(
            ordered.Select(x => new { x.Code, x.Name, x.Type, x.ParentCode, x.Route, x.Enabled, x.MetadataJson }),
            JsonOptions);
        var sourceHash = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
        var version = $"sys-menu-{sourceHash[..12]}";
        var manifestHash = PermissionManifestHasher.Compute(IndustrialSystemCodes.Iot, version, ordered);

        return new PermissionManifestRequest(
            new PermissionManifestSystem(IndustrialSystemCodes.Iot, "IoTSharp", "Generated from IotPermissionResource"),
            version,
            manifestHash,
            ordered);
    }

    private static async Task WriteIfChangedAsync(string path, PermissionManifestRequest manifest, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true });
        var bytes = Encoding.UTF8.GetBytes(json);
        var existing = File.Exists(path) ? await File.ReadAllBytesAsync(path, ct) : null;
        if (existing is not null && existing.AsSpan().SequenceEqual(bytes))
            return;
        // Atomic replace: write to a temp file then move, so a concurrently reading
        // manifest watcher never sees a half-written file and no sharing violation
        // blocks the writer. Retry briefly in case the watcher holds a transient lock.
        var tmp = path + ".tmp";
        await File.WriteAllBytesAsync(tmp, bytes, ct);
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                File.Move(tmp, path, overwrite: true);
                return;
            }
            catch (Exception) when (attempt < 4 && !ct.IsCancellationRequested)
            {
                await Task.Delay(500, ct);
            }
        }
    }
}
