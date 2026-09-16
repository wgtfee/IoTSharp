using IoTSharp.Data;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    public partial class OptimizeTelemetryHistoryIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TelemetryData_DeviceId",
                table: "TelemetryData");

            migrationBuilder.DropIndex(
                name: "IX_TelemetryData_DeviceId_KeyName",
                table: "TelemetryData");

            migrationBuilder.CreateIndex(
                name: "IX_TelemetryData_DeviceId_DateTime",
                table: "TelemetryData",
                columns: new[] { "DeviceId", "DateTime" });
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TelemetryData_DeviceId_DateTime",
                table: "TelemetryData");

            migrationBuilder.CreateIndex(
                name: "IX_TelemetryData_DeviceId",
                table: "TelemetryData",
                column: "DeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_TelemetryData_DeviceId_KeyName",
                table: "TelemetryData",
                columns: new[] { "DeviceId", "KeyName" });
        }
    }
}
