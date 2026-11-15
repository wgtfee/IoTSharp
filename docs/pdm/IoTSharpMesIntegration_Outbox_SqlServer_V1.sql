-- IoTSharp PdM INDEPENDENT metadata SQL Server database ONLY.
-- Do not run on main IOTSharp, telemetry, MES or production without DBA review.
SET XACT_ABORT ON;
IF OBJECT_ID('dbo.PdmIntegrationOutbox','U') IS NULL
CREATE TABLE dbo.PdmIntegrationOutbox(
 EventId uniqueidentifier NOT NULL PRIMARY KEY,
 TenantId uniqueidentifier NOT NULL,
 CustomerId uniqueidentifier NOT NULL,
 SourceEventKey nvarchar(128) NOT NULL,
 SourceSequence bigint NOT NULL,
 EventType nvarchar(40) NOT NULL,
 PayloadJson nvarchar(max) NOT NULL,
 DeliveryStatus nvarchar(32) NOT NULL,
 AttemptCount int NOT NULL DEFAULT 0,
 NextAttemptAtUtc datetime2(7) NOT NULL,
 CreatedAtUtc datetime2(7) NOT NULL,
 DeliveredAtUtc datetime2(7) NULL,
 LastErrorCode nvarchar(80) NULL,
 CONSTRAINT UQ_PdmIntegrationOutbox_EpisodeSeq UNIQUE(TenantId,CustomerId,SourceEventKey,SourceSequence)
);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE name='IX_PdmIntegrationOutbox_DeliveryStatus_NextAttemptAtUtc' AND object_id=OBJECT_ID('dbo.PdmIntegrationOutbox'))
CREATE INDEX IX_PdmIntegrationOutbox_DeliveryStatus_NextAttemptAtUtc
ON dbo.PdmIntegrationOutbox(DeliveryStatus,NextAttemptAtUtc);
