-- PdM P0 SQL Server read-only template. NOT EXECUTED.
-- Use ONLY a confirmed DEV/TEST DB and a restricted read-only login.
-- Do not paste credentials in this file. Fill IDs and dates before use.
SET NOCOUNT ON;
SET LOCK_TIMEOUT 3000;
DECLARE @TenantId UNIQUEIDENTIFIER='00000000-0000-0000-0000-000000000000';
DECLARE @CustomerId UNIQUEIDENTIFIER='00000000-0000-0000-0000-000000000000';
DECLARE @DeviceId UNIQUEIDENTIFIER='00000000-0000-0000-0000-000000000000';
DECLARE @FromUtc DATETIME2(7)='2026-11-11T00:00:00';
DECLARE @ToUtc DATETIME2(7)='2026-11-12T00:00:00';
IF @TenantId='00000000-0000-0000-0000-000000000000'
 OR @CustomerId='00000000-0000-0000-0000-000000000000'
 OR @DeviceId='00000000-0000-0000-0000-000000000000'
 THROW 51000,'Required approved IDs are missing.',1;
IF @FromUtc >= @ToUtc THROW 51001,'Invalid UTC interval.',1;

SELECT TOP (50) s.name AS SchemaName,t.name AS TableName
FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
WHERE t.name IN ('Device','Product','Asset','Assets','CollectionPointTemplate','TelemetryData','TelemetryLatest')
ORDER BY s.name,t.name;

IF OBJECT_ID('dbo.Device','U') IS NOT NULL
BEGIN
 SELECT TOP (1) Id,Name,TenantId,CustomerId FROM dbo.Device
 WHERE Id=@DeviceId AND TenantId=@TenantId AND CustomerId=@CustomerId;
END;
-- This query applies ONLY to single-table history, not SQL shards or InfluxDB.
IF OBJECT_ID('dbo.TelemetryData','U') IS NOT NULL
BEGIN
 SELECT TOP (200) KeyName,DateTime,Type FROM dbo.TelemetryData
 WHERE DeviceId=@DeviceId AND DateTime>=@FromUtc AND DateTime<@ToUtc
 ORDER BY DateTime DESC;
END;

