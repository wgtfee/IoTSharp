using System;
using System.Collections.Generic;

namespace IoTSharp.IndustrialSecurity;

/// <summary>
/// Stable, allow-listed application permission codes. Role grants are stored
/// in ASP.NET Identity role claims, not fabricated from the menu tree.
/// New codes must first be supported by the authorization implementation.
/// </summary>
public static class IotRolePermissionCatalog
{
    public const string ClaimType = "iotsharp.permission";

    public static IReadOnlyDictionary<string, string> Descriptions { get; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["iot.device.view"] = "查看设备",
            ["iot.device.manage"] = "管理设备",
            ["iot.device.command"] = "设备远程指令",
            ["iot.telemetry.view"] = "查看遥测",
            ["iot.customer.admin"] = "当前客户管理权限",
            ["iot.tenant.admin"] = "当前租户管理权限"
        };
}
