using IoTSharp.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20260916044500_RemoveTelemetryKeyNameIndex")]
    public sealed class RemoveTelemetryKeyNameIndex : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TelemetryData_KeyName' AND object_id = OBJECT_ID(N'[dbo].[TelemetryData]'))
    DROP INDEX [IX_TelemetryData_KeyName] ON [dbo].[TelemetryData];");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TelemetryData_KeyName' AND object_id = OBJECT_ID(N'[dbo].[TelemetryData]'))
    CREATE INDEX [IX_TelemetryData_KeyName] ON [dbo].[TelemetryData] ([KeyName]);");
        }
    }
}
