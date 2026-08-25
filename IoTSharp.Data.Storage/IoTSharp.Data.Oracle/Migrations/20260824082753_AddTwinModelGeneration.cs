using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.Oracle.Migrations
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
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    JobKey = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    Name = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    Provider = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    Prompt = table.Column<string>(type: "NCLOB", maxLength: 8000, nullable: false),
                    QualityProfile = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    AnimationReady = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    LicenseType = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    CommercialUseAllowed = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    ReferenceImagePath = table.Column<string>(type: "NVARCHAR2(1024)", maxLength: 1024, nullable: false),
                    ReferenceImageName = table.Column<string>(type: "NVARCHAR2(512)", maxLength: 512, nullable: false),
                    ReferenceImageContentType = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    ReferenceImageSize = table.Column<long>(type: "NUMBER(19)", nullable: false),
                    Status = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    Progress = table.Column<int>(type: "NUMBER(10)", nullable: false),
                    Stage = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    ProviderJobId = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    ProviderMetadata = table.Column<string>(type: "NCLOB", nullable: true),
                    ErrorMessage = table.Column<string>(type: "NCLOB", maxLength: 4000, nullable: true),
                    AttemptCount = table.Column<int>(type: "NUMBER(10)", nullable: false),
                    ResultModelResourceId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinModelGenerationJobs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_Cu~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_Te~",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelGenerationJobs_Tw~",
                        column: x => x.ResultModelResourceId,
                        principalTable: "TwinModelResources",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_Cu~",
                table: "TwinModelGenerationJobs",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_Re~",
                table: "TwinModelGenerationJobs",
                column: "ResultModelResourceId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_T~1",
                table: "TwinModelGenerationJobs",
                columns: new[] { "TenantId", "CustomerId", "Status", "CreatedAt", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelGenerationJobs_Te~",
                table: "TwinModelGenerationJobs",
                columns: new[] { "TenantId", "CustomerId", "JobKey", "Deleted" },
                unique: true,
                filter: "\"TenantId\" IS NOT NULL AND \"CustomerId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TwinModelGenerationJobs");
        }
    }
}
