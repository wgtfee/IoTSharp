-- IoTSharp owned PdM maintenance orders and Feishu notification journal.
-- Execute EXPLICITLY only in a dedicated, reviewed PdM SQL Server database.
-- No migration against IOTSharp or telemetry production databases.
-- Transactional V001, irreversible ALTERs are not performed.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb', N'IOTSharp', N'IoTSharp')
    THROW 51110, 'PdM work-order migration refuses system/main/telemetry databases.', 1;
IF OBJECT_ID(N'dbo.PdmInternalWorkOrders', N'U') IS NOT NULL
   OR OBJECT_ID(N'dbo.PdmInternalWorkOrderNotifications', N'U') IS NOT NULL
   OR OBJECT_ID(N'dbo.PdmInternalWorkOrderAudits', N'U') IS NOT NULL
    THROW 51111, 'PdM V001 tables already exist. Review schema first; refusing blind partial migration.', 1;

BEGIN TRY
BEGIN TRANSACTION;
CREATE TABLE [dbo].[PdmInternalWorkOrders](
    [Id] uniqueidentifier NOT NULL PRIMARY KEY,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [RiskEventId] uniqueidentifier NOT NULL,
    [WorkOrderNo] nvarchar(40) NOT NULL,
    [RiskLevel] nvarchar(24) NOT NULL,
    [Title] nvarchar(240) NOT NULL,
    [Description] nvarchar(2048) NOT NULL,
    [State] nvarchar(24) NOT NULL,
    [AssignedTo] uniqueidentifier NULL,
    [Resolution] nvarchar(2000) NOT NULL,
    [Revision] int NOT NULL,
    [FirstObservedUtc] datetime2(7) NOT NULL,
    [CreatedAtUtc] datetime2(7) NOT NULL,
    [UpdatedAtUtc] datetime2(7) NOT NULL,
    [CompletedAtUtc] datetime2(7) NULL,
    [ClosedAtUtc] datetime2(7) NULL,
    CONSTRAINT [CK_PdmInternalOrder_State] CHECK ([State] IN
       (N'Open', N'Assigned', N'InProgress', N'Completed', N'Closed')),
    CONSTRAINT [CK_PdmInternalOrder_Risk] CHECK ([RiskLevel] IN (N'Warning', N'Critical')),
    CONSTRAINT [CK_PdmInternalOrder_Revision] CHECK ([Revision] >= 1)
);
CREATE UNIQUE INDEX [IX_PdmInternalWorkOrders_TenantId_CustomerId_RiskEventId]
    ON [dbo].[PdmInternalWorkOrders]([TenantId],[CustomerId],[RiskEventId]);
CREATE UNIQUE INDEX [IX_PdmInternalWorkOrders_WorkOrderNo]
    ON [dbo].[PdmInternalWorkOrders]([WorkOrderNo]);
CREATE INDEX [IX_PdmInternalWorkOrders_TenantId_CustomerId_State_CreatedAtUtc]
    ON [dbo].[PdmInternalWorkOrders]([TenantId],[CustomerId],[State],[CreatedAtUtc]);

CREATE TABLE [dbo].[PdmInternalWorkOrderNotifications](
    [Id] uniqueidentifier NOT NULL PRIMARY KEY,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [WorkOrderId] uniqueidentifier NOT NULL,
    [DeliveryKey] nvarchar(128) NOT NULL,
    [Channel] nvarchar(24) NOT NULL,
    [State] nvarchar(32) NOT NULL,
    [ClaimedBy] uniqueidentifier NULL,
    [ClaimedAtUtc] datetime2(7) NULL,
    [AcknowledgedAtUtc] datetime2(7) NULL,
    [ExternalMessageFingerprint] nvarchar(64) NOT NULL,
    [CreatedAtUtc] datetime2(7) NOT NULL,
    CONSTRAINT [FK_PdmInternalNotification_Order]
       FOREIGN KEY([WorkOrderId]) REFERENCES [dbo].[PdmInternalWorkOrders]([Id]),
    CONSTRAINT [CK_PdmInternalNotification_State] CHECK ([State] IN
       (N'Pending', N'Claimed', N'Confirmed', N'OutcomeUnknown'))
);
CREATE UNIQUE INDEX [IX_PdmInternalWorkOrderNotifications_DeliveryKey]
    ON [dbo].[PdmInternalWorkOrderNotifications]([DeliveryKey]);
CREATE UNIQUE INDEX [IX_PdmInternalWorkOrderNotifications_TenantId_CustomerId_WorkOrderId]
    ON [dbo].[PdmInternalWorkOrderNotifications]([TenantId],[CustomerId],[WorkOrderId]);
CREATE INDEX [IX_PdmInternalWorkOrderNotifications_State_CreatedAtUtc]
    ON [dbo].[PdmInternalWorkOrderNotifications]([State],[CreatedAtUtc]);

CREATE TABLE [dbo].[PdmInternalWorkOrderAudits](
    [Id] uniqueidentifier NOT NULL PRIMARY KEY,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [WorkOrderId] uniqueidentifier NOT NULL,
    [ActorId] uniqueidentifier NULL,
    [Action] nvarchar(48) NOT NULL,
    [FromState] nvarchar(24) NOT NULL,
    [ToState] nvarchar(24) NOT NULL,
    [Reason] nvarchar(512) NOT NULL,
    [AtUtc] datetime2(7) NOT NULL,
    CONSTRAINT [FK_PdmInternalAudit_Order]
      FOREIGN KEY([WorkOrderId]) REFERENCES [dbo].[PdmInternalWorkOrders]([Id])
);
CREATE INDEX [IX_PdmInternalWorkOrderAudits_TenantId_CustomerId_WorkOrderId_AtUtc]
    ON [dbo].[PdmInternalWorkOrderAudits]([TenantId],[CustomerId],[WorkOrderId],[AtUtc]);
COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
