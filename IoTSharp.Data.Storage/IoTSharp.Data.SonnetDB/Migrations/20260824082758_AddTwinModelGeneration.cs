using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SonnetDB.Migrations
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
                    Id = table.Column<Guid>(type: "STRING", nullable: false),
                    JobKey = table.Column<string>(type: "STRING", maxLength: 128, nullable: false),
                    Name = table.Column<string>(type: "STRING", maxLength: 256, nullable: false),
                    Provider = table.Column<string>(type: "STRING", maxLength: 128, nullable: false),
                    Prompt = table.Column<string>(type: "STRING", maxLength: 8000, nullable: false),
                    QualityProfile = table.Column<string>(type: "STRING", maxLength: 64, nullable: false),
                    AnimationReady = table.Column<bool>(type: "BOOL", nullable: false),
                    LicenseType = table.Column<string>(type: "STRING", maxLength: 128, nullable: false),
                    CommercialUseAllowed = table.Column<bool>(type: "BOOL", nullable: false),
                    ReferenceImagePath = table.Column<string>(type: "STRING", maxLength: 1024, nullable: false),
                    ReferenceImageName = table.Column<string>(type: "STRING", maxLength: 512, nullable: false),
                    ReferenceImageContentType = table.Column<string>(type: "STRING", maxLength: 128, nullable: false),
                    ReferenceImageSize = table.Column<long>(type: "INT", nullable: false),
                    Status = table.Column<string>(type: "STRING", maxLength: 64, nullable: false),
                    Progress = table.Column<int>(type: "INT", nullable: false),
                    Stage = table.Column<string>(type: "STRING", maxLength: 256, nullable: true),
                    ProviderJobId = table.Column<string>(type: "STRING", maxLength: 256, nullable: true),
                    ProviderMetadata = table.Column<string>(type: "STRING", nullable: true),
                    ErrorMessage = table.Column<string>(type: "STRING", maxLength: 4000, nullable: true),
                    AttemptCount = table.Column<int>(type: "INT", nullable: false),
                    ResultModelResourceId = table.Column<Guid>(type: "STRING", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "DATETIME", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "DATETIME", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "DATETIME", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "DATETIME", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "STRING", nullable: false),
                    CreatedBy = table.Column<string>(type: "STRING", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "STRING", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOL", nullable: false),
                    TenantId = table.Column<Guid>(type: "STRING", nullable: true),
                    CustomerId = table.Column<Guid>(type: "STRING", nullable: true)
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
