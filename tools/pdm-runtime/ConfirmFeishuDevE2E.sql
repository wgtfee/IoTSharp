-- One-time real Feishu MCP acknowledgement; only for isolated dev database.
-- Verified via get_feishu_delivery_status:
-- status=confirmed, acceptedCount=1, requestId=a41764d92ff449c5a6dd601e072dfbca
-- external message id SHA256 is stored instead of raw Feishu message id.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'IoTSharpPdmDev'
    THROW 51150, 'Refusing to acknowledge a Feishu test outside dedicated PdM development DB.', 1;

DECLARE @key nvarchar(128) = N'iotsharp-wo:dev-e2e-20261114-r1';
DECLARE @sha nvarchar(64) = N'7123dd8eded4e0675c1ebfed0c0b18711197f90a2a56273c3b4c797baced69e0';

BEGIN TRANSACTION;
UPDATE n
    SET n.State = N'Confirmed',
        n.ExternalMessageFingerprint = @sha,
        n.AcknowledgedAtUtc = SYSUTCDATETIME()
FROM dbo.PdmInternalWorkOrderNotifications n
INNER JOIN dbo.PdmInternalWorkOrders o ON o.Id = n.WorkOrderId
WHERE n.DeliveryKey = @key
  AND o.WorkOrderNo = N'PM-DEV-20261114-E2E-R1'
  AND o.Title LIKE N'%IoTSharp%'
  AND n.Channel = N'feishu'
  AND n.State = N'Claimed'
  AND n.AcknowledgedAtUtc IS NULL;
IF @@ROWCOUNT <> 1
    THROW 51151, 'No exactly-one claimed test notification; not modifying any other data.', 1;

INSERT INTO dbo.PdmInternalWorkOrderAudits
(Id, TenantId, CustomerId, WorkOrderId, ActorId, Action, FromState,
 ToState, Reason, AtUtc)
SELECT NEWID(), n.TenantId, n.CustomerId, n.WorkOrderId, NULL,
       N'FeishuDeliveryConfirmed', N'Open', N'Open',
       N'Feishu MCP actual delivery confirmed; request a41764d92ff449c5a6dd601e072dfbca; dev-only test',
       SYSUTCDATETIME()
FROM dbo.PdmInternalWorkOrderNotifications n
WHERE n.DeliveryKey = @key
  AND n.State = N'Confirmed';
IF @@ROWCOUNT <> 1
    THROW 51152, 'Feishu audit insertion did not match the expected test notification.', 1;
COMMIT TRANSACTION;

SELECT N'ACKNOWLEDGED' AS [Result], n.DeliveryKey, n.State,
       LEN(n.ExternalMessageFingerprint) AS FingerprintLength,
       o.WorkOrderNo
FROM dbo.PdmInternalWorkOrderNotifications n
JOIN dbo.PdmInternalWorkOrders o ON n.WorkOrderId = o.Id
WHERE n.DeliveryKey = @key;
GO
