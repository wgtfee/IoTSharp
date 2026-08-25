using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.Sqlite.Migrations
{
    /// <inheritdoc />
    public partial class AddTwinModelGeneration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TwinModelGenerationJobs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    JobKey = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false, collation: "NOCASE"),
                    Name = table.Column<string>(type: "TEXT", maxLength: 256, nullable: false, collation: "NOCASE"),
                    Provider = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false, collation: "NOCASE"),
                    Prompt = table.Column<string>(type: "TEXT", maxLength: 8000, nullable: false, collation: "NOCASE"),
                    QualityProfile = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false, collation: "NOCASE"),
                    AnimationReady = table.Column<bool>(type: "INTEGER", nullable: false),
                    LicenseType = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false, collation: "NOCASE"),
                    CommercialUseAllowed = table.Column<bool>(type: "INTEGER", nullable: false),
                    ReferenceImagePath = table.Column<string>(type: "TEXT", maxLength: 1024, nullable: false, collation: "NOCASE"),
                    ReferenceImageName = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false, collation: "NOCASE"),
                    ReferenceImageContentType = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false, collation: "NOCASE"),
                    ReferenceImageSize = table.Column<long>(type: "INTEGER", nullable: false),
                    Status = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Progress = table.Column<int>(type: "INTEGER", nullable: false),
                    Stage = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true, collation: "NOCASE"),
                    ProviderJobId = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true, collation: "NOCASE"),
                    ProviderMetadata = table.Column<string>(type: "TEXT", nullable: true, collation: "NOCASE"),
                    ErrorMessage = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: true, collation: "NOCASE"),
                    AttemptCount = table.Column<int>(type: "INTEGER", nullable: false),
                    ResultModelResourceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true, collation: "NOCASE"),
                    UpdatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true, collation: "NOCASE"),
                    Deleted = table.Column<bool>(type: "INTEGER", nullable: false),
                    TenantId = table.Column<Guid>(type: "TEXT", nullable: true),
                    CustomerId = table.Column<Guid>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinModelGenerationJobs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_TwinModelResources_ResultModelResourceId",
                        column: x => x.ResultModelResourceId,
                        principalTable: "TwinModelResources",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_CustomerId",
                table: "TwinModelGenerationJobs",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_ResultModelResourceId",
                table: "TwinModelGenerationJobs",
                column: "ResultModelResourceId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_TenantId_CustomerId_JobKey_Deleted",
                table: "TwinModelGenerationJobs",
                columns: new[] { "TenantId", "CustomerId", "JobKey", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_TenantId_CustomerId_Status_CreatedAt_Deleted",
                table: "TwinModelGenerationJobs",
                columns: new[] { "TenantId", "CustomerId", "Status", "CreatedAt", "Deleted" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TwinModelGenerationJobs");
        }
    }
}
