using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    public partial class RemoveRedundantDataStorageIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DataStorage_Catalog' AND object_id = OBJECT_ID(N'[dbo].[DataStorage]'))
    DROP INDEX [IX_DataStorage_Catalog] ON [dbo].[DataStorage];");

            migrationBuilder.Sql(@"
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DataStorage_Catalog_DeviceId' AND object_id = OBJECT_ID(N'[dbo].[DataStorage]'))
    DROP INDEX [IX_DataStorage_Catalog_DeviceId] ON [dbo].[DataStorage];");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DataStorage_Catalog' AND object_id = OBJECT_ID(N'[dbo].[DataStorage]'))
    CREATE INDEX [IX_DataStorage_Catalog] ON [dbo].[DataStorage] ([Catalog]);");

            migrationBuilder.Sql(@"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DataStorage_Catalog_DeviceId' AND object_id = OBJECT_ID(N'[dbo].[DataStorage]'))
    CREATE INDEX [IX_DataStorage_Catalog_DeviceId] ON [dbo].[DataStorage] ([Catalog], [DeviceId]);");
        }
    }
}
