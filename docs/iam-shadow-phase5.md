# IoTSharp IAM Shadow rollout (Phase 5)

## Goal

Phase 5 gives IoTSharp a platform IAM identity while preserving IoTSharp's existing local
roles and Customer/Tenant/device data-scope rules as the production authorization result.
ThingsGateway is integrated separately as a machine identity; device acquisition never
waits on IAM per telemetry sample.

```text
Browser
  -> Gateway /iot
  -> IAM session + Authorization Code/PKCE
  -> IAM AccessToken
  -> IoTSharp JwtBearer
  -> Industrial.Security IdentityMapping
       -> IAM SystemAccess(IOT)
       -> IAM global_user_id -> explicitly bound IdentityUser.Id
  -> IoTSharp local identity overlay
       -> local roles
       -> Customer/Tenant claims
       -> local permission claims
  -> existing IoTSharp Authorize/data-scope rules (authoritative)
  -> Industrial.Security Shadow comparison (telemetry only)

ThingsGateway
  -> cached client-credentials token
  -> low-frequency control/platform calls

PLC/protocol/telemetry runtime
  -> NEVER calls IAM per sample
```

## 1. Preparation profile

Do not switch existing operators to IAM immediately. Start with:

```text
INDUSTRIAL_SECURITY_PROFILE=IamPrepare
```

Effective behavior:

```text
Authentication = Local
Authorization  = Local
ResourceSync   = Enabled
SystemCode     = IOT
```

The existing IoTSharp login, local roles and Customer/Tenant claims remain unchanged while
the IAM catalog and user mappings are prepared.

## 2. Service secret for IoT resource sync

Configure the same strong secret on both sides without committing it:

IAM:

```text
Iam__BootstrapIotClientSecret=<secret>
```

IoTSharp:

```text
Security__ResourceSync__ClientSecret=<same-secret>
```

The browser never receives this secret.

## 3. Permission catalog

The canonical IAM capabilities are:

```text
iot.device.view
iot.device.manage
iot.device.command
iot.telemetry.view
iot.customer.admin
iot.tenant.admin
```

IAM only models capability. IoTSharp continues to decide which Tenant, Customer and
individual device the current local business identity may access.

Two legacy aliases are intentionally present during Shadow:

```text
IoT.Device.View
IoT.Device.Command
```

They exist because legacy controller attributes still emit those exact codes. They are
marked deprecated in `permission-manifest.json` and must be removed when the matching
controllers are converted to canonical `iot.*` attributes before final Centralized cutover.

## 4. Role templates

A local SystemAdmin can inspect deterministic migration templates:

```text
GET /api/iam-migration/RoleTemplates
```

Suggested IAM roles are:

```text
IOT_ROLE_NORMALUSER
IOT_ROLE_CUSTOMERADMIN
IOT_ROLE_TENANTADMIN
IOT_ROLE_SYSTEMADMIN
```

The returned permission set mirrors the existing local role capability. It deliberately
contains no CustomerId/TenantId/device-id permissions.

## 5. Explicit user binding

Never create a synthetic `platform_<iam-id>` IoT user and never map by user name.
Bind IAM to an existing ASP.NET Identity user:

```text
POST /api/iam-migration/Bind
{
  "localUserId": "<existing IdentityUser.Id>",
  "iamUserId": "<IAM user id>"
}
```

The binding is stored as the local Identity claim:

```text
global_user_id = <IAM user id>
```

Inspect bindings:

```text
GET /api/iam-migration/Bindings
```

Rollback a wrong mapping:

```text
POST /api/iam-migration/Unbind
{
  "localUserId": "<existing IdentityUser.Id>"
}
```

Binding never changes the existing password, role, Customer, Tenant or device ownership.

## 6. IAM SystemAccess

Before entering Shadow, grant every migrated IAM user:

```text
SystemCode = IOT
Enabled    = true
```

`RequireSystemAccess=true` is intentionally fail-closed.

## 7. Enter Shadow

After catalog, roles and user bindings are ready:

```text
INDUSTRIAL_SECURITY_PROFILE=Shadow
```

Expected effective configuration:

```text
Authentication = Centralized
Authorization  = Local
ShadowCentralAuthorization = true
ShadowUserProvisioning = RequirePreProvision
RequireSystemAccess = true
```

Do not set `Authorization=Centralized` in Phase 5.

## 8. Request identity overlay

After IAM authentication, Industrial.Security resolves `local_user_id`. IoTSharp then
places an in-memory local identity overlay first in the current ClaimsPrincipal. That
identity contains the bound local IdentityUser id, local roles and existing Customer/Tenant
claims.

This ordering is intentional because legacy IoTSharp code calls:

```text
UserManager.GetUserAsync(User)
```

and expects the first `NameIdentifier` to be the local IdentityUser.Id.

The original IAM identity remains attached, so `global_user_id`, IAM roles and permission
version remain available to Industrial.Security.

## 9. Browser login

In Local/IamPrepare mode the original IoTSharp account + slider captcha login remains.

In Shadow mode:

1. `/api/security/local-user-management` reports `centralMode=true`;
2. the login page renders the IAM login component;
3. credentials are posted to Gateway `/account/login` only to establish the IAM session;
4. the browser starts Authorization Code + PKCE using client `industrial-iot-web`;
5. redirect URI is `/iot/` (no hash fragment);
6. the router completes `/connect/token` before the normal HashRouter token guard;
7. only the short-lived access token is stored in the existing IoTSharp session token slot;
8. near expiry, a new PKCE round-trip is started while the IAM session safety window is valid.

IAM password is never stored in browser state.

## 10. Shadow observation

Track:

```text
Local=true  Central=true   expected
Local=false Central=false  expected
Local=true  Central=false  mismatch
Local=false Central=true   mismatch
CentralEvaluationFailed     infrastructure/error
```

Do not migrate to Centralized until meaningful device view/manage/command and Tenant /
Customer workflows show sustained zero unexplained mismatches.

## 11. Rollback

If Shadow identity causes an incident:

```text
INDUSTRIAL_SECURITY_PROFILE=IamPrepare
```

or remove the variable to return to the standard Local configuration. Keep the
`global_user_id` bindings during operational rollback; they are additive and unused by the
Local authentication path.

## 12. ThingsGateway boundary

ThingsGateway machine identity is configured separately with client:

```text
thingsgateway-service
```

It is not the operator login identity. Its token is cached and refreshed by a background
worker. IAM failures must not stop PLC polling, protocol drivers, buffered publishing or
local device acquisition.
