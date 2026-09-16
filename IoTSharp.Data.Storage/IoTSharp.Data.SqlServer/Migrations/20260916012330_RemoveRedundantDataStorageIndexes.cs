using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    public partial class RemoveRedundantDataStorageIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_DataStorage_Catalog",
                table: "DataStorage");

            migrationBuilder.DropIndex(
                name: "IX_DataStorage_Catalog_DeviceId",
                table: "DataStorage");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_DataStorage_Catalog",
                table: "DataStorage",
                column: "Catalog");

            migrationBuilder.CreateIndex(
                name: "IX_DataStorage_Catalog_DeviceId",
                table: "DataStorage",
                columns: new[] { "Catalog", "DeviceId" });
        }
    }
}
