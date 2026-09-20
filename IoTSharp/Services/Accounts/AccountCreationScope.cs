using System;

namespace IoTSharp.Services.Accounts
{
    /// <summary>创建普通账号的归属权限；系统管理员跨租户，租户管理员仅本租户，客户管理员仅本客户。</summary>
    internal static class AccountCreationScope
    {
        internal static bool IsAllowed(bool systemAdmin, bool tenantAdmin, bool customerAdmin,
            Guid callerTenant, Guid callerCustomer, Guid targetTenant, Guid targetCustomer)
        {
            if (targetTenant == Guid.Empty || targetCustomer == Guid.Empty) return false;
            if (systemAdmin) return true;
            if (callerTenant == Guid.Empty || callerTenant != targetTenant) return false;
            return tenantAdmin || (customerAdmin && callerCustomer != Guid.Empty && callerCustomer == targetCustomer);
        }
    }
}
