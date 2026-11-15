-- IoTSharp dedicated SQL Server work-order database ONLY.
-- Review target connection and back up first. Idempotent, non-destructive.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID('dbo.PdmInternalWorkOrders','U') IS NULL
    THROW 51010, 'Base IoTSharp work-order schema is missing; apply existing work-order migration first', 1;
IF COL_LENGTH('dbo.PdmInternalWorkOrders','RiskSourceEventKey') IS NULL
    ALTER TABLE dbo.PdmInternalWorkOrders
    ADD RiskSourceEventKey nvarchar(128) NOT NULL
        CONSTRAINT DF_PdmWO_RiskSourceEventKey DEFAULT N'' WITH VALUES;
-- Backfill older orders only when this dedicated PdM database also contains
-- the verified risk-episode table. Never guess a relationship by device/time.
IF OBJECT_ID('dbo.PdmRiskEvent','U') IS NOT NULL
    EXEC sys.sp_executesql N'
        UPDATE w SET RiskSourceEventKey=r.EventKey
        FROM dbo.PdmInternalWorkOrders w
        INNER JOIN dbo.PdmRiskEvent r ON
            r.Id=w.RiskEventId AND r.TenantId=w.TenantId
            AND r.CustomerId=w.CustomerId AND r.DeviceId=w.DeviceId
        WHERE w.RiskSourceEventKey=N'''' AND LEN(r.EventKey) BETWEEN 1 AND 128;';
IF OBJECT_ID('dbo.PdmWorkOrderMesOutbox','U') IS NULL
BEGIN
    CREATE TABLE dbo.PdmWorkOrderMesOutbox
    (
        EventId uniqueidentifier NOT NULL
            CONSTRAINT PK_PdmWorkOrderMesOutbox PRIMARY KEY,
        WorkOrderId uniqueidentifier NOT NULL,
        TenantId uniqueidentifier NOT NULL,
        CustomerId uniqueidentifier NOT NULL,
        EventType nvarchar(40) NOT NULL,
        SourceSequence int NOT NULL,
        PayloadJson nvarchar(max) NOT NULL,
        DeliveryStatus nvarchar(32) NOT NULL DEFAULT 'Pending',
        AttemptCount int NOT NULL DEFAULT 0,
        NextAttemptAtUtc datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        CreatedAtUtc datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        DeliveredAtUtc datetime2(3) NULL,
        LastErrorCode nvarchar(80) NULL,
        CONSTRAINT UQ_PdmWorkOrderMes_Seq UNIQUE(TenantId,CustomerId,WorkOrderId,SourceSequence),
        CONSTRAINT CK_PdmWorkOrderMes_Seq CHECK
            ((EventType='WORKORDER_COMPLETED' AND SourceSequence=1)
              OR (EventType='WORKORDER_CLOSED' AND SourceSequence=2))
    );
END;
IF NOT EXISTS(SELECT 1 FROM sys.indexes
 WHERE object_id=OBJECT_ID('dbo.PdmWorkOrderMesOutbox') AND name='IX_PdmWorkOrderMes_Pending')
CREATE INDEX IX_PdmWorkOrderMes_Pending
ON dbo.PdmWorkOrderMesOutbox(DeliveryStatus,NextAttemptAtUtc,CreatedAtUtc);
COMMIT TRANSACTION;
