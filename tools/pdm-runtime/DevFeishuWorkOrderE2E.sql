-- ONE-TIME E2E fixture for 2026-11-14. Strictly local dedicated SQL Server Dev.
-- This is NOT a field fault, real equipment, or a production repair request.
-- DeliveryKey must be checked against FeishuPushMCP before executing.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'IoTSharpPdmDev'
    THROW 51140, 'Refusing to insert a development work order into any non-dev DB.', 1;

DECLARE @deliveryKey nvarchar(128) = N'iotsharp-wo:dev-e2e-20261114-r1';
IF EXISTS (SELECT 1 FROM dbo.PdmInternalWorkOrderNotifications
    WHERE DeliveryKey = @deliveryKey)
    THROW 51141, 'E2E delivery key already exists; inspect previous send, do not retry.', 1;

DECLARE @orderId uniqueidentifier = NEWID(),
    @tenantId uniqueidentifier = NEWID(),
    @customerId uniqueidentifier = NEWID(),
    @deviceId uniqueidentifier = NEWID(),
    @workerId uniqueidentifier = NEWID(),
    @noticeId uniqueidentifier = NEWID(),
    @now datetime2(7) = SYSUTCDATETIME();

BEGIN TRANSACTION;
INSERT INTO dbo.PdmInternalWorkOrders
(Id,TenantId,CustomerId,DeviceId,ProfileId,ProfileVersion,RiskEventId,
 WorkOrderNo,RiskLevel,Title,Description,State,AssignedTo,Resolution,Revision,
 FirstObservedUtc,CreatedAtUtc,UpdatedAtUtc,CompletedAtUtc,ClosedAtUtc)
VALUES
(@orderId,@tenantId,@customerId,@deviceId,NEWID(),1,NEWID(),
 N'PM-DEV-20261114-E2E-R1',N'Warning',
 N'【联调测试】IoTSharp 维修工单通知演练',
 N'仅为本机独立开发数据库与 Feishu MCP 的端到端联调；不代表真实设备故障，禁止依据本单进行现场维修或生产派工。',
 N'Open',NULL,N'',1,@now,@now,@now,NULL,NULL);

INSERT INTO dbo.PdmInternalWorkOrderNotifications
(Id,TenantId,CustomerId,WorkOrderId,DeliveryKey,Channel,State,
 ClaimedBy,ClaimedAtUtc,AcknowledgedAtUtc,ExternalMessageFingerprint,CreatedAtUtc)
VALUES
(@noticeId,@tenantId,@customerId,@orderId,@deliveryKey,N'feishu',
 N'Claimed',@workerId,@now,NULL,N'',@now);

INSERT INTO dbo.PdmInternalWorkOrderAudits
(Id,TenantId,CustomerId,WorkOrderId,ActorId,Action,FromState,ToState,Reason,AtUtc)
VALUES
(NEWID(),@tenantId,@customerId,@orderId,NULL,
 N'DevTestNotificationPrepared',N'',N'Open',
 N'人工授权的开发联调，仅用于验证飞书投递，不代表生产现场发生风险。',
 @now);
COMMIT TRANSACTION;

SELECT N'ORDER_CREATED' AS [Result], WorkOrderNo, Title, [State]
FROM dbo.PdmInternalWorkOrders WHERE Id=@orderId;
SELECT N'NOTICE_CLAIMED' AS [Result], DeliveryKey, [State]
FROM dbo.PdmInternalWorkOrderNotifications WHERE Id=@noticeId;
GO
