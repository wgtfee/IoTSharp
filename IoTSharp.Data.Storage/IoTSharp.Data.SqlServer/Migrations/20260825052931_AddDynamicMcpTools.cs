using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    /// <inheritdoc />
    public partial class AddDynamicMcpTools : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "McpToolDefinitions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AISettingsId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Title = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Description = table.Column<string>(type: "nvarchar(2048)", maxLength: 2048, nullable: false),
                    HandlerType = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    InputSchemaJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    HttpMethod = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    EndpointTemplate = table.Column<string>(type: "nvarchar(2048)", maxLength: 2048, nullable: false),
                    ProtectedHeaders = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    TimeoutSeconds = table.Column<int>(type: "int", nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    ReadOnlyHint = table.Column<bool>(type: "bit", nullable: false),
                    AllowPrivateNetwork = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_McpToolDefinitions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_McpToolDefinitions_AISettings_AISettingsId",
                        column: x => x.AISettingsId,
                        principalTable: "AISettings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "McpToolInvocationLogs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ToolDefinitionId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AISettingsId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ToolName = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    InvocationSource = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ArgumentKeys = table.Column<string>(type: "nvarchar(2048)", maxLength: 2048, nullable: true),
                    StartedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    DurationMs = table.Column<long>(type: "bigint", nullable: false),
                    Succeeded = table.Column<bool>(type: "bit", nullable: false),
                    StatusCode = table.Column<int>(type: "int", nullable: true),
                    ResponseSize = table.Column<long>(type: "bigint", nullable: false),
                    ErrorMessage = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_McpToolInvocationLogs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_McpToolInvocationLogs_McpToolDefinitions_ToolDefinitionId",
                        column: x => x.ToolDefinitionId,
                        principalTable: "McpToolDefinitions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_McpToolDefinitions_AISettingsId_Enabled_Deleted",
                table: "McpToolDefinitions",
                columns: new[] { "AISettingsId", "Enabled", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_McpToolDefinitions_AISettingsId_Name_Deleted",
                table: "McpToolDefinitions",
                columns: new[] { "AISettingsId", "Name", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_McpToolInvocationLogs_AISettingsId_StartedAt",
                table: "McpToolInvocationLogs",
                columns: new[] { "AISettingsId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_McpToolInvocationLogs_ToolDefinitionId_StartedAt",
                table: "McpToolInvocationLogs",
                columns: new[] { "ToolDefinitionId", "StartedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "McpToolInvocationLogs");

            migrationBuilder.DropTable(
                name: "McpToolDefinitions");
        }
    }
}
