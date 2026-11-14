-- IoTSharp DEVELOPMENT ONLY. This is an explicitly scoped statistics refresh.
-- Changes query optimizer statistics, never telemetry rows, schema, or indexes.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 2500;
IF DB_NAME() <> N'IOTSharp' OR CONVERT(nvarchar(128),SERVERPROPERTY('ServerName')) <> N'DESKTOP-2ALRK02\MSSQ'
    THROW 51001, 'Wrong SQL Server instance or database', 1;
IF OBJECT_ID(N'dbo.TelemetryData_202609',N'U') IS NULL
    THROW 51002, 'Required development telemetry shard is absent', 1;
-- Skip if this shard is already sufficiently fresh; do not run repeatedly.
-- The prior manual run on 2026-11-13 was performed before this idempotence guard.
IF EXISTS (SELECT 1 FROM sys.dm_exec_requests
           WHERE database_id=DB_ID() AND session_id<>@@SPID)
    THROW 51003, 'Other database requests detected; reschedule statistics maintenance', 1;
DECLARE @statRows bigint, @modifiedRows bigint;
SELECT @statRows=MAX(sp.rows), @modifiedRows=MAX(sp.modification_counter)
FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id,s.stats_id) sp
WHERE s.object_id=OBJECT_ID(N'dbo.TelemetryData_202609');
IF @statRows IS NULL OR @modifiedRows IS NULL
    THROW 51004, 'Cannot verify statistics freshness', 1;
IF @modifiedRows >= @statRows/10
BEGIN
    UPDATE STATISTICS dbo.TelemetryData_202609 WITH SAMPLE 1 PERCENT, MAXDOP = 2;
END
ELSE
    PRINT 'SKIPPED: current statistics are below 10-percent modification threshold';
SELECT s.name AS stats_name,sp.rows,sp.rows_sampled,sp.modification_counter,sp.last_updated
FROM sys.stats AS s CROSS APPLY sys.dm_db_stats_properties(s.object_id,s.stats_id) AS sp
WHERE s.object_id=OBJECT_ID(N'dbo.TelemetryData_202609') ORDER BY s.stats_id;
