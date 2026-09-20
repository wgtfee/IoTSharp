using IoTSharp.Services.Accounts;

var tenant = Guid.NewGuid(); var otherTenant = Guid.NewGuid();
var customer = Guid.NewGuid(); var otherCustomer = Guid.NewGuid();
var checks = 0;
void Check(bool expected, bool systemAdmin, bool tenantAdmin, bool customerAdmin, Guid callerTenant, Guid callerCustomer, Guid targetTenant, Guid targetCustomer)
{
    if (AccountCreationScope.IsAllowed(systemAdmin, tenantAdmin, customerAdmin, callerTenant, callerCustomer, targetTenant, targetCustomer) != expected)
        throw new InvalidOperationException($"Account creation scope case {checks + 1} failed");
    checks++;
}
Check(true, true, false, false, tenant, customer, otherTenant, otherCustomer);
Check(true, false, true, false, tenant, customer, tenant, otherCustomer);
Check(true, false, false, true, tenant, customer, tenant, customer);
Check(false, false, true, false, tenant, customer, otherTenant, otherCustomer);
Check(false, false, false, true, tenant, customer, tenant, otherCustomer);
Check(false, false, false, true, tenant, customer, otherTenant, customer);
Check(false, false, false, false, tenant, customer, tenant, customer);
Check(false, false, false, true, Guid.Empty, customer, tenant, customer);
Check(false, false, false, true, tenant, Guid.Empty, tenant, customer);
foreach (var system in new[] { false, true })
{
    Check(false, system, true, true, tenant, customer, Guid.Empty, customer);
    Check(false, system, true, true, tenant, customer, tenant, Guid.Empty);
}
Console.WriteLine($"Account creation scope PASS: {checks} cases; no database writes");
