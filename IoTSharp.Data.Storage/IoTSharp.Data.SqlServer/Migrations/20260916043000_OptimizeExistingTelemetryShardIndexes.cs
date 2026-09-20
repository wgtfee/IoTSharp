using IoTSharp.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20260916043000_OptimizeExistingTelemetryShardIndexes")]
    public sealed class OptimizeExistingTelemetryShardIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DECLARE @table sysname;
                DECLARE shard_cursor CURSOR LOCAL FAST_FORWARD FOR
                    SELECT [name]
                    FROM sys.tables
                    WHERE schema_id = SCHEMA_ID(N'dbo')
                      AND [name] LIKE N'TelemetryData[_]%'
                      AND [name] <> N'TelemetryData';

                OPEN shard_cursor;
                FETCH NEXT FROM shard_cursor INTO @table;
                WHILE @@FETCH_STATUS = 0
                BEGIN
                    DECLARE @qualified nvarchar(520) = QUOTENAME(N'dbo') + N'.' + QUOTENAME(@table);
                    DECLARE @objectId int = OBJECT_ID(@qualified, N'U');
                    DECLARE @idxDevice sysname = N'IX_' + @table + N'_DeviceId';
                    DECLARE @idxDeviceKey sysname = N'IX_' + @table + N'_DeviceId_KeyName';
                    DECLARE @idxKey sysname = N'IX_' + @table + N'_KeyName';
                    DECLARE @idxDeviceTime sysname = N'IX_' + @table + N'_DeviceId_DateTime';
                    DECLARE @sql nvarchar(max) = N'';

                    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDevice)
                        SET @sql += N'DROP INDEX ' + QUOTENAME(@idxDevice) + N' ON ' + @qualified + N';';
                    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDeviceKey)
                        SET @sql += N'DROP INDEX ' + QUOTENAME(@idxDeviceKey) + N' ON ' + @qualified + N';';
                    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxKey)
                        SET @sql += N'DROP INDEX ' + QUOTENAME(@idxKey) + N' ON ' + @qualified + N';';
                    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDeviceTime)
                        SET @sql += N'CREATE INDEX ' + QUOTENAME(@idxDeviceTime) + N' ON ' + @qualified + N' ([DeviceId],[DateTime]);';

                    IF LEN(@sql) > 0
                        EXEC sys.sp_executesql @sql;

                    FETCH NEXT FROM shard_cursor INTO @table;
                END
                CLOSE shard_cursor;
                DEALLOCATE shard_cursor;
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DECLARE @table sysname;
                DECLARE shard_cursor CURSOR LOCAL FAST_FORWARD FOR
                    SELECT [name]
                    FROM sys.tables
                    WHERE schema_id = SCHEMA_ID(N'dbo')
                      AND [name] LIKE N'TelemetryData[_]%'
                      AND [name] <> N'TelemetryData';

                OPEN shard_cursor;
                FETCH NEXT FROM shard_cursor INTO @table;
                WHILE @@FETCH_STATUS = 0
                BEGIN
                    DECLARE @qualified nvarchar(520) = QUOTENAME(N'dbo') + N'.' + QUOTENAME(@table);
                    DECLARE @objectId int = OBJECT_ID(@qualified, N'U');
                    DECLARE @idxDevice sysname = N'IX_' + @table + N'_DeviceId';
                    DECLARE @idxDeviceKey sysname = N'IX_' + @table + N'_DeviceId_KeyName';
                    DECLARE @idxKey sysname = N'IX_' + @table + N'_KeyName';
                    DECLARE @idxDeviceTime sysname = N'IX_' + @table + N'_DeviceId_DateTime';
                    DECLARE @sql nvarchar(max) = N'';

                    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDeviceTime)
                        SET @sql += N'DROP INDEX ' + QUOTENAME(@idxDeviceTime) + N' ON ' + @qualified + N';';
                    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDevice)
                        SET @sql += N'CREATE INDEX ' + QUOTENAME(@idxDevice) + N' ON ' + @qualified + N' ([DeviceId]);';
                    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxDeviceKey)
                        SET @sql += N'CREATE INDEX ' + QUOTENAME(@idxDeviceKey) + N' ON ' + @qualified + N' ([DeviceId],[KeyName]);';
                    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = @objectId AND [name] = @idxKey)
                        SET @sql += N'CREATE INDEX ' + QUOTENAME(@idxKey) + N' ON ' + @qualified + N' ([KeyName]);';

                    IF LEN(@sql) > 0
                        EXEC sys.sp_executesql @sql;

                    FETCH NEXT FROM shard_cursor INTO @table;
                END
                CLOSE shard_cursor;
                DEALLOCATE shard_cursor;
                """);
        }
    }
}
