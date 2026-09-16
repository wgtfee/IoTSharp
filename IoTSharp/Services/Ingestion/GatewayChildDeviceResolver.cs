using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.Ingestion;

/// <summary>
/// Resolves gateway child devices in batches and caches detached lightweight device identities.
/// This avoids loading Gateway.Children for every telemetry batch.
/// </summary>
public sealed class GatewayChildDeviceResolver
{
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(10);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<GatewayChildDeviceResolver> _logger;
    private readonly ConcurrentDictionary<Guid, GatewayCache> _cache = new();
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _gates = new();

    public GatewayChildDeviceResolver(
        IServiceScopeFactory scopeFactory,
        ILogger<GatewayChildDeviceResolver> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task<IReadOnlyDictionary<string, Device>> ResolveManyAsync(
        Device gateway,
        IReadOnlyCollection<string> childNames,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(gateway);
        if (gateway.DeviceType != DeviceType.Gateway)
            throw new InvalidOperationException($"Device {gateway.Id} is not a gateway.");

        var requested = childNames
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => name.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (requested.Length == 0)
            return new Dictionary<string, Device>(StringComparer.OrdinalIgnoreCase);

        if (TryFromCache(gateway.Id, requested, out var cached))
            return cached;

        var gate = _gates.GetOrAdd(gateway.Id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (TryFromCache(gateway.Id, requested, out cached))
                return cached;

            var current = GetCurrentCache(gateway.Id);
            var devices = new Dictionary<string, Device>(current.Devices, StringComparer.OrdinalIgnoreCase);
            var missing = requested.Where(name => !devices.ContainsKey(name)).ToArray();
            if (missing.Length > 0)
            {
                using var scope = _scopeFactory.CreateScope();
                await using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

                var existing = await dbContext.Device
                    .AsNoTracking()
                    .Where(device =>
                        EF.Property<Guid?>(device, "OwnerId") == gateway.Id
                        && missing.Contains(device.Name)
                        && !device.Deleted)
                    .ToListAsync(cancellationToken);

                foreach (var device in existing)
                    devices[device.Name] = Clone(device);

                var stillMissing = missing
                    .Where(name => !devices.ContainsKey(name))
                    .ToArray();
                if (stillMissing.Length > 0)
                {
                    var trackedGateway = await dbContext.Gateway
                        .Include(item => item.Tenant)
                        .Include(item => item.Customer)
                        .FirstOrDefaultAsync(item => item.Id == gateway.Id, cancellationToken)
                        ?? throw new InvalidOperationException($"Gateway {gateway.Id} does not exist.");

                    foreach (var name in stillMissing)
                    {
                        var child = new Device
                        {
                            Id = Guid.NewGuid(),
                            Name = name,
                            DeviceType = DeviceType.Device,
                            Owner = trackedGateway,
                            Tenant = trackedGateway.Tenant,
                            TenantId = trackedGateway.TenantId,
                            Customer = trackedGateway.Customer,
                            CustomerId = trackedGateway.CustomerId,
                            Timeout = 300
                        };
                        dbContext.Device.Add(child);
                        dbContext.AfterCreateDevice(child);
                        devices[name] = Clone(child);
                    }

                    await dbContext.SaveChangesAsync(cancellationToken);
                    _logger.LogInformation(
                        "Gateway {GatewayId} created {Count} child devices for batch ingest.",
                        gateway.Id,
                        stillMissing.Length);
                }
            }

            var updated = new GatewayCache(
                devices.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase),
                DateTime.UtcNow.Add(CacheLifetime));
            _cache[gateway.Id] = updated;
            return SelectRequested(updated.Devices, requested);
        }
        finally
        {
            gate.Release();
        }
    }

    private bool TryFromCache(Guid gatewayId, string[] requested, out IReadOnlyDictionary<string, Device> result)
    {
        if (_cache.TryGetValue(gatewayId, out var cache)
            && cache.ExpiresAtUtc > DateTime.UtcNow
            && requested.All(cache.Devices.ContainsKey))
        {
            result = SelectRequested(cache.Devices, requested);
            return true;
        }

        result = null!;
        return false;
    }

    private GatewayCache GetCurrentCache(Guid gatewayId)
    {
        if (_cache.TryGetValue(gatewayId, out var cache) && cache.ExpiresAtUtc > DateTime.UtcNow)
            return cache;

        return GatewayCache.Empty;
    }

    private static IReadOnlyDictionary<string, Device> SelectRequested(
        IReadOnlyDictionary<string, Device> source,
        IEnumerable<string> requested)
        => requested.ToDictionary(name => name, name => source[name], StringComparer.OrdinalIgnoreCase);

    private static Device Clone(Device device) => new()
    {
        Id = device.Id,
        Name = device.Name,
        DeviceType = device.DeviceType,
        Timeout = device.Timeout,
        TenantId = device.TenantId,
        CustomerId = device.CustomerId,
        Deleted = device.Deleted
    };

    private sealed class GatewayCache
    {
        public static GatewayCache Empty { get; } = new(
            new Dictionary<string, Device>(StringComparer.OrdinalIgnoreCase).ToFrozenDictionary(StringComparer.OrdinalIgnoreCase),
            DateTime.MinValue);

        public GatewayCache(IReadOnlyDictionary<string, Device> devices, DateTime expiresAtUtc)
        {
            Devices = devices;
            ExpiresAtUtc = expiresAtUtc;
        }

        public IReadOnlyDictionary<string, Device> Devices { get; }
        public DateTime ExpiresAtUtc { get; }
    }
}
