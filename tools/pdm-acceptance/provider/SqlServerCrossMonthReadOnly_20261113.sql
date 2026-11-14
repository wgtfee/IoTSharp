-- Read-only physical cross-month check. Not a ShardingCore runtime routing verdict.
SET NOCOUNT ON; SET LOCK_TIMEOUT 1200;
IF DB_NAME() <> N'IOTSharp' OR CONVERT(nvarchar(128),SERVERPROPERTY('ServerName'))<> N'DESKTOP-2ALRK02\MSSQ'
  THROW 51011,'Wrong development server/database',1;
IF OBJECT_ID('dbo.TelemetryData_202608','U') IS NULL OR OBJECT_ID('dbo.TelemetryData_202609','U') IS NULL
  THROW 51012,'Monthly shards not available',1;
DECLARE @lower datetime2(7)='2026-08-31T23:59:30',
        @upper datetime2(7)='2026-09-01T00:00:30';
-- Indexed sample and point; every branch seeks on DeviceId,KeyName and UTC time.
DECLARE @dev uniqueidentifier,@point nvarchar(900);
SELECT TOP (1) @dev=DeviceId,@point=KeyName
FROM dbo.TelemetryData_202609 WITH(INDEX(PK_TelemetryData_202609));
IF @dev IS NULL THROW 51013,'No sample device and point found',1;
SET STATISTICS IO ON;
-- A per-shard TOP(17) is NOT a global budget by itself; the outer TOP
-- guarantees at most 17 rows are materialized after the UNION ALL.
SELECT COUNT(*) AS rows_across_physical_tables
FROM (
    SELECT TOP (17) physical.DateTime
    FROM (
        SELECT august.DateTime FROM (
            SELECT TOP (17) DateTime FROM dbo.TelemetryData_202608
            WHERE DeviceId=@dev AND KeyName=@point AND DateTime>=@lower AND DateTime<@upper ORDER BY DateTime
        ) AS august
        UNION ALL
        SELECT september.DateTime FROM (
            SELECT TOP (17) DateTime FROM dbo.TelemetryData_202609
            WHERE DeviceId=@dev AND KeyName=@point AND DateTime>=@lower AND DateTime<@upper ORDER BY DateTime
        ) AS september
    ) AS physical
    ORDER BY physical.DateTime
) AS bounded;
SET STATISTICS IO OFF;

