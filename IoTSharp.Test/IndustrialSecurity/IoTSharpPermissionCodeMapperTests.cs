using IoTSharp.Contracts;
using IoTSharp.IndustrialSecurity;

namespace IoTSharp.Test.IndustrialSecurity;

public sealed class IoTSharpPermissionCodeMapperTests
{
    [Fact]
    public void NormalUser_CanViewDevicesAndTelemetry_ButCannotManage()
    {
        var roles = new[] { nameof(UserRole.NormalUser) };

        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.device.view", "IoT.Device.View"));
        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.telemetry.view", "IoT.Telemetry.View"));
        Assert.False(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.device.manage", "IoT.Device.Manage"));
        Assert.False(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.device.command", "IoT.Device.Command"));
    }

    [Fact]
    public void CustomerAdmin_CanManageDevices_ButCannotAdministerTenant()
    {
        var roles = new[] { nameof(UserRole.CustomerAdmin) };

        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.device.manage", "IoT.Device.Manage"));
        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.device.command", "IoT.Device.Command"));
        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.customer.admin", "IoT.Customer.Admin"));
        Assert.False(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.tenant.admin", "IoT.Tenant.Admin"));
    }

    [Fact]
    public void TenantAdmin_CanAdministerTenant()
    {
        var roles = new[] { nameof(UserRole.TenantAdmin) };
        Assert.True(IoTSharpPermissionCodeMapper.RoleAllows(roles, "iot.tenant.admin", "IoT.Tenant.Admin"));
    }

    [Fact]
    public void SystemAdmin_ReceivesWildcardPermission()
    {
        var permissions = IoTSharpPermissionCodeMapper.PermissionsForRoles(new[] { nameof(UserRole.SystemAdmin) });
        Assert.Contains("*", permissions);
        Assert.Contains("iot.device.manage", permissions);
        Assert.Contains("iot.tenant.admin", permissions);
    }

    [Theory]
    [InlineData("iot.device.view", "IoT.Device.View")]
    [InlineData("iot.device.manage", "IoT.Device.Manage")]
    [InlineData("iot.device.command", "IoT.Device.Command")]
    [InlineData("iot.telemetry.view", "IoT.Telemetry.View")]
    public void CanonicalPermission_MapsToExistingIoTAuthorization(string platformCode, string localCode)
    {
        Assert.Equal(localCode, IoTSharpPermissionCodeMapper.ToLocalCode(platformCode));
        Assert.Equal(platformCode, IoTSharpPermissionCodeMapper.ToCanonicalCode(localCode));
    }
}
