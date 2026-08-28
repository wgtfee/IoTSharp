using IoTSharp.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20260828090000_AddTwinVersionSourceRevision")]
    public partial class AddTwinVersionSourceRevision : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "SourceRevision",
                table: "DigitalTwinSceneVersions",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.Sql("UPDATE [DigitalTwinSceneVersions] SET [SourceRevision] = [Version] WHERE [SourceRevision] = 0");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SourceRevision",
                table: "DigitalTwinSceneVersions");
        }
    }
}
